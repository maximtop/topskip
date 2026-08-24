import {
    Alert,
    Button,
    Group,
    Paper,
    Stack,
    Switch,
    Text,
    Textarea,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import {
    DIAGNOSTICS_PHASE,
    canExportDebugLog,
    canToggleDebugLogging,
    type DiagnosticsPhase,
} from '@/options/diagnostics-state';
import { DEBUG_LOG_CAP_BYTES } from '@/shared/debug-log-constants';
import { formatBinarySize } from '@/shared/debug-log-format';
import { translator } from '@/shared/i18n/translator';
import type {
    DebugLogDroppedCounters,
    DebugLogStatusPayload,
} from '@/shared/messages';

/**
 * Outcome of the last toggle, copy or download action. The panel maps each
 * outcome to localized copy so raw runtime errors never reach the DOM.
 */
export type DiagnosticsFeedback =
    | 'copied'
    | 'copy_failed'
    | 'download_started'
    | 'toggle_failed'
    | 'export_failed';

/**
 * Most recent part of the bundle, shown read-only; `shownBytes < totalBytes`
 * marks a truncated tail.
 */
export type DiagnosticsPreview = {
    text: string;
    shownBytes: number;
    totalBytes: number;
};

/**
 * Everything the container resolved for the section; the panel only renders.
 * `status` is the last validated background read (kept while unavailable so
 * a transient failure does not visually flip the switch).
 */
export type DiagnosticsPanelState = {
    phase: DiagnosticsPhase;
    status: DebugLogStatusPayload | null;
    preview: DiagnosticsPreview | null;
    feedback: DiagnosticsFeedback | null;
    busy: boolean;
};

/**
 * Diagnostics section inputs supplied by the options container.
 */
export type DiagnosticsPanelProps = {
    state: DiagnosticsPanelState;
    onToggle(enabled: boolean): void;
    onCopy(): void;
    onDownload(): void;
    onRetry(): void;
};

const FEEDBACK_COLOR_OK = 'green';
const FEEDBACK_COLOR_ERROR = 'red';
const PREVIEW_ROWS = 14;

/**
 * Safe outcome-to-copy mapping; `null` while idle.
 *
 * @param feedback - Last action outcome.
 * @returns Localized feedback text and color.
 */
function getDiagnosticsFeedback(
    feedback: DiagnosticsFeedback | null,
): { message: string; color: string } | null {
    switch (feedback) {
        case 'copied':
            return {
                message: translator.getMessage('options_diagnostics_copied'),
                color: FEEDBACK_COLOR_OK,
            };
        case 'download_started':
            return {
                message: translator.getMessage(
                    'options_diagnostics_download_started',
                ),
                color: FEEDBACK_COLOR_OK,
            };
        case 'copy_failed':
            return {
                message: translator.getMessage(
                    'options_diagnostics_copy_failed',
                ),
                color: FEEDBACK_COLOR_ERROR,
            };
        case 'export_failed':
            return {
                message: translator.getMessage(
                    'options_diagnostics_export_failed',
                ),
                color: FEEDBACK_COLOR_ERROR,
            };
        case 'toggle_failed':
            return {
                message: translator.getMessage(
                    'options_diagnostics_toggle_failed',
                ),
                color: FEEDBACK_COLOR_ERROR,
            };
        case null:
            return null;
    }
}

/**
 * Background timestamps are epoch milliseconds; the section shows them in the
 * reader's locale (the exported bundle keeps UTC).
 *
 * @param ms - Epoch milliseconds, or `null` when unknown.
 * @returns Local date-time text, or `''` when unknown.
 */
function formatLocalTime(ms: number | null): string {
    return ms === null ? '' : new Date(ms).toLocaleString();
}

/**
 * Total of all dropped-event reasons for the one-line counter.
 *
 * @param dropped - Per-reason counters.
 * @returns Sum of the counters.
 */
function countDropped(dropped: DebugLogDroppedCounters): number {
    return (
        dropped.incognito +
        dropped.coalesced +
        dropped.ceiling +
        dropped.unreachable +
        dropped.lost
    );
}

/**
 * One localized line describing the switch and store for the current phase.
 *
 * @param phase - Current phase.
 * @param status - Last status, when known.
 * @returns Localized status line.
 */
function getStatusLine(
    phase: DiagnosticsPhase,
    status: DebugLogStatusPayload | null,
): string {
    switch (phase) {
        case DIAGNOSTICS_PHASE.Loading:
            return translator.getMessage('options_diagnostics_state_loading');
        case DIAGNOSTICS_PHASE.Unavailable:
            return translator.getMessage(
                'options_diagnostics_state_unavailable',
            );
        case DIAGNOSTICS_PHASE.OffEmpty:
            return translator.getMessage(
                'options_diagnostics_state_off_empty',
            );
        case DIAGNOSTICS_PHASE.On:
            return translator.getMessage('options_diagnostics_state_on', {
                since: formatLocalTime(status?.enabledAtMs ?? null),
            });
        case DIAGNOSTICS_PHASE.OffStored:
            return translator.getMessage(
                'options_diagnostics_state_off_stored',
                {
                    count: String(status?.eventCount ?? 0),
                    size: formatBinarySize(status?.sizeBytes ?? 0),
                    time: formatLocalTime(status?.disabledAtMs ?? null),
                },
            );
    }
}

/**
 * Live counters shown while a log is stored (incognito drops included so the
 * exclusion is visible to the user).
 *
 * @param props - Status to render.
 * @returns Counter lines.
 */
function DiagnosticsCounters(props: {
    status: DebugLogStatusPayload;
}): ReactElement {
    const { status } = props;
    return (
        <Stack gap={2}>
            <Text size="sm">
                {translator.getMessage('options_diagnostics_counter_events', {
                    count: String(status.eventCount),
                })}
            </Text>
            <Text size="sm">
                {translator.getMessage('options_diagnostics_counter_size', {
                    size: formatBinarySize(status.sizeBytes),
                    cap: formatBinarySize(status.capBytes),
                })}
            </Text>
            <Text size="sm">
                {translator.getMessage('options_diagnostics_counter_evicted', {
                    count: String(status.evictedCount),
                })}
            </Text>
            <Text size="sm">
                {translator.getMessage('options_diagnostics_counter_dropped', {
                    count: String(countDropped(status.dropped)),
                    incognito: String(status.dropped.incognito),
                    coalesced: String(status.dropped.coalesced),
                    ceiling: String(status.dropped.ceiling),
                    unreachable: String(status.dropped.unreachable),
                    lost: String(status.dropped.lost),
                })}
            </Text>
        </Stack>
    );
}

/**
 * Read-only, left-to-right monospace tail that scrolls inside its own box so
 * the page never scrolls horizontally; a note says when it is a tail.
 *
 * @param props - Preview to render.
 * @returns Preview block.
 */
function DiagnosticsPreviewBlock(props: {
    preview: DiagnosticsPreview;
}): ReactElement {
    const { preview } = props;
    const truncated = preview.shownBytes < preview.totalBytes;
    return (
        <Stack gap={4}>
            <Text size="sm" fw={700}>
                {translator.getMessage('options_diagnostics_preview_heading')}
            </Text>
            {truncated ? (
                <Text size="xs" c="dimmed">
                    {translator.getMessage(
                        'options_diagnostics_preview_truncated',
                        {
                            shown: formatBinarySize(preview.shownBytes),
                            total: formatBinarySize(preview.totalBytes),
                        },
                    )}
                </Text>
            ) : null}
            <Textarea
                data-testid="options-debug-log-preview"
                aria-label={translator.getMessage(
                    'options_diagnostics_preview_aria',
                )}
                value={preview.text}
                readOnly
                dir="ltr"
                wrap="off"
                spellCheck={false}
                rows={PREVIEW_ROWS}
                resize="vertical"
                styles={{
                    input: {
                        fontFamily: 'var(--mantine-font-family-monospace)',
                        fontSize: 'var(--mantine-font-size-xs)',
                        whiteSpace: 'pre',
                        overflow: 'auto',
                        direction: 'ltr',
                        textAlign: 'left',
                    },
                }}
            />
        </Stack>
    );
}

/**
 * Diagnostics section: the Debug logging switch with its privacy, storage and
 * sharing copy visible in every phase, the live status line and counters, the
 * read-only preview tail and the Copy/Download exports. Purely presentational;
 * the container owns reads, writes and feedback.
 *
 * @param props - Resolved state plus action callbacks.
 * @returns Localized Diagnostics section.
 */
export function DiagnosticsPanel(props: DiagnosticsPanelProps): ReactElement {
    const { phase, status, preview, feedback, busy } = props.state;
    const capLabel = formatBinarySize(status?.capBytes ?? DEBUG_LOG_CAP_BYTES);
    const switchDisabled = busy || !canToggleDebugLogging(phase);
    const exportDisabled = busy || !canExportDebugLog(phase);
    const feedbackView = getDiagnosticsFeedback(feedback);
    const statusLine = getStatusLine(phase, status);

    return (
        <Stack gap="md" maw={640} data-testid="options-diagnostics-section">
            <Title order={2}>
                {translator.getMessage('options_diagnostics_heading')}
            </Title>
            <Paper p="md" radius="md" withBorder>
                <Stack gap="sm">
                    <Switch
                        data-testid="options-debug-log-switch"
                        label={translator.getMessage(
                            'options_diagnostics_switch_label',
                        )}
                        checked={status?.enabled === true}
                        disabled={switchDisabled}
                        onChange={(event) => {
                            props.onToggle(event.currentTarget.checked);
                        }}
                    />
                    {phase === DIAGNOSTICS_PHASE.Unavailable ? (
                        <Group gap="sm" wrap="nowrap" align="center">
                            <Alert
                                color="error"
                                role="alert"
                                data-testid="options-debug-log-status"
                                style={{ flex: 1 }}
                            >
                                {statusLine}
                            </Alert>
                            <Button
                                variant="light"
                                onClick={() => {
                                    props.onRetry();
                                }}
                            >
                                {translator.getMessage(
                                    'options_diagnostics_retry_button',
                                )}
                            </Button>
                        </Group>
                    ) : (
                        <Text
                            size="sm"
                            role="status"
                            data-testid="options-debug-log-status"
                        >
                            {statusLine}
                        </Text>
                    )}
                    {phase === DIAGNOSTICS_PHASE.OffStored ? (
                        <Text size="xs" c="dimmed">
                            {translator.getMessage(
                                'options_diagnostics_restart_note',
                            )}
                        </Text>
                    ) : null}
                    <Alert color="slate" role="note">
                        <Stack gap={4}>
                            <Text size="sm">
                                {translator.getMessage(
                                    'options_diagnostics_notice',
                                )}
                            </Text>
                            <Text size="sm">
                                {translator.getMessage(
                                    'options_diagnostics_storage_note',
                                    { cap: capLabel },
                                )}
                            </Text>
                        </Stack>
                    </Alert>
                    <Text size="sm" c="dimmed">
                        {translator.getMessage('options_diagnostics_sharing')}
                    </Text>
                </Stack>
            </Paper>
            {status !== null && canExportDebugLog(phase) ? (
                <DiagnosticsCounters status={status} />
            ) : null}
            {preview !== null && canExportDebugLog(phase) ? (
                <DiagnosticsPreviewBlock preview={preview} />
            ) : null}
            <Group gap="sm">
                <Button
                    data-testid="options-debug-log-copy"
                    disabled={exportDisabled}
                    onClick={() => {
                        props.onCopy();
                    }}
                >
                    {translator.getMessage('options_diagnostics_copy_button')}
                </Button>
                <Button
                    data-testid="options-debug-log-download"
                    variant="light"
                    disabled={exportDisabled}
                    onClick={() => {
                        props.onDownload();
                    }}
                >
                    {translator.getMessage(
                        'options_diagnostics_download_button',
                    )}
                </Button>
            </Group>
            {feedbackView === null ? null : (
                <Text
                    size="xs"
                    c={feedbackView.color}
                    role="status"
                    data-testid="options-debug-log-feedback"
                >
                    {feedbackView.message}
                </Text>
            )}
        </Stack>
    );
}
