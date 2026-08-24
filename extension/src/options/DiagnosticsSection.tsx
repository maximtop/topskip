import { type ReactElement, useEffect, useRef, useState } from 'react';

import { DebugLogExportActions } from '@/options/debug-log-export-actions';
import {
    DiagnosticsPanel,
    type DiagnosticsFeedback,
    type DiagnosticsPreview,
} from '@/options/DiagnosticsPanel';
import { DiagnosticsRefreshLoop } from '@/options/diagnostics-refresh-loop';
import {
    requestDebugLogBundle,
    requestSetDebugLogging,
} from '@/options/diagnostics-request';
import { toDiagnosticsPhase } from '@/options/diagnostics-state';
import browser from '@/shared/browser';
import { buildDebugLogFileName } from '@/shared/debug-log-format';
import {
    TOPSKIP_MESSAGE,
    pickMessage,
    type DebugLogStatusPayload,
} from '@/shared/messages';

/**
 * Owns the Diagnostics state independently of the General section: a bounded
 * status cadence runs only while this component is mounted (the section is
 * visible), the preview tail is re-read only when the store revision moved,
 * and Copy/Download request a fresh bundle snapshot on every press — the page
 * never holds a full-bundle copy between clicks. The background reply is
 * authoritative for the switch; nothing here logs.
 *
 * @returns Diagnostics section bound to the background.
 */
export function DiagnosticsSection(): ReactElement {
    const [status, setStatus] = useState<DebugLogStatusPayload | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
    const [feedback, setFeedback] = useState<DiagnosticsFeedback | null>(null);
    const [busy, setBusy] = useState(false);
    const loopRef = useRef<DiagnosticsRefreshLoop | null>(null);

    useEffect(() => {
        const loop = new DiagnosticsRefreshLoop({
            onStatus: (nextStatus) => {
                setStatus(nextStatus);
                setUnavailable(false);
            },
            onPreview: (nextPreview) => {
                setPreview(nextPreview);
            },
            onUnavailable: () => {
                setUnavailable(true);
            },
        });
        loopRef.current = loop;
        const onRuntimeMessage = (message: unknown): void => {
            const pushed = pickMessage(
                TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                message,
            );
            if (pushed !== undefined) {
                loop.refreshNow();
            }
        };
        browser.runtime.onMessage.addListener(onRuntimeMessage);
        loop.refreshNow();
        return () => {
            browser.runtime.onMessage.removeListener(onRuntimeMessage);
            loop.stop();
            loopRef.current = null;
        };
    }, []);

    const onToggle = async (enabled: boolean): Promise<void> => {
        if (busy) {
            return;
        }
        setFeedback(null);
        setBusy(true);
        try {
            const nextStatus = await requestSetDebugLogging(enabled);
            setStatus(nextStatus);
            setUnavailable(false);
            // The store revision moved, so the loop re-reads the preview tail.
            loopRef.current?.refreshNow();
        } catch {
            setFeedback('toggle_failed');
        } finally {
            setBusy(false);
        }
    };

    const onCopy = async (): Promise<void> => {
        if (busy) {
            return;
        }
        setFeedback(null);
        setBusy(true);
        try {
            const bundle = await requestDebugLogBundle();
            const copied = await DebugLogExportActions.copy(bundle.text);
            setFeedback(copied ? 'copied' : 'copy_failed');
        } catch {
            setFeedback('export_failed');
        } finally {
            setBusy(false);
        }
    };

    const onDownload = async (): Promise<void> => {
        if (busy) {
            return;
        }
        setFeedback(null);
        setBusy(true);
        try {
            const bundle = await requestDebugLogBundle();
            DebugLogExportActions.download(
                bundle.text,
                buildDebugLogFileName(new Date(bundle.exportedAtMs)),
            );
            setFeedback('download_started');
        } catch {
            setFeedback('export_failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <DiagnosticsPanel
            state={{
                phase: toDiagnosticsPhase(status, unavailable),
                status,
                preview,
                feedback,
                busy,
            }}
            onToggle={(enabled) => {
                void onToggle(enabled);
            }}
            onCopy={() => {
                void onCopy();
            }}
            onDownload={() => {
                void onDownload();
            }}
            onRetry={() => {
                loopRef.current?.refreshNow();
            }}
        />
    );
}
