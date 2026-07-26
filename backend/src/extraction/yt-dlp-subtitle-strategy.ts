import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as v from 'valibot';

import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
    type SubtitleExtractionStrategyResult,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    YtDlpProcess,
    type YtDlpRunResult,
    type YtDlpRunner,
} from '@topskip/backend/extraction/yt-dlp-process';
import { parseTranscriptJson3 } from '@topskip/common/captions/transcript-json3';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';

const YT_DLP_STRATEGY_NAME = 'yt_dlp_subtitles';
const YOUTUBE_WATCH_BASE_URL = 'https://www.youtube.com/watch?v=';
const YT_DLP_PROCESS_TIMEOUT_MS = 30_000;
const MAX_YT_DLP_OUTPUT_BYTES = 1_000_000;
const MAX_CAPTION_RESPONSE_BYTES = 1_048_576;
const MAX_CAPTION_SEGMENT_COUNT = 10_000;
const MAX_TRANSCRIPT_TEXT_LENGTH = 500_000;
const MAX_VIDEO_DURATION_SEC = 5 * 60 * 60;
const TRANSCRIPT_ARTIFACT_ID_PREFIX = 'transcript';
const TRANSCRIPT_TEXT_SEPARATOR = '\n';
const JSON3_FILE_SUFFIX = '.json3';
const ENGLISH_LANGUAGE_CODE = 'en';

const trackMapSchema = v.record(v.string(), v.array(v.unknown()));
const metadataSchema = v.object({
    language: v.optional(v.nullable(v.string())),
    is_live: v.optional(v.nullable(v.boolean())),
    live_status: v.optional(v.nullable(v.string())),
    duration: v.optional(
        v.pipe(
            v.number(),
            v.check((value) => Number.isFinite(value)),
            v.minValue(0),
        ),
    ),
    subtitles: v.optional(trackMapSchema),
    automatic_captions: v.optional(trackMapSchema),
});

/**
 * Selected caption identity determines which yt-dlp download mode is safe to
 * invoke.
 */
export type YtDlpSubtitleTrack = {
    kind: 'manual' | 'automatic';
    languageCode: string;
};

/**
 * Applies the product language fallback policy to validated yt-dlp metadata.
 *
 * @param input - Unknown metadata returned by the external process.
 * @returns Selected caption track or `null` when metadata is unusable.
 */
export function selectYtDlpSubtitleTrack(
    input: unknown,
): YtDlpSubtitleTrack | null {
    const parsed = v.safeParse(metadataSchema, input);
    if (!parsed.success) {
        return null;
    }
    const manual = Object.keys(parsed.output.subtitles ?? {}).sort();
    const automatic = Object.keys(
        parsed.output.automatic_captions ?? {},
    ).sort();
    const original = parsed.output.language?.trim();
    const candidates: Array<YtDlpSubtitleTrack | null> = [
        selectMatchingTrack(manual, original, 'manual'),
        selectMatchingTrack(automatic, original, 'automatic'),
        selectMatchingTrack(manual, ENGLISH_LANGUAGE_CODE, 'manual'),
        selectMatchingTrack(automatic, ENGLISH_LANGUAGE_CODE, 'automatic'),
        firstTrack(manual, 'manual'),
        firstTrack(automatic, 'automatic'),
    ];
    return candidates.find((candidate) => candidate !== null) ?? null;
}

/**
 * Owns server-side YouTube caption extraction through yt-dlp; static API only.
 */
