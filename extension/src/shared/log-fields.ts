/**
 * Matches values that can sit bare inside `key=value` pairs without blurring
 * into a neighbouring pair or looking like another key.
 */
const INLINE_SAFE_STRING = /^[^\s"=]+$/u;

/**
 * Placeholder for values JSON cannot serialize (cycles, BigInt, functions).
 */
const UNSERIALIZABLE_LOG_VALUE = '[unserializable]';

/**
 * Keeps one diagnostic value readable on a single console line.
 *
 * @param value - Field value of any shape.
 * @returns Bare scalar, JSON-quoted string, or JSON for nested values.
 */
function formatLogValue(value: unknown): string {
    if (typeof value === 'string') {
        return INLINE_SAFE_STRING.test(value) ? value : JSON.stringify(value);
    }
    if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
    ) {
        return String(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return UNSERIALIZABLE_LOG_VALUE;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return UNSERIALIZABLE_LOG_VALUE;
    }
}

/**
 * Renders structured diagnostic fields as `key=value` pairs so DevTools shows
 * the content on the log line itself instead of a collapsed object. Undefined
 * fields are skipped because they carry no information on a single line.
 *
 * @param fields - Diagnostic fields in insertion order.
 * @returns Space-separated pairs, or an empty string without fields.
 */
export function formatLogFields(
    fields: Readonly<Record<string, unknown>>,
): string {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
            pairs.push(`${key}=${formatLogValue(value)}`);
        }
    }
    return pairs.join(' ');
}

/**
 * Builds the console arguments for one structured stage: the stable event
 * name, then the inline fields only when there are any.
 *
 * @param event - Stable stage identifier.
 * @param fields - Diagnostic fields in insertion order.
 * @returns Arguments to spread after the log prefix.
 */
export function formatLogStage(
    event: string,
    fields: Readonly<Record<string, unknown>>,
): [string] | [string, string] {
    const line = formatLogFields(fields);
    return line === '' ? [event] : [event, line];
}
