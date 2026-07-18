import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * Prevents a single upload from expanding model and persistence work without bound.
 */
export const MAX_TRANSCRIPT_SEGMENT_COUNT = 10_000;

/**
 * Bounds normalized transcript text by Unicode scalar values rather than UTF-16 units.
 */
export const MAX_TRANSCRIPT_CHARACTER_COUNT = 500_000;

/**
 * Keeps uploaded caption timelines within the product's five-hour limit.
 */
export const MAX_TRANSCRIPT_TIMELINE_SEC = 18_000;

/**
 * Bounds the normalized BCP-47-like caption language used in exact identity.
 */
export const MAX_CAPTION_LANGUAGE_CODE_LENGTH = 64;

const CAPTION_LANGUAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEANINGFUL_TEXT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;
const HIGH_SURROGATE_START = 0xd800;
const LOW_SURROGATE_END = 0xdfff;

/**
 * Canonical transcript data shared by browser and backend identity code.
 */
export type CanonicalTranscript = {
    languageCode: string;
    segments: CaptionSegment[];
    canonicalJson: string;
    canonicalBytes: Uint8Array;
    characterCount: number;
    timelineEndSec: number;
};

/**
 * Stable safe failure codes let callers map limits without leaking input data.
 */
export type CanonicalTranscriptFailureCode =
    | 'invalid_request'
    | 'too_many_caption_segments'
    | 'transcript_too_large'
    | 'video_too_long';

/**
 * Canonicalization either returns one authoritative value or a safe rejection code.
 */
export type CanonicalTranscriptResult =
    | { ok: true; transcript: CanonicalTranscript }
    | { ok: false; code: CanonicalTranscriptFailureCode };

/**
 * Groups validation and serialization so both runtimes consume one deterministic algorithm.
 */
export class CaptionTranscriptCanonicalizer {
    /**
     * Validates and normalizes timed captions without sorting or runtime I/O.
     *
     * @param input - Untrusted language and ordered timed segments.
     * @returns Canonical transcript or a stable validation failure.
     */
    static canonicalize(input: {
        languageCode: string;
        segments: readonly CaptionSegment[];
    }): CanonicalTranscriptResult {
        const languageCode = this.normalizeLanguage(input.languageCode);
        if (languageCode === null) {
            return { ok: false, code: 'invalid_request' };
        }
        if (input.segments.length > MAX_TRANSCRIPT_SEGMENT_COUNT) {
            return { ok: false, code: 'too_many_caption_segments' };
        }
        if (input.segments.length === 0) {
            return { ok: false, code: 'invalid_request' };
        }

        const segments: CaptionSegment[] = [];
        let characterCount = 0;
        let previousStartSec = 0;
        let timelineEndSec = 0;

        for (const [index, segment] of input.segments.entries()) {
            const normalized = this.normalizeSegment(segment);
            if (normalized === null) {
                return { ok: false, code: 'invalid_request' };
            }
            if (index > 0 && normalized.segment.startSec < previousStartSec) {
                return { ok: false, code: 'invalid_request' };
            }
            if (normalized.endSec > MAX_TRANSCRIPT_TIMELINE_SEC) {
                return { ok: false, code: 'video_too_long' };
            }

            characterCount += normalized.characterCount;
            if (characterCount > MAX_TRANSCRIPT_CHARACTER_COUNT) {
                return { ok: false, code: 'transcript_too_large' };
            }

            previousStartSec = normalized.segment.startSec;
            timelineEndSec = Math.max(timelineEndSec, normalized.endSec);
            segments.push(normalized.segment);
        }

        const tuples = segments.map((segment) => [
            segment.startSec,
            segment.durationSec,
            segment.text,
        ]);
        const canonicalJson = JSON.stringify(tuples);

        return {
            ok: true,
            transcript: {
                languageCode,
                segments,
                canonicalJson,
                canonicalBytes: new TextEncoder().encode(canonicalJson),
                characterCount,
                timelineEndSec,
            },
        };
    }

    /**
     * Normalizes only the ASCII spelling rules that are safe for identity.
     *
     * @param rawLanguage - Untrusted caption language spelling.
     * @returns Normalized language or null when it cannot identify a track safely.
     */
    private static normalizeLanguage(rawLanguage: string): string | null {
        const normalizedLanguage = rawLanguage
            .trim()
            .replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
        if (
            normalizedLanguage.length === 0 ||
            normalizedLanguage.length > MAX_CAPTION_LANGUAGE_CODE_LENGTH ||
            !CAPTION_LANGUAGE_PATTERN.test(normalizedLanguage)
        ) {
            return null;
        }
        return normalizedLanguage;
    }

    /**
     * Normalizes one cue while preserving meaningful internal transcript data.
     *
     * @param rawSegment - Untrusted timed caption cue.
     * @returns Normalized cue metadata or null when the cue is malformed.
     */
    private static normalizeSegment(rawSegment: CaptionSegment): {
        segment: CaptionSegment;
        characterCount: number;
        endSec: number;
    } | null {
        if (
            !Number.isFinite(rawSegment.startSec) ||
            rawSegment.startSec < 0 ||
            !Number.isFinite(rawSegment.durationSec) ||
            rawSegment.durationSec < 0
        ) {
            return null;
        }

        const text = rawSegment.text
            .replace(/\r\n?/gu, '\n')
            .normalize('NFC')
            .trim();
        if (!MEANINGFUL_TEXT_PATTERN.test(text)) {
            return null;
        }

        let characterCount = 0;
        for (const scalar of text) {
            const codePoint = scalar.codePointAt(0);
            if (
                codePoint === undefined ||
                (codePoint >= HIGH_SURROGATE_START &&
                    codePoint <= LOW_SURROGATE_END)
            ) {
                return null;
            }
            characterCount += 1;
        }

        const startSec = Object.is(rawSegment.startSec, -0)
            ? 0
            : rawSegment.startSec;
        const durationSec = Object.is(rawSegment.durationSec, -0)
            ? 0
            : rawSegment.durationSec;
        const endSec = startSec + durationSec;
        if (!Number.isFinite(endSec)) {
            return null;
        }

        return {
            segment: { startSec, durationSec, text },
            characterCount,
            endSec,
        };
    }
}