export class YtDlpSubtitleStrategy {
    /**
     * Creates an injectable strategy so unit tests never contact YouTube.
     *
     * @param runner - Bounded yt-dlp process boundary.
     * @returns Production extraction strategy.
     */
    static create(
        runner: YtDlpRunner = (request) => YtDlpProcess.run(request),
    ): SubtitleExtractionStrategy {
        return {
            name: YT_DLP_STRATEGY_NAME,
            extract: async (input) => {
                BackendServerAnalysisLog.info('yt-dlp-metadata-started', {
                    videoId: input.videoId,
                });
                const metadataResult = await runner({
                    args: YtDlpSubtitleStrategy.metadataArgs(input.videoId),
                    maxOutputBytes: MAX_YT_DLP_OUTPUT_BYTES,
                    timeoutMs: YT_DLP_PROCESS_TIMEOUT_MS,
                });
                if (metadataResult.status !== 'succeeded') {
                    BackendServerAnalysisLog.warn('yt-dlp-metadata-failed', {
                        videoId: input.videoId,
                        code: metadataResult.code,
                    });
                    return YtDlpSubtitleStrategy.processFailure(
                        metadataResult,
                        'metadata_invalid',
                    );
                }

                const metadata = YtDlpSubtitleStrategy.parseMetadata(
                    metadataResult.stdout,
                );
                if (metadata === null) {
                    BackendServerAnalysisLog.warn('yt-dlp-metadata-failed', {
                        videoId: input.videoId,
                        code: 'metadata_invalid',
                    });
                    return YtDlpSubtitleStrategy.failed('metadata_invalid');
                }
                if (!YtDlpSubtitleStrategy.isOrdinaryVod(metadata)) {
                    BackendServerAnalysisLog.warn('yt-dlp-metadata-failed', {
                        videoId: input.videoId,
                        code: 'video_unavailable',
                    });
                    return YtDlpSubtitleStrategy.failed('video_unavailable');
                }
                if (metadata.duration > MAX_VIDEO_DURATION_SEC) {
                    BackendServerAnalysisLog.warn('yt-dlp-metadata-failed', {
                        videoId: input.videoId,
                        code: 'video_too_long',
                    });
                    return YtDlpSubtitleStrategy.failed('video_too_long');
                }
                const track = selectYtDlpSubtitleTrack(metadata);
                if (track === null) {
                    BackendServerAnalysisLog.warn('yt-dlp-track-missing', {
                        videoId: input.videoId,
                        code: 'no_subtitles',
                    });
                    return YtDlpSubtitleStrategy.failed('captions_unavailable');
                }

                BackendServerAnalysisLog.info('yt-dlp-track-selected', {
                    videoId: input.videoId,
                    trackKind: track.kind,
                    languageCode: track.languageCode,
                });

                const directory = await mkdtemp(
                    path.join(tmpdir(), 'topskip-yt-dlp-'),
                );
                try {
                    BackendServerAnalysisLog.info('yt-dlp-download-started', {
                        videoId: input.videoId,
                        trackKind: track.kind,
                        languageCode: track.languageCode,
                    });
                    const downloadResult = await runner({
                        args: YtDlpSubtitleStrategy.downloadArgs({
                            videoId: input.videoId,
                            directory,
                            track,
                        }),
                        maxOutputBytes: MAX_YT_DLP_OUTPUT_BYTES,
                        timeoutMs: YT_DLP_PROCESS_TIMEOUT_MS,
                    });
                    if (downloadResult.status !== 'succeeded') {
                        BackendServerAnalysisLog.warn(
                            'yt-dlp-download-failed',
                            {
                                videoId: input.videoId,
                                code: downloadResult.code,
                            },
                        );
                        return YtDlpSubtitleStrategy.processFailure(
                            downloadResult,
                            'download_failure',
                        );
                    }
                    return await YtDlpSubtitleStrategy.readArtifact({
                        directory,
                        track,
                        videoId: input.videoId,
                        algorithmVersion: input.algorithmVersion,
                        nowMs: input.nowMs,
                        videoDurationSec: metadata.duration,
                    });
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            },
        };
    }

    /**
     * Uses only machine-readable metadata and disables ambient user configs.
     *
     * @param videoId - Validated YouTube video id.
     * @returns Safe yt-dlp metadata arguments.
     */
    private static metadataArgs(videoId: string): readonly string[] {
        return [
            '--ignore-config',
            '--no-playlist',
            '--skip-download',
            '--dump-single-json',
            '--no-warnings',
            '--no-progress',
            '--no-js-runtimes',
            '--js-runtimes',
            'node',
            `${YOUTUBE_WATCH_BASE_URL}${videoId}`,
        ];
    }

    /**
     * Downloads exactly one selected caption track without media files.
     *
     * @param input - Video, temporary directory, and selected caption track.
     * @returns Safe yt-dlp subtitle download arguments.
     */
    private static downloadArgs(input: {
        videoId: string;
        directory: string;
        track: YtDlpSubtitleTrack;
    }): readonly string[] {
        const mode =
            input.track.kind === 'manual'
                ? '--write-subs'
                : '--write-auto-subs';
        return [
            '--ignore-config',
            '--no-playlist',
            '--skip-download',
            '--no-warnings',
            '--no-progress',
            '--no-js-runtimes',
            '--js-runtimes',
            'node',
            mode,
            '--sub-format',
            'json3',
            '--sub-langs',
            `^${escapeRegularExpression(input.track.languageCode)}$`,
            '--paths',
            `subtitle:${input.directory}`,
            '--paths',
            `home:${input.directory}`,
            '--output',
            'subtitle:%(id)s.%(ext)s',
            `${YOUTUBE_WATCH_BASE_URL}${input.videoId}`,
        ];
    }

    /**
     * Parses stdout as unknown before validating its track maps.
     *
     * @param stdout - Bounded yt-dlp metadata output.
     * @returns Unknown JSON value or `null` when decoding fails.
     */
    private static parseMetadata(
        stdout: string,
    ): v.InferOutput<typeof metadataSchema> | null {
        try {
            const unknownMetadata = JSON.parse(stdout) as unknown;
            const parsed = v.safeParse(metadataSchema, unknownMetadata);
            return parsed.success ? parsed.output : null;
        } catch {
            return null;
        }
    }

    /**
     * Reads the sole generated json3 file and converts it into an artifact.
     *
     * @param input - Temp directory and artifact identity metadata.
     * @returns Selected artifact or safe failure.
     */
    private static async readArtifact(input: {
        directory: string;
        track: YtDlpSubtitleTrack;
        videoId: string;
        algorithmVersion: string;
        nowMs: number;
        videoDurationSec: number | undefined;
    }): Promise<SubtitleExtractionStrategyResult> {
        const files = (await readdir(input.directory)).filter((file) =>
            file.endsWith(JSON3_FILE_SUFFIX),
        );
        if (files.length !== 1 || files[0] === undefined) {
            BackendServerAnalysisLog.warn('yt-dlp-artifact-failed', {
                videoId: input.videoId,
                code: 'download_failure',
            });
            return YtDlpSubtitleStrategy.failed('download_failure');
        }
        const raw = await YtDlpSubtitleStrategy.readBoundedSubtitleFile(
            path.join(input.directory, files[0]),
        );
        if (raw === null) {
            BackendServerAnalysisLog.warn('yt-dlp-parse-failed', {
                videoId: input.videoId,
                code: 'oversized_response',
            });
            return YtDlpSubtitleStrategy.failed('subtitle_response_too_large');
        }
        const parsed = parseTranscriptJson3(raw.toString('utf8'));
        if (!parsed.ok) {
            BackendServerAnalysisLog.warn('yt-dlp-parse-failed', {
                videoId: input.videoId,
                code: 'parse_failure',
            });
            return YtDlpSubtitleStrategy.failed('parse_failure');
        }
        const transcriptText = parsed.segments
            .map((segment) => segment.text.trim())
            .join(TRANSCRIPT_TEXT_SEPARATOR);
        if (parsed.segments.length > MAX_CAPTION_SEGMENT_COUNT) {
            BackendServerAnalysisLog.warn('yt-dlp-parse-failed', {
                videoId: input.videoId,
                code: 'oversized_response',
            });
            return YtDlpSubtitleStrategy.failed('too_many_caption_segments');
        }
        if (transcriptText.length > MAX_TRANSCRIPT_TEXT_LENGTH) {
            BackendServerAnalysisLog.warn('yt-dlp-parse-failed', {
                videoId: input.videoId,
                code: 'transcript_too_large',
            });
            return YtDlpSubtitleStrategy.failed('transcript_too_large');
        }
        BackendServerAnalysisLog.info('yt-dlp-parse-completed', {
            videoId: input.videoId,
            languageCode: input.track.languageCode,
            segmentCount: parsed.segments.length,
        });
        return {
            status: 'succeeded',
            artifact: v.parse(transcriptArtifactSchema, {
                artifactId: [
                    TRANSCRIPT_ARTIFACT_ID_PREFIX,
                    input.videoId,
                    input.algorithmVersion,
                    YT_DLP_STRATEGY_NAME,
                ].join('-'),
                videoId: input.videoId,
                algorithmVersion: input.algorithmVersion,
                strategy: YT_DLP_STRATEGY_NAME,
                sourceType: 'youtube_yt_dlp',
                languageCode: input.track.languageCode,
                videoDurationSec: input.videoDurationSec,
                acquiredAtMs: input.nowMs,
                segments: parsed.segments,
                transcriptText,
            }),
        };
    }

    /**
     * Requires duration-bearing non-live metadata before captions or Gemini can run.
     *
     * @param metadata - Validated yt-dlp metadata object.
     * @returns Whether metadata proves a finite ordinary VOD duration.
     */
    private static isOrdinaryVod(
        metadata: v.InferOutput<typeof metadataSchema>,
    ): metadata is v.InferOutput<typeof metadataSchema> & {
        duration: number;
    } {
        if (
            metadata.duration === undefined ||
            !Number.isFinite(metadata.duration) ||
            metadata.duration <= 0 ||
            metadata.is_live === true
        ) {
            return false;
        }
        return (
            metadata.live_status === undefined ||
            metadata.live_status === null ||
            metadata.live_status === 'not_live'
        );
    }

    /**
     * Stats and reads a subtitle through a fixed-size handle buffer to cap allocation.
     *
     * @param filePath - Sole generated JSON3 subtitle path.
     * @returns Complete bounded bytes, or `null` when the file exceeds 1 MiB.
     */
    private static async readBoundedSubtitleFile(
        filePath: string,
    ): Promise<Buffer | null> {
        const file = await open(filePath, 'r');
        try {
            const stats = await file.stat();
            if (stats.size > MAX_CAPTION_RESPONSE_BYTES) {
                return null;
            }
            const raw = Buffer.alloc(stats.size);
            let offset = 0;
            while (offset < raw.byteLength) {
                const { bytesRead } = await file.read(
                    raw,
                    offset,
                    raw.byteLength - offset,
                    offset,
                );
                if (bytesRead === 0) {
                    break;
                }
                offset += bytesRead;
            }
            const growthProbe = Buffer.alloc(1);
            const { bytesRead: grownBytes } = await file.read(
                growthProbe,
                0,
                1,
                offset,
            );
            if (grownBytes > 0) {
                return null;
            }
            return offset === raw.byteLength ? raw : raw.subarray(0, offset);
        } finally {
            await file.close();
        }
    }

    /**
     * Preserves timeouts separately and hides external process details.
     *
     * @param result - Failed bounded subprocess result.
     * @param defaultCode - Stage-specific safe fallback code.
     * @returns Safe strategy failure.
     */
    private static processFailure(
        result: Exclude<YtDlpRunResult, { status: 'succeeded' }>,
        defaultCode: string,
    ): SubtitleExtractionStrategyResult {
        if (result.status === 'timed_out') {
            return {
                status: 'timed_out',
                failureReason:
                    SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
                diagnostics: { code: result.code },
            };
        }
        const code =
            result.code === 'process_failed' ? defaultCode : result.code;
        return YtDlpSubtitleStrategy.failed(code);
    }

    /**
     * Maps external failures to generic failure reasons plus stable diagnostics.
     *
     * @param code - Safe diagnostic code.
     * @returns Failed extraction result.
     */
    private static failed(code: string): SubtitleExtractionStrategyResult {
        return {
            status: 'failed',
            failureReason: SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
            diagnostics: { code },
        };
    }
}

/**
 * Finds an exact or regional caption key for one preferred language.
 *
 * @param languages - Sorted available track keys.
 * @param preferred - Preferred language from metadata or fallback policy.
 * @param kind - Track source kind.
 * @returns Matching track or `null`.
 */
function selectMatchingTrack(
    languages: readonly string[],
    preferred: string | undefined,
    kind: YtDlpSubtitleTrack['kind'],
): YtDlpSubtitleTrack | null {
    if (preferred === undefined || preferred.length === 0) {
        return null;
    }
    const match = languages.find(
        (language) =>
            language === preferred || language.startsWith(`${preferred}-`),
    );
    return match === undefined ? null : { kind, languageCode: match };
}

/**
 * Provides a deterministic fallback independent of object insertion order.
 *
 * @param languages - Sorted available track keys.
 * @param kind - Track source kind.
 * @returns First track or `null`.
 */
function firstTrack(
    languages: readonly string[],
    kind: YtDlpSubtitleTrack['kind'],
): YtDlpSubtitleTrack | null {
    const languageCode = languages[0];
    return languageCode === undefined ? null : { kind, languageCode };
}

/**
 * Prevents a metadata-provided language key from widening yt-dlp's regex.
 *
 * @param value - Exact caption language key.
 * @returns Regex-safe language key.
 */
function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
