import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn((key: string) => {
                const messages: Record<string, string> = {
                    options_diagnostics_heading: 'Diagnostics',
                    options_diagnostics_switch_label: 'Debug logging',
                    options_diagnostics_notice:
                        'Records which YouTube videos you watched and when (video IDs, times, tab numbers) plus your extension and browser version, OS, language, analysis mode and model. Never captions, transcripts, keys, tokens, cookies or URLs. Incognito windows are not logged.',
                    options_diagnostics_storage_note:
                        'Stored locally up to %cap% (oldest entries are replaced) and kept until Debug logging is turned on again. To discard it, turn Debug logging on and off again.',
                    options_diagnostics_sharing:
                        'Copy the log and paste it into your GitHub issue or support message. Nothing is sent automatically.',
                    options_diagnostics_restart_note:
                        'Turning Debug logging on discards the stored log and starts a new one.',
                    options_diagnostics_state_loading: 'Loading diagnostics…',
                    options_diagnostics_state_on: 'Debug logging on since %since%',
                    options_diagnostics_state_off_stored:
                        'Debug logging off — %count% events stored, %size%, disabled at %time%',
                    options_diagnostics_state_off_empty:
                        'Debug logging off — no log stored',
                    options_diagnostics_state_unavailable:
                        'Diagnostics are unavailable right now.',
                    options_diagnostics_retry_button: 'Retry',
                    options_diagnostics_toggle_failed:
                        'Could not change Debug logging — try again',
                    options_diagnostics_counter_events: 'Events: %count%',
                    options_diagnostics_counter_size: 'Size: %size% of %cap%',
                    options_diagnostics_counter_evicted: 'Evicted: %count%',
                    options_diagnostics_counter_dropped:
                        'Dropped: %count% (incognito %incognito%, coalesced %coalesced%, ceiling %ceiling%, unreachable %unreachable%, lost %lost%)',
                    options_diagnostics_preview_heading: 'Recent log',
                    options_diagnostics_preview_aria: 'Debug log preview',
                    options_diagnostics_preview_truncated:
                        'Showing the last %shown% of %total%',
                    options_diagnostics_copy_button: 'Copy log',
                    options_diagnostics_download_button: 'Download log',
                    options_diagnostics_copied: 'Log copied to the clipboard',
                    options_diagnostics_copy_failed:
                        'Could not copy the log — try again or use Download log',
                    options_diagnostics_export_failed:
                        'Could not read the log — try again',
                    options_diagnostics_download_started: 'Download started',
                };
                return messages[key] ?? key;
            }),
        },
    },
}));

import {
    DiagnosticsPanel,
    type DiagnosticsPanelProps,
    type DiagnosticsPanelState,
} from '@/options/DiagnosticsPanel';
import { DIAGNOSTICS_PHASE } from '@/options/diagnostics-state';
import { DEBUG_LOG_CAP_BYTES } from '@/shared/debug-log-constants';
import { formatBinarySize } from '@/shared/debug-log-format';
import type { DebugLogStatusPayload } from '@/shared/messages';
import { topskipTheme } from '@/shared/theme';

const CAP_LABEL = formatBinarySize(DEBUG_LOG_CAP_BYTES);

const STATUS_ON: DebugLogStatusPayload = {
    enabled: true,
    hasLog: true,
    enabledAtMs: 1_755_856_800_000,
    disabledAtMs: null,
    eventCount: 42,
    sizeBytes: 6_144,
    capBytes: DEBUG_LOG_CAP_BYTES,
    evictedCount: 3,
    oldestRetainedMs: 1_755_856_800_000,
    dropped: { incognito: 1, coalesced: 2, ceiling: 0, unreachable: 4, lost: 0 },
    revision: 7,
};
const STATUS_OFF_STORED: DebugLogStatusPayload = {
    ...STATUS_ON,
    enabled: false,
    disabledAtMs: 1_755_857_000_000,
};
const STATUS_OFF_EMPTY: DebugLogStatusPayload = {
    ...STATUS_OFF_STORED,
    hasLog: false,
    enabledAtMs: null,
    disabledAtMs: null,
    eventCount: 0,
    sizeBytes: 0,
    evictedCount: 0,
    oldestRetainedMs: null,
    dropped: { incognito: 0, coalesced: 0, ceiling: 0, unreachable: 0, lost: 0 },
};
const PREVIEW = {
    text: '2026-08-22T10:00:00.000Z w1#1 bg logging-enabled\n',
    shownBytes: 49,
    totalBytes: 49,
};

