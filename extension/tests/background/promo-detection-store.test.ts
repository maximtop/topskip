import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('@/background/messaging/broadcast-promo-detection-updated', () => ({
    PromoDetectionBroadcast: { notify },
}));

import { PromoDetectionStore } from '@/background/promo-detection-store';
import type { PromoDetectionStatePayload } from '@/shared/messages';

const TAB_ID = 42;
const VIDEO_ID = 'dQw4w9WgXcQ';
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';

describe('PromoDetectionStore Server sessions', () => {
    beforeEach(() => {
        PromoDetectionStore.clear(TAB_ID);
        vi.clearAllMocks();
    });

    it('never broadcasts a backward phase or a stale session', () => {
        const acquisitionA = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        const analysisA = {
            ...acquisitionA,
            serverAnalysisPhase: 'server_analysis',
        } as const;
        const terminalA = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server_cache',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;
        const acquisitionB = {
            ...acquisitionA,
            sessionId: SESSION_B,
        } as const;
        const analysisB = {
            ...analysisA,
            sessionId: SESSION_B,
        } as const;
        const terminalB = {
            ...terminalA,
            sessionId: SESSION_B,
        } satisfies PromoDetectionStatePayload;

        PromoDetectionStore.set(TAB_ID, acquisitionA);
        PromoDetectionStore.set(TAB_ID, analysisA);
        PromoDetectionStore.set(TAB_ID, acquisitionA);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(analysisA);

        PromoDetectionStore.set(TAB_ID, terminalA);
        PromoDetectionStore.set(TAB_ID, analysisA);
        PromoDetectionStore.set(TAB_ID, analysisB);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalA);

        PromoDetectionStore.set(TAB_ID, acquisitionB);
        PromoDetectionStore.set(TAB_ID, terminalA);
        PromoDetectionStore.set(TAB_ID, terminalB);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalB);
        expect(notify).toHaveBeenCalledTimes(5);
    });

    it('rejects malformed Server field combinations and clears only the matching session', () => {
        const acquisition = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_B,
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        PromoDetectionStore.set(TAB_ID, acquisition);

        const malformedStates = [
            {
                videoId: VIDEO_ID,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            },
            {
                videoId: VIDEO_ID,
                status: 'detected',
                source: 'server_cache',
                sessionId: SESSION_B,
                serverAnalysisPhase: 'server_analysis',
                promoBlocks: [{ startSec: 1, endSec: 2 }],
            },
            {
                videoId: VIDEO_ID,
                status: 'analyzing',
                source: 'local_provider',
                sessionId: SESSION_B,
            },
        ];
        const setMethod = Reflect.get(PromoDetectionStore, 'set');
        if (typeof setMethod !== 'function') {
            throw new Error('Expected detection store setter.');
        }
        for (const malformed of malformedStates) {
            Reflect.apply(setMethod, PromoDetectionStore, [TAB_ID, malformed]);
        }
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(acquisition);

        const clearMethod = Reflect.get(PromoDetectionStore, 'clear');
        if (typeof clearMethod !== 'function') {
            throw new Error('Expected detection store clear method.');
        }
        Reflect.apply(clearMethod, PromoDetectionStore, [TAB_ID, SESSION_A]);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(acquisition);
        Reflect.apply(clearMethod, PromoDetectionStore, [TAB_ID, SESSION_B]);
        expect(PromoDetectionStore.get(TAB_ID)).toBeNull();
    });
});
