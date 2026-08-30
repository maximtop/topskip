import { BYTES_PER_KIB, BYTES_PER_MIB } from '@/shared/constants';
import {
    DEBUG_LOG_FILE_EXTENSION,
    DEBUG_LOG_FILE_NAME_PREFIX,
} from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_SOURCE,
    type DebugLogEventName,
    type DebugLogFields,
    type DebugLogSource,
} from '@/shared/debug-log-events';
import { formatLogFields } from '@/shared/log-fields';

/**
 * One fully attributed event ready to be serialized as a log line.
 */
export type DebugLogLineRecord = {
    tsMs: number;
    worker: string;
    seq: number;
    src: DebugLogSource;
    tab?: number;
    video?: string;
    session?: string;
    job?: string;
    support?: string;
    event: DebugLogEventName;
    fields: DebugLogFields;
};

/**
 * Short source tags keep every line's fixed head narrow.
 */
const SOURCE_TAG: Readonly<Record<DebugLogSource, string>> = {
    [DEBUG_LOG_SOURCE.Background]: 'bg',
    [DEBUG_LOG_SOURCE.Content]: 'ct',
    [DEBUG_LOG_SOURCE.Bridge]: 'br',
};

/**
 * Head-field prefixes for the attributed identifiers, in line order.
 */
const LINE_PREFIX = {
    Tab: 't',
    Video: 'v=',
    Session: 's=',
    Job: 'j=',
    Support: 'sup=',
} as const;

/**
 * Separator between the worker id and the per-worker sequence.
 */
const WORKER_SEQ_SEPARATOR = '#';

/**
 * Printed instead of a timestamp that `Date` cannot represent, so a forged
 * age never turns a log line into an exception.
 */
const INVALID_TIMESTAMP = 'invalid-ts';

/**
 * Characters removed from an ISO timestamp to build the file-name stamp.
 */
const FILE_NAME_ISO_PUNCTUATION = /[-:]/gu;

/**
 * Millisecond suffix dropped from the file-name stamp (`.123Z` → `Z`).
 */
const FILE_NAME_ISO_MILLIS = /\.\d{3}Z$/u;

/**
 * Unit suffix below one KiB.
 */
const BYTES_UNIT = 'B';

/**
 * Decimal places shown for KiB / MiB sizes.
 */
const SIZE_DECIMALS = 1;

/**
 * UTF-8 continuation bytes carry `10xxxxxx`; a tail slice must not start on
 * one.
 */
const UTF8_CONTINUATION_MASK = 0xc0;

/**
 * Bit pattern of a UTF-8 continuation byte after masking.
 */
const UTF8_CONTINUATION_BITS = 0x80;

/**
 * One encoder per module; encoding is the unit of the ring-buffer cap.
 */
const UTF8_ENCODER = new TextEncoder();

/**
 * Decoder used to turn a byte-aligned tail back into text.
 */
const UTF8_DECODER = new TextDecoder();

/**
 * ISO-8601 UTC timestamp, or a stable token when the value is unrepresentable.
 *
 * @param tsMs - Milliseconds since the epoch.
 * @returns Timestamp text for the line head.
 */
function formatTimestamp(tsMs: number): string {
    if (!Number.isFinite(tsMs)) {
        return INVALID_TIMESTAMP;
    }
    try {
        return new Date(tsMs).toISOString();
    } catch {
        return INVALID_TIMESTAMP;
    }
}

/**
 * Serializes one record as
 * `<iso ts> <worker>#<seq> <src> [t<tab>] [v=…] [s=…] [j=…] [sup=…] <event>
 * [key=value …]` using the existing inline field formatter so unsafe strings
 * are quoted and undefined fields are omitted.
 *
 * @param record - Fully attributed event.
 * @returns One line without a trailing newline.
 */
export function formatDebugLogLine(record: DebugLogLineRecord): string {
    const head: string[] = [
        formatTimestamp(record.tsMs),
        `${record.worker}${WORKER_SEQ_SEPARATOR}${record.seq}`,
        SOURCE_TAG[record.src],
    ];
    if (record.tab !== undefined) {
        head.push(`${LINE_PREFIX.Tab}${record.tab}`);
    }
    if (record.video !== undefined) {
        head.push(`${LINE_PREFIX.Video}${record.video}`);
    }
    if (record.session !== undefined) {
        head.push(`${LINE_PREFIX.Session}${record.session}`);
    }
    if (record.job !== undefined) {
        head.push(`${LINE_PREFIX.Job}${record.job}`);
    }
    if (record.support !== undefined) {
        head.push(`${LINE_PREFIX.Support}${record.support}`);
    }
    head.push(record.event);
    const fields = formatLogFields(record.fields);
    return fields === '' ? head.join(' ') : `${head.join(' ')} ${fields}`;
}

/**
 * UTF-8 size of a string — the unit of the ring-buffer cap, which must not
 * drift from `.length` (UTF-16 units) on non-ASCII content.
 *
 * @param text - Any string.
 * @returns Encoded byte length.
 */
export function utf8ByteLength(text: string): number {
    return UTF8_ENCODER.encode(text).byteLength;
}

/**
 * Builds `topskip-debug-log-<YYYYMMDDTHHMMSSZ>.txt` from the snapshot
 * instant so the file name and the bundle header agree.
 *
 * @param exportedAt - Snapshot instant (UTC).
 * @returns Download file name.
 */
export function buildDebugLogFileName(exportedAt: Date): string {
    const stamp = exportedAt
        .toISOString()
        .replace(FILE_NAME_ISO_PUNCTUATION, '')
        .replace(FILE_NAME_ISO_MILLIS, 'Z');
    return `${DEBUG_LOG_FILE_NAME_PREFIX}${stamp}${DEBUG_LOG_FILE_EXTENSION}`;
}

/**
 * Keeps the last `maxBytes` of `text` without splitting a UTF-8 sequence, and
 * reports both sizes for the "showing the last X of Y" note.
 *
 * @param text - Full bundle or log text.
 * @param maxBytes - Byte budget for the tail.
 * @returns Tail text plus shown and total byte counts.
 */
export function sliceDebugLogTail(
    text: string,
    maxBytes: number,
): { text: string; shownBytes: number; totalBytes: number } {
    const bytes = UTF8_ENCODER.encode(text);
    const totalBytes = bytes.byteLength;
    if (totalBytes <= maxBytes) {
        return { text, shownBytes: totalBytes, totalBytes };
    }
    let start = totalBytes - Math.max(0, maxBytes);
    while (
        start < totalBytes &&
        (bytes[start] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS
    ) {
        start += 1;
    }
    return {
        text: UTF8_DECODER.decode(bytes.subarray(start)),
        shownBytes: totalBytes - start,
        totalBytes,
    };
}

/**
 * Human-readable binary size (`512 B`, `3.5 KiB`, `5.0 MiB`) for status
 * lines and the cap in UI copy.
 *
 * @param bytes - Non-negative byte count.
 * @returns Size with unit.
 */
export function formatBinarySize(bytes: number): string {
    if (bytes < BYTES_PER_KIB) {
        return `${bytes} ${BYTES_UNIT}`;
    }
    if (bytes < BYTES_PER_MIB) {
        return `${(bytes / BYTES_PER_KIB).toFixed(SIZE_DECIMALS)} KiB`;
    }
    return `${(bytes / BYTES_PER_MIB).toFixed(SIZE_DECIMALS)} MiB`;
}