/**
 * Renders the panel with no-op callbacks unless overridden.
 *
 * @param state - Panel state under test.
 * @param overrides - Callback overrides.
 * @returns Static markup.
 */
function render(
    state: DiagnosticsPanelState,
    overrides: Partial<DiagnosticsPanelProps> = {},
): string {
    const props: DiagnosticsPanelProps = {
        state,
        onToggle: () => {},
        onCopy: () => {},
        onDownload: () => {},
        onRetry: () => {},
        ...overrides,
    };
    return renderToStaticMarkup(
        createElement(
            MantineProvider,
            { theme: topskipTheme },
            createElement(DiagnosticsPanel, props),
        ),
    );
}

/**
 * Extracts one element's opening tag by test id.
 *
 * @param html - Static markup.
 * @param testId - `data-testid` to find.
 * @returns Opening tag text, or `''` when absent.
 */
function openingTag(html: string, testId: string): string {
    const match = html.match(
        new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`, 'u'),
    );
    return match?.[0] ?? '';
}

const IDLE = { preview: null, feedback: null, busy: false } as const;

describe('DiagnosticsPanel', () => {
    it('off with no log: notice, cap, retention and sharing visible; exports disabled', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.OffEmpty,
            status: STATUS_OFF_EMPTY,
            ...IDLE,
        });

        expect(html).toContain('data-testid="options-diagnostics-section"');
        expect(html).toContain('Incognito windows are not logged.');
        expect(html).toContain(`Stored locally up to ${CAP_LABEL}`);
        expect(html).toContain('turn Debug logging on and off again');
        expect(html).toContain('Nothing is sent automatically.');
        expect(html).toContain('Debug logging off — no log stored');
        const switchTag = openingTag(html, 'options-debug-log-switch');
        expect(switchTag).toContain('role="switch"');
        expect(switchTag).not.toContain('checked=""');
        expect(switchTag).not.toContain('disabled=""');
        expect(html).toContain('>Debug logging<');
        expect(openingTag(html, 'options-debug-log-copy')).toContain('disabled=""');
        expect(openingTag(html, 'options-debug-log-download')).toContain(
            'disabled=""',
        );
        expect(html).not.toContain('data-testid="options-debug-log-preview"');
        expect(html).not.toContain('discards the stored log');
    });

    it('on: switch checked, since-line, counters, preview and enabled exports', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.On,
            status: STATUS_ON,
            ...IDLE,
            preview: PREVIEW,
        });

        expect(openingTag(html, 'options-debug-log-switch')).toContain('checked=""');
        expect(openingTag(html, 'options-debug-log-status')).toContain('role="status"');
        expect(html).toContain('Debug logging on since ');
        expect(html).toContain('Events: 42');
        expect(html).toContain(
            `Size: ${formatBinarySize(6_144)} of ${CAP_LABEL}`,
        );
        expect(html).toContain('Evicted: 3');
        expect(html).toContain(
            'Dropped: 7 (incognito 1, coalesced 2, ceiling 0, unreachable 4, lost 0)',
        );
        const previewTag = openingTag(html, 'options-debug-log-preview');
        expect(previewTag).toContain('<textarea');
        // React's server renderer keeps the `readOnly` prop casing.
        expect(previewTag).toMatch(/readonly=""/iu);
        expect(previewTag).toContain('dir="ltr"');
        expect(previewTag).toContain('wrap="off"');
        expect(previewTag).toContain('aria-label="Debug log preview"');
        expect(html).toContain('w1#1 bg logging-enabled');
        expect(html).toContain('Recent log');
        expect(html).not.toContain('Showing the last');
        expect(openingTag(html, 'options-debug-log-copy')).not.toContain(
            'disabled=""',
        );
        expect(openingTag(html, 'options-debug-log-download')).not.toContain(
            'disabled=""',
        );
    });

    it('off with a stored log: disabled-at line, restart note, exports enabled', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.OffStored,
            status: STATUS_OFF_STORED,
            ...IDLE,
            preview: PREVIEW,
        });

        expect(html).toContain(
            `Debug logging off — 42 events stored, ${formatBinarySize(6_144)}, disabled at `,
        );
        expect(html).toContain('discards the stored log and starts a new one');
        expect(openingTag(html, 'options-debug-log-switch')).not.toContain(
            'checked=""',
        );
        expect(openingTag(html, 'options-debug-log-copy')).not.toContain(
            'disabled=""',
        );
    });

    it('shows the truncation note only when the preview is a tail', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.On,
            status: STATUS_ON,
            ...IDLE,
            preview: { ...PREVIEW, shownBytes: 256 * 1024, totalBytes: 1_258_291 },
        });

        expect(html).toContain(
            `Showing the last ${formatBinarySize(256 * 1024)} of ${formatBinarySize(1_258_291)}`,
        );
    });

    it('loading: status text, switch and exports disabled, notice still visible', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.Loading,
            status: null,
            ...IDLE,
        });

        expect(html).toContain('Loading diagnostics…');
        expect(openingTag(html, 'options-debug-log-switch')).toContain('disabled=""');
        expect(openingTag(html, 'options-debug-log-copy')).toContain('disabled=""');
        expect(html).toContain('Incognito windows are not logged.');
        expect(html).toContain(`Stored locally up to ${CAP_LABEL}`);
    });

    it('unavailable: alert with retry, switch disabled', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.Unavailable,
            status: null,
            ...IDLE,
        });

        const statusTag = openingTag(html, 'options-debug-log-status');
        expect(statusTag).toContain('role="alert"');
        expect(html).toContain('Diagnostics are unavailable right now.');
        expect(html).toContain('>Retry<');
        expect(openingTag(html, 'options-debug-log-switch')).toContain('disabled=""');
        expect(html).toContain('Nothing is sent automatically.');
    });

    it('busy disables the switch and exports even in a ready phase', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.On,
            status: STATUS_ON,
            ...IDLE,
            busy: true,
        });

        expect(openingTag(html, 'options-debug-log-switch')).toContain('disabled=""');
        expect(openingTag(html, 'options-debug-log-copy')).toContain('disabled=""');
        expect(openingTag(html, 'options-debug-log-download')).toContain(
            'disabled=""',
        );
    });

    it.each([
        ['copied', 'Log copied to the clipboard'],
        ['copy_failed', 'Could not copy the log — try again or use Download log'],
        ['download_started', 'Download started'],
        ['toggle_failed', 'Could not change Debug logging — try again'],
        ['export_failed', 'Could not read the log — try again'],
    ] as const)('renders %s feedback', (feedback, text) => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.On,
            status: STATUS_ON,
            ...IDLE,
            feedback,
        });

        const feedbackTag = openingTag(html, 'options-debug-log-feedback');
        expect(feedbackTag).toContain('role="status"');
        expect(html).toContain(text);
    });

    it('renders no feedback line while idle', () => {
        const html = render({
            phase: DIAGNOSTICS_PHASE.On,
            status: STATUS_ON,
            ...IDLE,
        });

        expect(html).not.toContain('data-testid="options-debug-log-feedback"');
    });
});
