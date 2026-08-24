import { Text } from '@mantine/core';
import type { ReactElement } from 'react';

/**
 * Label resolved by the popup view model; `null` means nothing renders
 * (switch off, or background status not yet known).
 */
type DebugLoggingIndicatorProps = {
    label: string | null;
};

/**
 * Non-interactive status line telling the user a persistent, id-bearing log
 * is being collected. Renders nothing without a label so a default never
 * claims logging is on, and stays plain text (no button, no footer or version
 * copy) so the popup's fixed 320 px layout and its accessibility audit are
 * unaffected; the label wraps rather than overflowing.
 *
 * @param props - Localized label or `null`.
 * @returns Status text, or `null` when there is nothing to announce.
 */
export function DebugLoggingIndicator(
    props: DebugLoggingIndicatorProps,
): ReactElement | null {
    if (props.label === null) {
        return null;
    }
    return (
        <Text
            role="status"
            data-testid="popup-debug-logging-indicator"
            size="xs"
            c="dimmed"
            px="md"
            py={6}
            style={{ borderTop: '1px solid var(--mantine-color-slate-2)' }}
        >
            {props.label}
        </Text>
    );
}
