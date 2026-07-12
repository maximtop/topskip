import * as v from 'valibot';

import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
    type SubtitleExtractionStrategyInput,
    type SubtitleExtractionStrategyResult,
} from '@/backend/extraction/subtitle-extraction-types';
import { parseTranscriptXml } from '@/shared/captions/transcript-xml';

const YOUTUBE_TIMEDTEXT_ENDPOINT = 'https://www.youtube.com/api/timedtext';
const YOUTUBE_TIMEDTEXT_LANGUAGE = 'en';
const YOUTUBE_TIMEDTEXT_FORMAT = 'srv3';
const YOUTUBE_TIMEDTEXT_STRATEGY_NAME = 'youtube_timedtext_en';
const YOUTUBE_TIMEDTEXT_ASR_STRATEGY_NAME = 'youtube_timedtext_en_asr';
const YOUTUBE_TIMEDTEXT_AUTOMATIC_KIND = 'asr';
const TRANSCRIPT_ARTIFACT_ID_PREFIX = 'transcript';
const TRANSCRIPT_TEXT_SEPARATOR = '\n';
const NETWORK_CAPTION_EXTRACTION_ENV =
    'TOPSKIP_ENABLE_NETWORK_CAPTION_EXTRACTION';
const NETWORK_CAPTION_EXTRACTION_ENABLED_VALUE = 'true';
const CAPTION_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CAPTION_RESPONSE_BYTES = 1_000_000;
const MAX_CAPTION_SEGMENT_COUNT = 10_000;
const MAX_TRANSCRIPT_TEXT_LENGTH = 500_000;

/**
 * Minimal fetch response consumed by the caption source without retaining URL data.
 */
type TimedTextResponse = {
    ok: boolean;
    text: () => Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
};

/**
 * Injectable fetch boundary used to exercise source ordering without real network traffic.
 */
export type YouTubeTimedTextFetcher = (url: URL) => Promise<TimedTextResponse>;

/**
 * Constructs opt-in YouTube timedtext strategies for the loopback backend; static API only.
 */
export class YouTubeTimedTextStrategies {
    /**
     * Creates the direct English caption source used before automatic captions.
     *
     * @param fetchTranscript - Optional fetch boundary for integration tests.
     * @returns A strategy that requests direct English timedtext captions.
     */
    static direct(
        fetchTranscript?: YouTubeTimedTextFetcher,
    ): SubtitleExtractionStrategy {
        return YouTubeTimedTextStrategies.create({
            name: YOUTUBE_TIMEDTEXT_STRATEGY_NAME,
            automatic: false,
            fetchTranscript,
        });
    }

    /**
     * Creates the automatic-caption fallback after direct captions miss.
     *
     * @param fetchTranscript - Optional fetch boundary for integration tests.
     * @returns A strategy that requests automatic English timedtext captions.
     */
    static automaticFallback(
        fetchTranscript?: YouTubeTimedTextFetcher,
    ): SubtitleExtractionStrategy {
        return YouTubeTimedTextStrategies.create({
            name: YOUTUBE_TIMEDTEXT_ASR_STRATEGY_NAME,
            automatic: true,
            fetchTranscript,
        });
    }

    /**
     * Builds a strategy with one stable variant so diagnostics never retain remote URLs.
     *
     * @param input - Strategy identity, caption variant, and optional test fetcher.
     * @returns Configured timedtext strategy.
     */
    private static create(input: {
        name: string;
        automatic: boolean;
        fetchTranscript?: YouTubeTimedTextFetcher;
    }): SubtitleExtractionStrategy {
        return {
            name: input.name,
            extract: async (strategyInput) =>
                YouTubeTimedTextStrategies.extract({
                    strategyInput,
                    name: input.name,
                    automatic: input.automatic,
                    fetchTranscript: input.fetchTranscript,
                }),
        };
    }

