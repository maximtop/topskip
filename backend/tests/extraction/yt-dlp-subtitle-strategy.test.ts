import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    YtDlpSubtitleStrategy,
    selectYtDlpSubtitleTrack,
} from '@topskip/backend/extraction/yt-dlp-subtitle-strategy';
import type {
    YtDlpRunRequest,
    YtDlpRunResult,
    YtDlpRunner,
} from '@topskip/backend/extraction/yt-dlp-process';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';

const VIDEO_ID = 'dQw4w9WgXcQ';
const NOW_MS = 1_900_000_000_000;

describe('yt-dlp subtitle track selection', () => {
    it('prefers manual captions in the original language', () => {
        expect(
            selectYtDlpSubtitleTrack({
                language: 'uk',
                subtitles: { en: [{}], uk: [{}] },
                automatic_captions: { uk: [{}] },
            }),
        ).toEqual({ kind: 'manual', languageCode: 'uk' });
    });

    it('falls back through original automatic, English, and deterministic first tracks', () => {
        expect(
            selectYtDlpSubtitleTrack({
                language: 'uk',
                subtitles: { en: [{}] },
                automatic_captions: { uk: [{}] },
            }),
        ).toEqual({ kind: 'automatic', languageCode: 'uk' });

        expect(
            selectYtDlpSubtitleTrack({
                language: 'pl',
                subtitles: { en: [{}] },
                automatic_captions: { de: [{}] },
            }),
        ).toEqual({ kind: 'manual', languageCode: 'en' });

        expect(
            selectYtDlpSubtitleTrack({
                language: null,
                subtitles: { zh: [{}], ar: [{}] },
                automatic_captions: {},
            }),
        ).toEqual({ kind: 'manual', languageCode: 'ar' });
    });

    it('rejects malformed metadata and empty track maps', () => {
        expect(selectYtDlpSubtitleTrack('{bad json')).toBeNull();
        expect(
            selectYtDlpSubtitleTrack({
                subtitles: {},
                automatic_captions: {},
            }),
        ).toBeNull();
    });
});

