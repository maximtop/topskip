import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));
const detectionMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
}));
const browserMocks = vi.hoisted(() => ({
    query: vi.fn(),
    create: vi.fn<(input: { url?: string }) => Promise<void>>(),
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
}));
const debugLogMocks = vi.hoisted(() => ({
    hasLog: vi.fn().mockResolvedValue(false),
    record: vi.fn(),
}));

vi.mock('@/background/debug-log/debug-log-store', () => ({
    DebugLogStore: { hasLog: debugLogMocks.hasLog },
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: debugLogMocks.record },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));
vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));
vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { getManifest: browserMocks.getManifest },
        tabs: {
            query: browserMocks.query,
            create: browserMocks.create,
        },
    },
}));

import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';

const { DEBUG_LOG_ISSUE_HINT_LINE, ServerAnalysisIssueReport } =
    await import('@/background/server-analysis-issue-report');

describe('ServerAnalysisIssueReport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'server',
        });
        browserMocks.query.mockResolvedValue([{ id: 42 }]);
        browserMocks.create.mockResolvedValue(undefined);
        detectionMocks.get.mockReturnValue({
            videoId: 'dQw4w9WgXcQ',
            status: 'error',
            source: 'server',
            sessionId: '00000000-0000-4000-8000-000000000001',
            serverFailure: {
                code: 'internal_error',
                supportId: 'support-safe-123',
                apiVersion: 1,
                algorithmVersion: 'server-v6',
                extensionVersion: '0.1.0',
                supportIssueBaseUrl:
                    'https://github.com/maximtop/topskip/issues/new?template=server.yml',
            },
        });
    });

    it('builds a GitHub URL containing only allow-listed diagnostics', () => {
        const url = ServerAnalysisIssueReport.buildUrl({
            baseUrl:
                'https://github.com/maximtop/topskip/issues/new?template=server.yml',
            failure: {
                code: 'internal_error',
                supportId: 'support-safe-123',
                apiVersion: 1,
                algorithmVersion: 'server-v6',
                extensionVersion: '0.1.0',
            },
            now: new Date('2026-07-15T12:34:56.000Z'),
            hasDebugLog: false,
        });

        expect(url).not.toBeNull();
        const parsed = new URL(url ?? 'https://example.invalid');
        expect(parsed.hostname).toBe('github.com');
        expect(parsed.searchParams.get('template')).toBeNull();
        expect(parsed.searchParams.get('title')).toContain('internal_error');
        const body = parsed.searchParams.get('body') ?? '';
        expect(body).toContain('support-safe-123');
        expect(body).toContain('server-v6');
        expect(body).toContain('2026-07-15T12:34:56.000Z');
        expect(body).not.toContain('dQw4w9WgXcQ');
        expect(body).not.toMatch(/transcript|token|cookie|stderr/iu);
    });

    it('strips every server-configured query parameter before prefill', () => {
        const url = ServerAnalysisIssueReport.buildUrl({
            baseUrl:
                'https://github.com/maximtop/topskip/issues/new?template=evil.yml&labels=secret&assignee=attacker&body=untrusted',
            failure: {
                code: 'internal_error',
                apiVersion: 1,
                extensionVersion: '0.1.0',
            },
            now: new Date('2026-07-15T12:34:56.000Z'),
            hasDebugLog: false,
        });

        const parsed = new URL(url ?? 'https://example.invalid');
        expect([...parsed.searchParams.keys()].sort()).toEqual([
            'body',
            'title',
        ]);
        expect(parsed.searchParams.get('body')).not.toContain('untrusted');
    });

    it.each([
        'http://github.com/maximtop/topskip/issues/new',
        'https://github.com.evil.example/maximtop/topskip/issues/new',
        'https://github.com/maximtop/topskip/issues',
        'https://user@github.com/maximtop/topskip/issues/new',
    ])('rejects unsafe issue base URL %s', (baseUrl) => {
        expect(
            ServerAnalysisIssueReport.buildUrl({
                baseUrl,
                failure: {
                    code: 'internal_error',
                    apiVersion: 1,
                    extensionVersion: '0.1.0',
                },
                now: new Date('2026-07-15T12:34:56.000Z'),
                hasDebugLog: false,
            }),
        ).toBeNull();
    });

    it('opens the safe issue from background-owned detection state', async () => {
        await expect(ServerAnalysisIssueReport.handleOpen()).resolves.toEqual({
            ok: true,
        });
        expect(browserMocks.create).toHaveBeenCalledOnce();
        const url = browserMocks.create.mock.calls[0]?.[0]?.url;
        expect(url).toContain('https://github.com/maximtop/topskip/issues/new');
        expect(url).not.toContain('dQw4w9WgXcQ');
    });

    it('does not open reports after switching to Private BYOK', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        await expect(ServerAnalysisIssueReport.handleOpen()).resolves.toEqual({
            ok: false,
            error: 'Server issue reporting is unavailable.',
        });
        expect(browserMocks.create).not.toHaveBeenCalled();
    });

    it('does not offer issue creation for capacity outcomes', async () => {
        detectionMocks.get.mockReturnValue({
            videoId: 'dQw4w9WgXcQ',
            status: 'unavailable',
            source: 'server',
            sessionId: '00000000-0000-4000-8000-000000000001',
            serverFailure: {
                code: 'rate_limited',
                retryAfterSec: 60,
                apiVersion: 1,
                extensionVersion: '0.1.0',
            },
        });

        await expect(ServerAnalysisIssueReport.handleOpen()).resolves.toEqual({
            ok: false,
            error: 'Server issue reporting is unavailable.',
        });
        expect(browserMocks.create).not.toHaveBeenCalled();
    });

    it('adds exactly one English hint line when a debug log exists', () => {
        const url = ServerAnalysisIssueReport.buildUrl({
            baseUrl: 'https://github.com/maximtop/topskip/issues/new',
            failure: { code: 'internal_error', apiVersion: 1, extensionVersion: '0.1.0' },
            now: new Date('2026-07-15T12:34:56.000Z'),
            hasDebugLog: true,
        });
        const body = new URL(url ?? 'https://example.invalid').searchParams.get('body') ?? '';
        const lines = body.split('\n');
        expect(lines.filter((line) => line === DEBUG_LOG_ISSUE_HINT_LINE)).toHaveLength(1);
        expect(lines.at(-1)).toBe(DEBUG_LOG_ISSUE_HINT_LINE);
        expect(DEBUG_LOG_ISSUE_HINT_LINE).toBe(
            'If you enabled Debug logging in Options → Diagnostics, you can attach the exported log (it lists the video IDs you watched while logging; review it first).',
        );
        expect(body).not.toContain('dQw4w9WgXcQ');

        const without = ServerAnalysisIssueReport.buildUrl({
            baseUrl: 'https://github.com/maximtop/topskip/issues/new',
            failure: { code: 'internal_error', apiVersion: 1, extensionVersion: '0.1.0' },
            now: new Date('2026-07-15T12:34:56.000Z'),
            hasDebugLog: false,
        });
        expect(new URL(without ?? 'https://example.invalid').searchParams.get('body')).not.toContain(
            'Debug logging',
        );
    });

    it('reads the stored-log flag and logs the opening with failure code and support id only', async () => {
        debugLogMocks.hasLog.mockResolvedValue(true);

        await expect(ServerAnalysisIssueReport.handleOpen()).resolves.toEqual({ ok: true });

        const url = browserMocks.create.mock.calls[0]?.[0]?.url ?? '';
        expect(new URL(url).searchParams.get('body')).toContain(DEBUG_LOG_ISSUE_HINT_LINE);
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.IssueReportOpened,
            { failureCode: 'internal_error' },
            { tab: 42, support: 'support-safe-123' },
        );
        expect(JSON.stringify(debugLogMocks.record.mock.calls)).not.toContain('github.com');
    });

    it('omits the hint and still logs the opening when no log exists', async () => {
        debugLogMocks.hasLog.mockResolvedValue(false);

        await ServerAnalysisIssueReport.handleOpen();

        const url = browserMocks.create.mock.calls[0]?.[0]?.url ?? '';
        expect(new URL(url).searchParams.get('body')).not.toContain('Debug logging');
        expect(debugLogMocks.record).toHaveBeenCalledTimes(1);
    });
});
