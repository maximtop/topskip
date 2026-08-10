/**
 * Applies a browser-defined default only when an optional field is omitted.
 *
 * @param value - Explicit runtime value or an omitted field.
 * @param defaultValue - Value Chromium uses when the field is omitted.
 * @returns Explicit value, or the browser default for `undefined`.
 */
export function normalizeOptionalValue<T>(
    value: T | undefined,
    defaultValue: T,
): T {
    return value === undefined ? defaultValue : value;
}

/**
 * Compares optional primitive-style fields using the same browser default.
 *
 * @param left - First explicit or omitted field.
 * @param right - Second explicit or omitted field.
 * @param defaultValue - Value Chromium applies to both omitted fields.
 * @returns Whether both fields resolve to the same runtime value.
 */
export function areDefaultedValuesEqual<T>(
    left: T | undefined,
    right: T | undefined,
    defaultValue: T,
): boolean {
    return Object.is(
        normalizeOptionalValue(left, defaultValue),
        normalizeOptionalValue(right, defaultValue),
    );
}

/**
 * Treats omitted registration lists as empty while preserving declared order.
 *
 * @param left - First explicit or omitted ordered list.
 * @param right - Second explicit or omitted ordered list.
 * @returns Whether both lists contain identical values in identical order.
 */
export function areOptionalOrderedValuesEqual<T>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined,
): boolean {
    const normalizedLeft = left ?? [];
    const normalizedRight = right ?? [];
    return (
        normalizedLeft.length === normalizedRight.length &&
        normalizedLeft.every((value, index) =>
            Object.is(value, normalizedRight[index]),
        )
    );
}
