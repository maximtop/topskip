import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { ANALYSIS_MODE } from '@/shared/constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    SERVER_FAILURE_REPORT_ACTION,
    getServerFailureReportAction,
} from '@/shared/server-analysis-failure';
import type {
    OpenServerAnalysisIssueResponse,
    ServerAnalysisFailureContext,
} from '@/shared/messages';

const DEFAULT_SUPPORT_ISSUE_BASE_URL =
    'https://github.com/maximtop/topskip/issues/new';
const GITHUB_HOSTNAME = 'github.com';
const GITHUB_NEW_ISSUE_PATH_PATTERN = /^\/[^/]+\/[^/]+\/issues\/new\/?$/u;
const REPORT_UNAVAILABLE_ERROR = 'Server issue reporting is unavailable.';

/**
 * Added to the issue body only while a debug log exists; the log itself is
 * never embedded, the user attaches the export by hand.
 */
export const DEBUG_LOG_ISSUE_HINT_LINE =
    'If you enabled Debug logging in Options → Diagnostics, you can attach ' +
    'the exported log (it lists the video IDs you watched while logging; ' +
    'review it first).';

/**
 * Opens sanitized server diagnostics without trusting popup-provided fields;
 * static API only.
 */
export class ServerAnalysisIssueReport {
    /**
     * Validates the configured GitHub destination and attaches allow-listed
     * diagnostic fields only; a hint to attach the exported debug log is added
     * when one exists.
     *
     * @param input - Trusted background state and deterministic report time.
     * @returns Prefilled GitHub URL, or `null` for an unsafe destination.
     */
    static buildUrl(input: {
        baseUrl: string;
        failure: ServerAnalysisFailureContext;
        now: Date;
        hasDebugLog: boolean;
    }): string | null {
        let url: URL;
        try {
            url = new URL(input.baseUrl);
        } catch {
            return null;
        }
        if (
            url.protocol !== 'https:' ||
            url.hostname !== GITHUB_HOSTNAME ||
            url.port !== '' ||
            url.username !== '' ||
            url.password !== '' ||
            !GITHUB_NEW_ISSUE_PATH_PATTERN.test(url.pathname)
        ) {
            return null;
        }

        const diagnosticLines = [
            'TopSkip server analysis failed.',
            '',
            `Error code: ${input.failure.code}`,
            ...(input.failure.supportId === undefined
                ? []
                : [`Support ID: ${input.failure.supportId}`]),
            `API version: ${input.failure.apiVersion}`,
            ...(input.failure.algorithmVersion === undefined
                ? []
                : [`Algorithm version: ${input.failure.algorithmVersion}`]),
            `Extension version: ${input.failure.extensionVersion}`,
            `UTC timestamp: ${input.now.toISOString()}`,
            '',
            'Please add the video link manually if you want to share it.',
            ...(input.hasDebugLog ? [DEBUG_LOG_ISSUE_HINT_LINE] : []),
        ];
        url.hash = '';
        url.search = '';
        url.searchParams.set('title', `[TopSkip server] ${input.failure.code}`);
        url.searchParams.set('body', diagnosticLines.join('\n'));
        return url.toString();
    }

    /**
     * Reads the active tab’s trusted failure and opens its safe GitHub report;
     * the opening is logged with the failure code and support id only (the
     * facade drops it when the active tab is incognito).
     *
     * @returns Runtime acknowledgement for the popup.
     */
    static async handleOpen(): Promise<OpenServerAnalysisIssueResponse> {
        await PrefsSyncStorage.ready();
        try {
            const prefs = await PrefsSyncStorage.load();
            if (prefs.analysisMode !== ANALYSIS_MODE.Server) {
                return { ok: false, error: REPORT_UNAVAILABLE_ERROR };
            }

            const tabs = await browser.tabs.query({
                active: true,
                currentWindow: true,
            });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
                return { ok: false, error: REPORT_UNAVAILABLE_ERROR };
            }
            await PromoDetectionStore.ready();
            const state = PromoDetectionStore.get(tabId);
            if (
                state?.source !== 'server' ||
                state.serverFailure === undefined ||
                getServerFailureReportAction(state.serverFailure.code) ===
                    SERVER_FAILURE_REPORT_ACTION.None
            ) {
                return { ok: false, error: REPORT_UNAVAILABLE_ERROR };
            }

            const hasDebugLog = await DebugLogStore.hasLog();
            const url = ServerAnalysisIssueReport.buildUrl({
                baseUrl:
                    state.serverFailure.supportIssueBaseUrl ??
                    DEFAULT_SUPPORT_ISSUE_BASE_URL,
                failure: state.serverFailure,
                now: new Date(),
                hasDebugLog,
            });
            if (url === null) {
                return { ok: false, error: REPORT_UNAVAILABLE_ERROR };
            }
            await browser.tabs.create({ url });
            DebugLog.record(
                DEBUG_LOG_EVENT.IssueReportOpened,
                { failureCode: state.serverFailure.code },
                { tab: tabId, support: state.serverFailure.supportId },
            );
            return { ok: true };
        } catch {
            return { ok: false, error: REPORT_UNAVAILABLE_ERROR };
        }
    }
}