describe('yt-dlp subtitle extraction strategy', () => {
    it('rejects metadata above five hours before downloading subtitles', async () => {
        const runner = vi.fn<YtDlpRunner>(() =>
            Promise.resolve(
                succeeded(
                    JSON.stringify({
                        duration: 18_000.001,
                        language: 'en',
                        subtitles: { en: [{}] },
                    }),
                ),
            ),
        );

        const result = await YtDlpSubtitleStrategy.create(runner).extract({
            videoId: VIDEO_ID,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(result).toMatchObject({
            status: 'failed',
            diagnostics: { code: 'video_too_long' },
        });
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            label: 'missing duration',
            metadata: {
                language: 'en',
                subtitles: { en: [{}] },
            },
        },
        {
            label: 'active live stream',
            metadata: {
                duration: 120,
                is_live: true,
                live_status: 'is_live',
                language: 'en',
                subtitles: { en: [{}] },
            },
        },
        {
            label: 'non-VOD live status',
            metadata: {
                duration: 120,
                live_status: 'was_live',
                language: 'en',
                subtitles: { en: [{}] },
            },
        },
    ])('rejects $label before downloading subtitles', async ({ metadata }) => {
        const runner = vi.fn<YtDlpRunner>(() =>
            Promise.resolve(succeeded(JSON.stringify(metadata))),
        );

        const result = await YtDlpSubtitleStrategy.create(runner).extract({
            videoId: VIDEO_ID,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(result).toMatchObject({
            status: 'failed',
            diagnostics: { code: 'video_unavailable' },
        });
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('downloads only the selected json3 track and removes its temp directory', async () => {
        let subtitleDirectory: string | null = null;
        const requests: YtDlpRunRequest[] = [];
        const runner: YtDlpRunner = async (request) => {
            requests.push(request);
            if (request.args.includes('--dump-single-json')) {
                return succeeded(
                    JSON.stringify({
                        duration: 18_000,
                        language: 'ru',
                        subtitles: { ru: [{}] },
                        automatic_captions: { en: [{}] },
                    }),
                );
            }

            const pathsIndex = request.args.indexOf('--paths');
            const pathsValue = request.args[pathsIndex + 1];
            if (pathsValue === undefined) {
                throw new Error('Missing subtitle path argument.');
            }
            subtitleDirectory = pathsValue.replace(/^subtitle:/u, '');
            await mkdir(subtitleDirectory, { recursive: true });
            await writeFile(
                path.join(subtitleDirectory, `${VIDEO_ID}.ru.json3`),
                JSON.stringify({
                    events: [
                        {
                            tStartMs: 1_000,
                            dDurationMs: 2_000,
                            segs: [{ utf8: 'Рекламная интеграция' }],
                        },
                    ],
                }),
            );
            return succeeded('');
        };

        const result = await YtDlpSubtitleStrategy.create(runner).extract({
            videoId: VIDEO_ID,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(result).toMatchObject({
            status: 'succeeded',
            artifact: {
                strategy: 'yt_dlp_subtitles',
                sourceType: 'youtube_yt_dlp',
                languageCode: 'ru',
                videoDurationSec: 18_000,
                transcriptText: 'Рекламная интеграция',
                segments: [
                    {
                        startSec: 1,
                        durationSec: 2,
                        text: 'Рекламная интеграция',
                    },
                ],
            },
        });
        expect(requests[0]?.args).toContain('--ignore-config');
        expect(requests[1]?.args).toContain('--write-subs');
        expect(requests[1]?.args).not.toContain('--write-auto-subs');
        expect(requests[1]?.args).toContain('^ru$');
        expect(requests[1]?.args).toContain(`home:${subtitleDirectory}`);
        expect(subtitleDirectory).not.toBeNull();
        if (subtitleDirectory !== null) {
            await expect(access(subtitleDirectory)).rejects.toThrow();
        }
    });

    it('maps safe metadata, timeout, download, and parse failures', async () => {
        const cases: Array<{
            runner: YtDlpRunner;
            code: string;
            status: 'failed' | 'timed_out';
        }> = [
            {
                runner: () => Promise.resolve(succeeded('{bad json')),
                code: 'metadata_invalid',
                status: 'failed',
            },
            {
                runner: () =>
                    Promise.resolve(
                        succeeded(
                            JSON.stringify({
                                duration: 120,
                                subtitles: {},
                                automatic_captions: {},
                            }),
                        ),
                    ),
                code: 'captions_unavailable',
                status: 'failed',
            },
            {
                runner: () =>
                    Promise.resolve({
                        status: 'timed_out',
                        code: 'timeout',
                    }),
                code: 'timeout',
                status: 'timed_out',
            },
            {
                runner: createDownloadFailureRunner(),
                code: 'download_failure',
                status: 'failed',
            },
            {
                runner: createInvalidTranscriptRunner(),
                code: 'parse_failure',
                status: 'failed',
            },
        ];

        for (const testCase of cases) {
            const result = await YtDlpSubtitleStrategy.create(
                testCase.runner,
            ).extract({
                videoId: VIDEO_ID,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            });
            expect(result).toMatchObject({
                status: testCase.status,
                diagnostics: { code: testCase.code },
            });
            expect(JSON.stringify(result)).not.toContain('secret-token');
        }
    });

    it('never includes external process output in enabled diagnostics', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        BackendServerAnalysisLog.enable();
        try {
            await YtDlpSubtitleStrategy.create(
                createInvalidTranscriptRunner(),
            ).extract({
                videoId: VIDEO_ID,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            });

            expect(
                JSON.stringify([info.mock.calls, warn.mock.calls]),
            ).not.toContain('secret-token');
        } finally {
            BackendServerAnalysisLog.disableForTests();
            vi.restoreAllMocks();
        }
    });

    it.each([
        {
            code: 'subtitle_response_too_large',
            raw: 'x'.repeat(1_048_577),
        },
        {
            code: 'too_many_caption_segments',
            raw: JSON.stringify({
                events: Array.from({ length: 10_001 }, (_, index) => ({
                    tStartMs: index,
                    segs: [{ utf8: 'x' }],
                })),
            }),
        },
        {
            code: 'transcript_too_large',
            raw: JSON.stringify({
                events: [
                    {
                        tStartMs: 0,
                        segs: [{ utf8: 'x'.repeat(500_001) }],
                    },
                ],
            }),
        },
    ])('returns distinct pre-model limit code $code', async ({ code, raw }) => {
        const result = await YtDlpSubtitleStrategy.create(
            createTranscriptRunner(raw),
        ).extract({
            videoId: VIDEO_ID,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(result).toMatchObject({
            status: 'failed',
            diagnostics: { code },
        });
    });
});

function succeeded(stdout: string): YtDlpRunResult {
    return { status: 'succeeded', stdout };
}

function createDownloadFailureRunner(): YtDlpRunner {
    let callCount = 0;
    return () => {
        callCount += 1;
        if (callCount === 1) {
            return Promise.resolve(
                succeeded(
                    JSON.stringify({
                        duration: 120,
                        language: 'en',
                        subtitles: { en: [{}] },
                    }),
                ),
            );
        }
        return Promise.resolve({
            status: 'failed',
            code: 'process_failed',
        });
    };
}

function createInvalidTranscriptRunner(): YtDlpRunner {
    let callCount = 0;
    return async (request) => {
        callCount += 1;
        if (callCount === 1) {
            return succeeded(
                JSON.stringify({
                    duration: 120,
                    language: 'en',
                    subtitles: { en: [{}] },
                }),
            );
        }
        const pathsIndex = request.args.indexOf('--paths');
        const pathsValue = request.args[pathsIndex + 1];
        if (pathsValue === undefined) {
            throw new Error('Missing subtitle path argument.');
        }
        const directory = pathsValue.replace(/^subtitle:/u, '');
        await writeFile(path.join(directory, `${VIDEO_ID}.en.json3`), '{}');
        return succeeded('secret-token must not be retained');
    };
}

function createTranscriptRunner(raw: string): YtDlpRunner {
    let callCount = 0;
    return async (request) => {
        callCount += 1;
        if (callCount === 1) {
            return succeeded(
                JSON.stringify({
                    duration: 18_000,
                    language: 'en',
                    subtitles: { en: [{}] },
                }),
            );
        }
        const pathsIndex = request.args.indexOf('--paths');
        const pathsValue = request.args[pathsIndex + 1];
        if (pathsValue === undefined) {
            throw new Error('Missing subtitle path argument.');
        }
        const directory = pathsValue.replace(/^subtitle:/u, '');
        await writeFile(path.join(directory, `${VIDEO_ID}.en.json3`), raw);
        return succeeded('');
    };
}
