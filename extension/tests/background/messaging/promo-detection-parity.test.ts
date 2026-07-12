import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { PromoBlock } from '@/shared/promo-types';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

// ------------------------------------------------------------------
// Hoisted mocks
// ------------------------------------------------------------------

const { sendMessage, storageGet, storageSet, tabsQuery, tabsSendMessage } =
    vi.hoisted(() => ({
        sendMessage: vi.fn().mockResolvedValue(undefined),
        storageGet: vi.fn(),
        storageSet: vi.fn().mockResolvedValue(undefined),
        tabsQuery: vi.fn(),
        tabsSendMessage: vi.fn().mockResolvedValue(undefined),
    }));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { sendMessage },
        storage: { local: { get: storageGet, set: storageSet } },
        tabs: { query: tabsQuery, sendMessage: tabsSendMessage },
    },
}));

const { mockCallOpenRouter } = vi.hoisted(() => ({
    mockCallOpenRouter: vi.fn(),
}));

vi.mock('@/background/openrouter/openrouter-client', () => ({
    callOpenRouterChat: mockCallOpenRouter,
}));

const { mockParseLlm } = vi.hoisted(() => ({
    mockParseLlm: vi.fn(),
}));

vi.mock('@/background/openrouter/parse-llm-promo-response', () => ({
    parseLlmPromoResponse: mockParseLlm,
}));

vi.mock(
    '@/background/openrouter/log-promo-analysis',
    async (importOriginal) => {
        const mod =
            await importOriginal<
                typeof import('@/background/openrouter/log-promo-analysis')
            >();
        return {
            ...mod,
            buildPromoAnalysisLogBundle: vi.fn().mockReturnValue(''),
            LogPromoAnalysis: { logAnalysisBundle: vi.fn() },
        };
    },
);

// ------------------------------------------------------------------
// Imports under test (after mocks)
// ------------------------------------------------------------------

import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { PromoDetectionRuntimeMessages } from '@/background/messaging/misc-runtime-messages';
import {
    ANALYSIS_MODE,
    STORAGE_KEY_PREFS,
    STORAGE_KEY_OPENROUTER,
} from '@/shared/constants';

// ------------------------------------------------------------------
// FR-010: popup and content receive identical promoBlocks
// ------------------------------------------------------------------

describe(
    'FR-010: popup GET_DETECTION_STATUS and content' +
        ' PROMO_BLOCKS_DETECTED share identical blocks',
    () => {
        const TAB_ID = 42;
        const VIDEO_ID = 'abc123';

        // Within chunk time ± tolerance; parse returns two close blocks that
        // {@link mergePromoBlocksWithGap} merges into one.
        const parseBlocks: PromoBlock[] = [
            { startSec: 1, endSec: 3, confidence: 'high' },
            { startSec: 4, endSec: 5, confidence: 'medium' },
        ];
        const expectedBlocks: PromoBlock[] = [
            { startSec: 1, endSec: 5, confidence: 'high' },
        ];

        beforeEach(() => {
            vi.clearAllMocks();
            PromoDetectionStore.clear(TAB_ID);

            // Seed prefs: enabled
            storageGet.mockImplementation((key: string) => {
                if (key === STORAGE_KEY_PREFS) {
                    return Promise.resolve({
                        [STORAGE_KEY_PREFS]: {
                            enabled: true,
                            providerId: 'openrouter',
                            analysisMode: ANALYSIS_MODE.Byok,
                        },
                    });
                }
                if (key === STORAGE_KEY_OPENROUTER) {
                    return Promise.resolve({
                        [STORAGE_KEY_OPENROUTER]: {
                            apiKey: 'sk-test',
                            model: 'test/model',
                            customModels: ['test/model'],
                        },
                    });
                }
                return Promise.resolve({});
            });

            // LLM returns promo blocks
            mockCallOpenRouter.mockResolvedValue({
                ok: true,
                rawContent: '{"hasPromo":true}',
            });
            mockParseLlm.mockReturnValue({
                ok: true,
                hasPromo: true,
                blocks: parseBlocks,
            });
        });

        it('stores and sends the same blocks to both surfaces', async () => {
            // Trigger the analysis pipeline
            PromoAnalysis.onCaptionsReady({ tab: { id: TAB_ID } } as never, {
                ok: true,
                videoId: VIDEO_ID,
                languageCode: 'en',
                segments: [
                    {
                        startSec: 0,
                        durationSec: 5,
                        text: 'Hello world',
                    },
                ],
            });

            // Allow the async pipeline to settle
            await vi.waitFor(() => {
                const state = PromoDetectionStore.get(TAB_ID);
                expect(state).not.toBeNull();
                expect(state!.status).toBe('detected');
            });

            // 1. PromoDetectionStore has the blocks (single source of truth ref)
            const storeState = PromoDetectionStore.get(TAB_ID);
            const storedBlocks = storeState!.promoBlocks!;
            expect(storeState).toEqual({
                videoId: VIDEO_ID,
                status: 'detected',
                promoBlocks: expectedBlocks,
                partialCoverage: false,
                source: 'local_provider',
            });

            // 2. Content script received the same blocks via
            //    browser.tabs.sendMessage
            expect(tabsSendMessage).toHaveBeenCalledWith(TAB_ID, {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                videoId: VIDEO_ID,
                promoBlocks: storedBlocks,
                partialCoverage: false,
            });

            // 3. Popup's GET_DETECTION_STATUS returns the same
            //    blocks from PromoDetectionStore
            tabsQuery.mockResolvedValue([{ id: TAB_ID }]);
            const response = await PromoDetectionRuntimeMessages.handleGet();

            expect(response).toEqual({
                ok: true,
                state: {
                    videoId: VIDEO_ID,
                    status: 'detected',
                    promoBlocks: expectedBlocks,
                    partialCoverage: false,
                    source: 'local_provider',
                },
            });

            // 4. Referential identity: content message uses the store's array
            const sentMsg = tabsSendMessage.mock.calls[0][1] as {
                promoBlocks: PromoBlock[];
            };
            expect(sentMsg.promoBlocks).toBe(storedBlocks);
        });
    },
);
