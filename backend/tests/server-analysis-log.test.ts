import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';

describe('backend server analysis logging', () => {
    afterEach(() => {
        BackendServerAnalysisLog.disableForTests();
        vi.restoreAllMocks();
    });

    it('is quiet until the local CLI enables it', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        BackendServerAnalysisLog.info('http-received', { method: 'POST' });

        expect(info).not.toHaveBeenCalled();
    });

    it('prints stable events with caller-selected scalar fields', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();

        BackendServerAnalysisLog.info('job-started', {
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v4',
        });

        expect(info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'job-started',
            {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v4',
            },
        );
    });

    it('drops unknown and sensitive fields from a known event', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();

        BackendServerAnalysisLog.info('analysis-completed', {
            videoId: 'dQw4w9WgXcQ',
            status: 'ready',
            provider: 'openrouter',
            transcript: 'sensitive transcript',
            subtitleContents: 'sensitive subtitle',
            signedUrl: 'https://example.com/?signature=secret',
            stderr: 'raw process output',
            cookies: 'session=secret',
            apiKey: 'sk-secret',
            requestBody: 'raw request',
            responseBody: 'raw response',
            rawProviderError: 'raw provider error',
            unknownField: 'unknown value',
        });

        expect(info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'analysis-completed',
            {
                videoId: 'dQw4w9WgXcQ',
                status: 'ready',
                provider: 'openrouter',
            },
        );
    });

    it('drops nested values even when they use allowed field names', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();

        const warnMethod = Reflect.get(BackendServerAnalysisLog, 'warn');
        if (typeof warnMethod !== 'function') {
            throw new Error('Expected backend warning method.');
        }
        Reflect.apply(warnMethod, BackendServerAnalysisLog, [
            'extraction-unavailable',
            {
                videoId: { transcript: 'sensitive transcript' },
                jobId: ['sensitive subtitle'],
                code: 'captions_unavailable',
                attemptCount: 2,
            },
        ]);

        expect(warnSpy).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'extraction-unavailable',
            {
                code: 'captions_unavailable',
                attemptCount: 2,
            },
        );
    });

    it('does not log unknown events', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();

        const infoMethod = Reflect.get(BackendServerAnalysisLog, 'info');
        if (typeof infoMethod !== 'function') {
            throw new Error('Expected backend info method.');
        }
        Reflect.apply(infoMethod, BackendServerAnalysisLog, [
            'raw-provider-error: sk-secret',
            { videoId: 'dQw4w9WgXcQ' },
        ]);

        expect(info).not.toHaveBeenCalled();
    });

    it('drops raw paths, invalid video ids, and unbounded strings', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();

        BackendServerAnalysisLog.info('http-received', {
            requestId: 'request-safe',
            method: 'GET',
            route: '/v1/analysis/jobs/raw-secret-job',
        });
        BackendServerAnalysisLog.info('analysis-request-handled', {
            videoId: 'https://youtube.example/watch?v=secret',
            resultStatus: 'x'.repeat(161),
        });

        expect(info).toHaveBeenNthCalledWith(
            1,
            '[TopSkip server-analysis]',
            'http-received',
            { requestId: 'request-safe', method: 'GET' },
        );
        expect(info).toHaveBeenNthCalledWith(
            2,
            '[TopSkip server-analysis]',
            'analysis-request-handled',
            {},
        );
    });

    it('ignores accessors instead of evaluating caller-owned fields', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const readVideoId = vi.fn(() => 'sensitive transcript');
        const fields = { languageCode: 'en' };
        Object.defineProperty(fields, 'videoId', {
            enumerable: true,
            get: readVideoId,
        });
        BackendServerAnalysisLog.enable();

        BackendServerAnalysisLog.info('yt-dlp-parse-completed', fields);

        expect(readVideoId).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'yt-dlp-parse-completed',
            { languageCode: 'en' },
        );
    });
});
