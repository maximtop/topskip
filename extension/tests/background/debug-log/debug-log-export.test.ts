import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn(() => ({ version: '0.1.0', version_name: '0.1.0 (dev build 1)' })),
    getPlatformInfo: vi.fn(),
    getUILanguage: vi.fn(() => 'en-US'),
}));

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest: browserMocks.getManifest,
            getPlatformInfo: browserMocks.getPlatformInfo,
        },
        i18n: { getUILanguage: browserMocks.getUILanguage },
    },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

import {
    DEBUG_LOG_BUNDLE_EVENTS_MARKER,
    DEBUG_LOG_BUNDLE_NOTICE,
    DebugLogExport,
    EnvironmentProbe,
    type DebugLogEnvironment,
} from '@/background/debug-log/debug-log-export';
import type { DebugLogSnapshot } from '@/background/debug-log/debug-log-store';
import { ANALYSIS_MODE } from '@/shared/constants';
import { DEBUG_LOG_CAP_BYTES } from '@/shared/debug-log-constants';
import { DEFAULT_DETECTION_MODEL_ID, buildOpenRouterModelId } from '@/shared/detection-models';
import { PROVIDER_ID } from '@/shared/providers';

const FULL_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const EXPORTED_AT_MS = Date.UTC(2026, 7, 22, 13, 5, 9, 123);
const ENABLED_AT_MS = EXPORTED_AT_MS - 60_000;
/**
 * SC-007: neither the probe nor the bundle builder touches the network.
 */
const fetchSpy = vi.fn();

const ENV: DebugLogEnvironment = {
    extensionBuild: '0.1.0 (dev build 1)',
    browserMajor: 140,
    osFamily: 'mac',
    locale: 'en-US',
    analysisMode: ANALYSIS_MODE.Server,
    providerId: PROVIDER_ID.OpenRouter,
    modelId: DEFAULT_DETECTION_MODEL_ID,
};

/**
 * Snapshot with two lines and non-zero counters.
 */
function snapshot(overrides: Partial<DebugLogSnapshot['status']> = {}): DebugLogSnapshot {
    return {
        lines: ['line-one', 'line-two'],
        status: {
            enabled: true,
            hasLog: true,
            enabledAtMs: ENABLED_AT_MS,
            disabledAtMs: null,
            eventCount: 2,
            sizeBytes: 20,
            capBytes: DEBUG_LOG_CAP_BYTES,
            evictedCount: 7,
            oldestRetainedMs: ENABLED_AT_MS,
            dropped: { incognito: 3, coalesced: 4, ceiling: 5, unreachable: 6, lost: 1 },
            revision: 9,
            ...overrides,
        },
    };
}

describe('EnvironmentProbe.collect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        browserMocks.getPlatformInfo.mockResolvedValue({ os: 'mac', arch: 'arm' });
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: PROVIDER_ID.OpenRouter,
            activeModelId: DEFAULT_DETECTION_MODEL_ID,
            analysisMode: ANALYSIS_MODE.Byok,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('prefers structured user-agent data and keeps preset model ids verbatim', async () => {
        vi.stubGlobal('navigator', {
            userAgent: FULL_UA,
            userAgentData: {
                brands: [
                    { brand: 'Not;A=Brand', version: '99' },
                    { brand: 'Chromium', version: '140' },
                    { brand: 'Google Chrome', version: '140' },
                ],
                platform: 'macOS',
            },
        });

        await expect(EnvironmentProbe.collect()).resolves.toEqual({
            extensionBuild: '0.1.0 (dev build 1)',
            browserMajor: 140,
            osFamily: 'mac',
            locale: 'en-US',
            analysisMode: ANALYSIS_MODE.Byok,
            providerId: PROVIDER_ID.OpenRouter,
            modelId: DEFAULT_DETECTION_MODEL_ID,
        });
    });

    it('falls back to the UA major, never the full string, and maps custom models', async () => {
        vi.stubGlobal('navigator', { userAgent: FULL_UA });
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: PROVIDER_ID.OpenRouter,
            activeModelId: buildOpenRouterModelId('acme-corp/internal'),
            analysisMode: ANALYSIS_MODE.Byok,
        });

        const env = await EnvironmentProbe.collect();

        expect(env.browserMajor).toBe(139);
        expect(env.modelId).toBe('custom');
        expect(JSON.stringify(env)).not.toContain('Mozilla');
        expect(JSON.stringify(env)).not.toContain('AppleWebKit');
    });

    it('degrades every unreadable fact to unknown/null without throwing', async () => {
        vi.stubGlobal('navigator', undefined);
        browserMocks.getPlatformInfo.mockRejectedValue(new Error('no platform'));
        browserMocks.getUILanguage.mockImplementationOnce(() => {
            throw new Error('no i18n');
        });
        prefsMocks.load.mockRejectedValue(new Error('storage'));

        await expect(EnvironmentProbe.collect()).resolves.toEqual({
            extensionBuild: '0.1.0 (dev build 1)',
            browserMajor: null,
            osFamily: 'unknown',
            locale: 'unknown',
            analysisMode: 'unknown',
            providerId: 'unknown',
            modelId: 'unknown',
        });
    });

    it('rejects a malformed UI language instead of logging it', async () => {
        vi.stubGlobal('navigator', undefined);
        browserMocks.getUILanguage.mockReturnValue('en US; token=abc');
        await expect(EnvironmentProbe.collect()).resolves.toMatchObject({ locale: 'unknown' });
    });
});