    /**
     * Fetches and validates one caption variant only when the local operator enables it.
     *
     * @param input - Strategy input, configured variant, and optional test fetcher.
     * @returns A validated candidate artifact or a safe structured failure.
     */
    private static async extract(input: {
        strategyInput: SubtitleExtractionStrategyInput;
        name: string;
        automatic: boolean;
        fetchTranscript?: YouTubeTimedTextFetcher;
    }): Promise<SubtitleExtractionStrategyResult> {
        const fetchTranscript = input.fetchTranscript;
        if (
            fetchTranscript === undefined &&
            !YouTubeTimedTextStrategies.networkExtractionEnabled()
        ) {
            return YouTubeTimedTextStrategies.failed('caption_source_disabled');
        }

        const url = YouTubeTimedTextStrategies.buildUrl({
            videoId: input.strategyInput.videoId,
            automatic: input.automatic,
        });
        const fetcher =
            fetchTranscript ??
            ((url: URL) => YouTubeTimedTextStrategies.fetch(url));

        let response: TimedTextResponse;
        try {
            response = await fetcher(url);
        } catch {
            return YouTubeTimedTextStrategies.failed('caption_request_failed');
        }
        if (!response.ok) {
            return YouTubeTimedTextStrategies.failed('caption_http_error');
        }

        let rawTranscript: string;
        try {
            rawTranscript =
                await YouTubeTimedTextStrategies.readBoundedText(response);
        } catch {
            return YouTubeTimedTextStrategies.failed('caption_response_failed');
        }

        const parsedTranscript = parseTranscriptXml(rawTranscript);
        if (!parsedTranscript.ok) {
            return YouTubeTimedTextStrategies.failed('caption_parse_failed');
        }
        if (parsedTranscript.segments.length > MAX_CAPTION_SEGMENT_COUNT) {
            return YouTubeTimedTextStrategies.failed('caption_too_large');
        }

        const transcriptText = parsedTranscript.segments
            .map((segment) => segment.text.trim())
            .join(TRANSCRIPT_TEXT_SEPARATOR);
        if (transcriptText.length > MAX_TRANSCRIPT_TEXT_LENGTH) {
            return YouTubeTimedTextStrategies.failed('caption_too_large');
        }

        return {
            status: 'succeeded',
            artifact: v.parse(transcriptArtifactSchema, {
                artifactId: [
                    TRANSCRIPT_ARTIFACT_ID_PREFIX,
                    input.strategyInput.videoId,
                    input.strategyInput.algorithmVersion,
                    input.name,
                ].join('-'),
                videoId: input.strategyInput.videoId,
                algorithmVersion: input.strategyInput.algorithmVersion,
                strategy: input.name,
                sourceType: 'youtube_timedtext',
                languageCode: YOUTUBE_TIMEDTEXT_LANGUAGE,
                acquiredAtMs: input.strategyInput.nowMs,
                segments: parsedTranscript.segments,
                transcriptText,
            }),
        };
    }

    /**
     * Keeps outbound caption access opt-in until the local backend has public hardening.
     *
     * @returns Whether the operator explicitly enabled network caption extraction.
     */
    private static networkExtractionEnabled(): boolean {
        return (
            process.env[NETWORK_CAPTION_EXTRACTION_ENV] ===
            NETWORK_CAPTION_EXTRACTION_ENABLED_VALUE
        );
    }

    /**
     * Requests a caption response with a bounded timeout and no credential forwarding.
     *
     * @param url - YouTube timedtext URL built from validated video metadata.
     * @returns Response body adapter for the strategy parser.
     */
    private static async fetch(url: URL): Promise<TimedTextResponse> {
        return fetch(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(CAPTION_REQUEST_TIMEOUT_MS),
        });
    }

    /**
     * Reads a remote caption body without allowing a malformed track to exhaust memory.
     *
     * @param response - Caption response from the injectable fetch boundary.
     * @returns Decoded UTF-8 caption XML within the configured byte budget.
     */
    private static async readBoundedText(
        response: TimedTextResponse,
    ): Promise<string> {
        if (response.body === undefined || response.body === null) {
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_CAPTION_RESPONSE_BYTES) {
                throw new Error('Caption response exceeds byte limit.');
            }
            return text;
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) {
                    break;
                }
                byteLength += next.value.byteLength;
                if (byteLength > MAX_CAPTION_RESPONSE_BYTES) {
                    await reader.cancel();
                    throw new Error('Caption response exceeds byte limit.');
                }
                chunks.push(next.value);
            }
        } finally {
            reader.releaseLock();
        }

        return new TextDecoder().decode(Buffer.concat(chunks));
    }

    /**
     * Builds a direct or automatic caption URL from the validated video identifier.
     *
     * @param input - Video identifier and requested caption variant.
     * @returns Timedtext endpoint URL without credentials or persisted query details.
     */
    private static buildUrl(input: {
        videoId: string;
        automatic: boolean;
    }): URL {
        const url = new URL(YOUTUBE_TIMEDTEXT_ENDPOINT);
        url.searchParams.set('v', input.videoId);
        url.searchParams.set('lang', YOUTUBE_TIMEDTEXT_LANGUAGE);
        url.searchParams.set('fmt', YOUTUBE_TIMEDTEXT_FORMAT);
        if (input.automatic) {
            url.searchParams.set('kind', YOUTUBE_TIMEDTEXT_AUTOMATIC_KIND);
        }
        return url;
    }

    /**
     * Maps external failures to a bounded reason and stable diagnostic code.
     *
     * @param code - Safe diagnostic code that reveals no response or request detail.
     * @returns Failed extraction result for the pipeline to record.
     */
    private static failed(code: string): SubtitleExtractionStrategyResult {
        return {
            status: 'failed',
            failureReason: SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
            diagnostics: { code },
        };
    }
}