describe('DebugLogExport.buildBundle', () => {
    beforeEach(() => {
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('writes the header exactly, then one event per line', () => {
        const text = DebugLogExport.buildBundle(snapshot(), ENV, EXPORTED_AT_MS);
        const lines = text.split('\n');

        expect(text.endsWith('\n')).toBe(true);
        expect(lines.slice(0, 8)).toEqual([
            'TopSkip debug log',
            'exportedAt=2026-08-22T13:05:09.123Z extension="0.1.0 (dev build 1)" browser=140 os=mac locale=en-US',
            'analysisMode=server',
            `loggingEnabled=true enabledSince=${new Date(ENABLED_AT_MS).toISOString()} disabledAt=none`,
            `capBytes=${DEBUG_LOG_CAP_BYTES} sizeBytes=20 events=2 evicted=7 oldestRetained=${new Date(ENABLED_AT_MS).toISOString()}`,
            'droppedCoalesced=4 droppedCeiling=5 droppedUnreachable=6 droppedOther=4',
            DEBUG_LOG_BUNDLE_NOTICE,
            DEBUG_LOG_BUNDLE_EVENTS_MARKER,
        ]);
        expect(lines.slice(8, 10)).toEqual(['line-one', 'line-two']);
        expect(text).not.toContain('droppedIncognito');
        expect(text).not.toContain('droppedLost');
    });

    it('names provider and model only for Private BYOK', () => {
        const byok = DebugLogExport.buildBundle(
            snapshot(),
            { ...ENV, analysisMode: ANALYSIS_MODE.Byok },
            EXPORTED_AT_MS,
        );
        expect(byok).toContain(
            `analysisMode=byok provider=${PROVIDER_ID.OpenRouter} model=${DEFAULT_DETECTION_MODEL_ID}`,
        );
        const server = DebugLogExport.buildBundle(snapshot(), ENV, EXPORTED_AT_MS);
        expect(server).not.toContain('provider=');
        expect(server).not.toContain('model=');
    });

    it('keeps the count/line invariant and writes none for absent timestamps', () => {
        const text = DebugLogExport.buildBundle(
            {
                lines: [],
                status: snapshot({
                    enabled: false,
                    enabledAtMs: null,
                    oldestRetainedMs: null,
                    disabledAtMs: ENABLED_AT_MS,
                    eventCount: 0,
                }).status,
            },
            { ...ENV, browserMajor: null },
            EXPORTED_AT_MS,
        );
        expect(text).toContain('events=0');
        expect(text).toContain('enabledSince=none');
        expect(text).toContain(`disabledAt=${new Date(ENABLED_AT_MS).toISOString()}`);
        expect(text).toContain('oldestRetained=none');
        expect(text).toContain('browser=unknown');
        expect(text.endsWith(`${DEBUG_LOG_BUNDLE_EVENTS_MARKER}\n`)).toBe(true);
    });

    it('never embeds a full user-agent string even when the probe saw one', async () => {
        vi.stubGlobal('navigator', { userAgent: FULL_UA });
        browserMocks.getPlatformInfo.mockResolvedValue({ os: 'mac', arch: 'arm' });
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: PROVIDER_ID.OpenRouter,
            activeModelId: DEFAULT_DETECTION_MODEL_ID,
            analysisMode: ANALYSIS_MODE.Server,
        });
        const env = await EnvironmentProbe.collect();
        const text = DebugLogExport.buildBundle(snapshot(), env, EXPORTED_AT_MS);
        expect(text).not.toContain('Mozilla/');
        expect(text).not.toContain('Safari/');
        expect(text).toContain('browser=139');
    });
});
