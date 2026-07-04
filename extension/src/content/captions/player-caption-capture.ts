import {
    createCaptureSession,
    shouldIgnoreCapturedTimedtext,
} from '@/content/captions/caption-capture-state';
import { contentLog } from '@/content/content-log';
import type {
    CaptionCaptureSession,
    CapturedTimedtextUrlShape,
    CapturedTimedtextPayload,
} from '@/content/captions/caption-capture-types';
import browser from '@/shared/browser';
import { parseTranscriptJson3 } from '@/shared/captions/transcript-json3';
import { CAPTION_CAPTURE_VERBOSE_LOGS } from '@/shared/constants';
import {
    CAPTION_CAPTURE_FAILURE_REASON,
    TOPSKIP_MESSAGE,
    type CaptionCaptureFailureReason,
} from '@/shared/messages';

const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
const ACTIVATION_RETRY_DELAY_MS = 250;
const MAX_ACTIVATION_ATTEMPTS = 6;
const PAGE_SOURCE = 'TOPSKIP_CAPTION_CAPTURE_PAGE';
const PAGE_EVENT = 'topskip:caption-capture-page';

/**
 * Optional timing knobs for caption capture tests and runtime calls.
 */
type CaptureOptions = {
    captureTimeoutMs?: number;
};

/**
 * Terminal wait result for a caption capture attempt.
 */
type CaptureWaitResult =
    | { kind: 'captured' }
    | { kind: 'timeout' }
    | { kind: 'failed' };

/**
 * Pending capture promise and timeout tied to the active session.
 */
type ActiveCaptureWait = {
    session: CaptionCaptureSession;
    timeoutId: ReturnType<typeof setTimeout>;
    resolve: (result: CaptureWaitResult) => void;
};

/**
 * Background bridge command names used by the content orchestrator.
 */
type BridgeCommandName = 'activate-captions' | 'deactivate-captions';

/**
 * Safe diagnostic fields forwarded from page-world capture.
 */
type PageDiagnosticDetails = {
    stage: string;
    videoId?: string | null;
    languageCode?: string | null;
    transport?: string;
    status?: number;
    bodyLength?: number;
    contentType?: string | null;
    urlShape?: CapturedTimedtextUrlShape;
    ok?: boolean;
    reason?: string;
    error?: string;
    wasOn?: boolean | null;
    userIntervened?: boolean;
    buttonPressed?: string | null;
    hideStylePresent?: boolean;
    hasTracks?: number | null;
    actions?: string[];
};

/**
 * Failure payload returned by bridge command handlers.
 */
type BridgeCommandFailure = {
    ok: false;
    reason: CaptionCaptureFailureReason;
    error: string;
};

/**
 * Optional bridge command details used for cleanup diagnostics.
 */
type BridgeCommandDetails = {
    ok?: boolean;
    wasOn?: boolean | null;
    userIntervened?: boolean;
    hasTracks?: number | null;
    actions?: string[];
};

/**
 * Coordinates player-mediated caption capture from the content script.
 */
export class PlayerCaptionCapture {
    /**
     * Last video id scheduled in this document, used to suppress duplicate work.
     */
    private static scheduledVideoId: string | null = null;

    /**
     * Active per-video capture session for page-world events.
     */
    private static activeSession: CaptionCaptureSession | null = null;

    /**
     * Active waiter resolved by capture, parse failure, or timeout.
     */
    private static activeWait: ActiveCaptureWait | null = null;

    /**
     * Successful payload ids already sent from this document.
     */
    private static readonly sentVideoIds = new Set<string>();

    /**
     * Avoids adding duplicate window message listeners after SPA navigation.
     */
    private static listenerInstalled = false;

    /**
     * Prevents multiple cleanup commands for the same active session.
     */
    private static cleanupStarted = false;

    /**
     * Shared bridge install request so document-start setup and capture reuse it.
     */
    private static bridgeInstallPromise: Promise<unknown> | null = null;

    /**
     * Schedules capture for a stable watch video id and clears state off-watch.
     *
     * @param videoId Current watch video id, or `null` when leaving watch.
     * @param source Diagnostic trigger name for manual smoke logs.
     */
    static scheduleForVideoId(
        videoId: string | null,
        source = 'unknown',
    ): void {
        if (videoId === null) {
            PlayerCaptionCapture.log('schedule-clear', { source });
            PlayerCaptionCapture.scheduledVideoId = null;
            if (PlayerCaptionCapture.activeSession !== null) {
                void PlayerCaptionCapture.cleanupActiveSession();
            }
            return;
        }
        if (PlayerCaptionCapture.scheduledVideoId === videoId) {
            PlayerCaptionCapture.log('schedule-duplicate', { videoId, source });
            return;
        }
        if (PlayerCaptionCapture.scheduledVideoId !== null) {
            PlayerCaptionCapture.log('schedule-replace', {
                videoId,
                source,
                previousVideoId: PlayerCaptionCapture.scheduledVideoId,
            });
            void PlayerCaptionCapture.cleanupActiveSession();
        }
        PlayerCaptionCapture.log('schedule-start', { videoId, source });
        PlayerCaptionCapture.scheduledVideoId = videoId;
        void PlayerCaptionCapture.captureForVideoId(videoId).catch(
            () => undefined,
        );
    }

    /**
     * Exposes scheduling state to focused unit tests without adding runtime UI.
     *
     * @returns The video id currently scheduled for capture.
     */
    static getScheduledVideoIdForTest(): string | null {
        return PlayerCaptionCapture.scheduledVideoId;
    }

    /**
     * Resets document-scoped capture state for isolated unit tests.
     */
    static resetForTest(): void {
        PlayerCaptionCapture.scheduledVideoId = null;
        PlayerCaptionCapture.activeSession = null;
        PlayerCaptionCapture.activeWait = null;
        PlayerCaptionCapture.sentVideoIds.clear();
        PlayerCaptionCapture.listenerInstalled = false;
        PlayerCaptionCapture.cleanupStarted = false;
        PlayerCaptionCapture.bridgeInstallPromise = null;
    }

    /**
     * Installs page-world capture hooks before YouTube caches request APIs.
     */
    static installBridgeForPage(): void {
        PlayerCaptionCapture.ensureMessageListener();
        PlayerCaptionCapture.log('bridge-install-requested');
        void PlayerCaptionCapture.getOrInstallBridge().catch(() => undefined);
    }

    /**
     * Starts a bounded caption capture attempt for a YouTube watch video.
     *
     * @param videoId Current YouTube watch video id.
     * @param options Capture timing overrides used by tests and future callers.
     * @returns Resolves after capture succeeds or reports a bounded failure.
     */
    static async captureForVideoId(
        videoId: string,
        options: CaptureOptions = {},
    ): Promise<void> {
        PlayerCaptionCapture.ensureMessageListener();
        const session = createCaptureSession(
            videoId,
            options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
        );
        PlayerCaptionCapture.activeSession = session;
        PlayerCaptionCapture.cleanupStarted = false;
        const waitForCapture = PlayerCaptionCapture.waitForCapture(session);
        PlayerCaptionCapture.log('capture-start', {
            videoId,
            captureTimeoutMs: session.captureTimeoutMs,
            activationId: session.activationId,
        });

        try {
            const installResult: unknown =
                await PlayerCaptionCapture.getOrInstallBridge();
            if (PlayerCaptionCapture.isInstallFailure(installResult)) {
                PlayerCaptionCapture.log('bridge-install-failed', {
                    videoId,
                    error: installResult.error,
                });
                PlayerCaptionCapture.resolveActiveWait({ kind: 'failed' });
                await PlayerCaptionCapture.sendFailure(
                    videoId,
                    CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
                    installResult.error,
                    { stage: 'installing' },
                );
                return;
            }
            PlayerCaptionCapture.log('bridge-installed', { videoId });
            const activated =
                await PlayerCaptionCapture.activateCaptions(videoId);
            if (!activated) {
                PlayerCaptionCapture.resolveActiveWait({ kind: 'failed' });
                return;
            }
            const result = await waitForCapture;
            if (result.kind === 'timeout') {
                PlayerCaptionCapture.log('capture-timeout', {
                    videoId,
                    captureTimeoutMs: session.captureTimeoutMs,
                });
                await PlayerCaptionCapture.sendFailure(
                    videoId,
                    CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout,
                    'Caption capture timed out',
                    { stage: 'waiting-capture' },
                );
            }
        } finally {
            await PlayerCaptionCapture.cleanupActiveSession();
            PlayerCaptionCapture.activeSession = null;
            PlayerCaptionCapture.activeWait = null;
            PlayerCaptionCapture.cleanupStarted = false;
        }
    }

    /**
     * Installs the document message listener once per content-script lifetime.
     */
    private static ensureMessageListener(): void {
        if (PlayerCaptionCapture.listenerInstalled) {
            return;
        }
        if (typeof window === 'undefined') {
            return;
        }
        PlayerCaptionCapture.listenerInstalled = true;
        window.addEventListener('message', (event: MessageEvent<unknown>) => {
            PlayerCaptionCapture.onWindowMessage(event);
        });
        if (typeof document !== 'undefined') {
            document.addEventListener(PAGE_EVENT, (event: Event) => {
                PlayerCaptionCapture.onDocumentMessage(event);
            });
        }
    }

    /**
     * Installs the page bridge once per content-script lifetime.
     *
     * @returns Runtime response from the background install handler.
     */
    private static getOrInstallBridge(): Promise<unknown> {
        PlayerCaptionCapture.bridgeInstallPromise ??=
            browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE,
            });
        return PlayerCaptionCapture.bridgeInstallPromise;
    }

    /**
     * Handles page bridge events and command replies.
     *
     * @param event Window message from the page bridge.
     */
    private static onWindowMessage(event: MessageEvent<unknown>): void {
        PlayerCaptionCapture.onPageBridgeMessage(event.data);
    }

    /**
     * Handles page bridge events sent through DOM events for Chrome worlds.
     *
     * @param event DOM event from the page bridge.
     */
    private static onDocumentMessage(event: Event): void {
        if (!(event instanceof CustomEvent)) {
            return;
        }
        PlayerCaptionCapture.onPageBridgeMessage(
            PlayerCaptionCapture.parseBridgeEventDetail(event.detail),
        );
    }

    /**
     * Converts event detail back to untrusted bridge data.
     *
     * @param value DOM event detail.
     * @returns Parsed bridge data, or `null` when malformed.
     */
    private static parseBridgeEventDetail(value: unknown): unknown {
        if (typeof value !== 'string') {
            return value;
        }
        try {
            return JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }

    /**
     * Handles untrusted page bridge data from any supported transport.
     *
     * @param data Raw page bridge data.
     */
    private static onPageBridgeMessage(data: unknown): void {
        if (data === null || typeof data !== 'object') {
            return;
        }
        if (Reflect.get(data, 'source') !== PAGE_SOURCE) {
            return;
        }
        const kind: unknown = Reflect.get(data, 'kind');
        if (kind !== 'timedtext-capture') {
            if (kind === 'diagnostic') {
                PlayerCaptionCapture.logPageDiagnostic(data);
            }
            return;
        }
        void PlayerCaptionCapture.handleTimedtextCapture(data);
    }

    /**
     * Converts a captured `json3` body into the existing captions payload.
     *
     * @param data Raw page-world timedtext capture message.
     * @returns Resolves after forwarding success/failure to the background.
     */
    private static async handleTimedtextCapture(data: object): Promise<void> {
        const session = PlayerCaptionCapture.activeSession;
        if (session === null) {
            PlayerCaptionCapture.log('capture-event-ignored', {
                reason: 'no-active-session',
            });
            return;
        }
        const videoId: unknown = Reflect.get(data, 'videoId');
        const languageCode: unknown = Reflect.get(data, 'languageCode');
        const body: unknown = Reflect.get(data, 'body');
        const contentType: unknown = Reflect.get(data, 'contentType');
        const bodyLength: unknown = Reflect.get(data, 'bodyLength');
        const urlShape: unknown = Reflect.get(data, 'urlShape');
        if (
            typeof videoId !== 'string' ||
            typeof languageCode !== 'string' ||
            typeof body !== 'string' ||
            (contentType !== null && typeof contentType !== 'string') ||
            typeof bodyLength !== 'number' ||
            !PlayerCaptionCapture.isUrlShape(urlShape)
        ) {
            PlayerCaptionCapture.log('capture-event-ignored', {
                videoId: session.videoId,
                reason: 'malformed-page-message',
            });
            return;
        }

        const payload: CapturedTimedtextPayload = {
            videoId,
            languageCode,
            body,
            contentType,
            bodyLength,
            urlShape,
        };
        PlayerCaptionCapture.log('capture-event-received', {
            videoId,
            activeVideoId: session.videoId,
            languageCode,
            bodyLength,
            contentType,
            urlShape,
        });
        if (shouldIgnoreCapturedTimedtext(session, payload)) {
            PlayerCaptionCapture.resolveActiveWait({ kind: 'failed' });
            await PlayerCaptionCapture.sendFailure(
                session.videoId,
                CAPTION_CAPTURE_FAILURE_REASON.StaleVideo,
                'Captured captions belonged to a different video',
                { stage: 'waiting-capture', urlShape },
            );
            return;
        }
        if (PlayerCaptionCapture.sentVideoIds.has(videoId)) {
            PlayerCaptionCapture.log('capture-event-ignored', {
                videoId,
                reason: 'duplicate-success',
            });
            return;
        }

        const parsed = parseTranscriptJson3(body);
        if (!parsed.ok) {
            PlayerCaptionCapture.log('capture-parse-failed', {
                videoId,
                languageCode,
                bodyLength,
                urlShape,
                error: parsed.error,
            });
            PlayerCaptionCapture.resolveActiveWait({ kind: 'failed' });
            await PlayerCaptionCapture.sendFailure(
                videoId,
                CAPTION_CAPTURE_FAILURE_REASON.ParseFailed,
                parsed.error,
                {
                    stage: 'parsing',
                    bodyLength,
                    languageCode,
                    urlShape,
                },
            );
            return;
        }

        PlayerCaptionCapture.sentVideoIds.add(videoId);
        PlayerCaptionCapture.log('capture-parsed', {
            videoId,
            languageCode,
            bodyLength,
            segmentCount: parsed.segments.length,
            urlShape,
        });
        await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: true,
                videoId,
                languageCode,
                segments: parsed.segments,
                diagnostics: {
                    stage: 'parsed',
                    bodyLength,
                    segmentCount: parsed.segments.length,
                    languageCode,
                    urlShape,
                },
            },
        });
        PlayerCaptionCapture.resolveActiveWait({ kind: 'captured' });
    }

    /**
     * Narrows sanitized URL shape from page messages without accepting values.
     *
     * @param value Untrusted page bridge value.
     * @returns Whether the value is safe URL-shape metadata.
     */
    private static isUrlShape(
        value: unknown,
    ): value is CapturedTimedtextUrlShape {
        if (value === null || typeof value !== 'object') {
            return false;
        }
        const pathname: unknown = Reflect.get(value, 'pathname');
        const paramNames: unknown = Reflect.get(value, 'paramNames');
        const fmt: unknown = Reflect.get(value, 'fmt');
        const hasPot: unknown = Reflect.get(value, 'hasPot');
        return (
            typeof pathname === 'string' &&
            Array.isArray(paramNames) &&
            paramNames.every((item) => typeof item === 'string') &&
            (fmt === null || typeof fmt === 'string') &&
            typeof hasPot === 'boolean'
        );
    }

    /**
     * Retries activation while the page reports a transient player state.
     *
     * @param videoId Current YouTube watch video id.
     * @returns Whether activation was accepted by the page bridge.
     */
    private static async activateCaptions(videoId: string): Promise<boolean> {
        for (
            let attempt = 1;
            attempt <= MAX_ACTIVATION_ATTEMPTS;
            attempt += 1
        ) {
            PlayerCaptionCapture.log('activation-attempt', {
                videoId,
                attempt,
                maxAttempts: MAX_ACTIVATION_ATTEMPTS,
            });
            const result =
                await PlayerCaptionCapture.runBridgeCommand(
                    'activate-captions',
                );
            const failure = PlayerCaptionCapture.getBridgeFailure(result);
            if (failure === null) {
                PlayerCaptionCapture.log('activation-accepted', {
                    videoId,
                    attempt,
                    ...PlayerCaptionCapture.getBridgeCommandDetails(result),
                });
                return true;
            }
            PlayerCaptionCapture.log('activation-failed', {
                videoId,
                attempt,
                reason: failure.reason,
                error: failure.error,
            });
            const canRetry =
                failure.reason ===
                CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady;
            if (!canRetry || attempt === MAX_ACTIVATION_ATTEMPTS) {
                await PlayerCaptionCapture.sendFailure(
                    videoId,
                    failure.reason,
                    failure.error,
                    { stage: 'activating' },
                );
                return false;
            }
            await PlayerCaptionCapture.delay(ACTIVATION_RETRY_DELAY_MS);
        }
        return false;
    }

    /**
     * Waits until page capture resolves or the bounded timer expires.
     *
     * @param session Active capture session.
     * @returns Capture wait result.
     */
    private static waitForCapture(
        session: CaptionCaptureSession,
    ): Promise<CaptureWaitResult> {
        return new Promise((resolve) => {
            const timeoutId = globalThis.setTimeout(() => {
                PlayerCaptionCapture.resolveActiveWait({ kind: 'timeout' });
            }, session.captureTimeoutMs);
            PlayerCaptionCapture.activeWait = {
                session,
                timeoutId,
                resolve,
            };
        });
    }

    /**
     * Resolves the active capture waiter exactly once.
     *
     * @param result Capture result to send to the waiting run.
     */
    private static resolveActiveWait(result: CaptureWaitResult): void {
        const activeWait = PlayerCaptionCapture.activeWait;
        if (activeWait === null) {
            return;
        }
        globalThis.clearTimeout(activeWait.timeoutId);
        PlayerCaptionCapture.activeWait = null;
        activeWait.resolve(result);
    }

    /**
     * Sends a bridge command through the background's MAIN-world scripting API.
     *
     * @param command Page bridge command name.
     * @returns Bridge command result, or a bounded failure.
     */
    private static async runBridgeCommand(
        command: BridgeCommandName,
    ): Promise<unknown> {
        const messageType =
            command === 'activate-captions'
                ? TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
                : TOPSKIP_MESSAGE.DEACTIVATE_CAPTION_CAPTURE;
        try {
            return await browser.runtime.sendMessage({ type: messageType });
        } catch (error) {
            return {
                ok: false,
                reason: CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
                error: String(error),
            };
        }
    }

    /**
     * Extracts bounded bridge failure details from an untrusted reply.
     *
     * @param result Page bridge command reply payload.
     * @returns Normalized bridge failure, or `null` for successful replies.
     */
    private static getBridgeFailure(
        result: unknown,
    ): BridgeCommandFailure | null {
        if (result === null || typeof result !== 'object') {
            return null;
        }
        if (Reflect.get(result, 'ok') !== false) {
            return null;
        }
        return {
            ok: false,
            reason: PlayerCaptionCapture.normalizeFailureReason(
                Reflect.get(result, 'reason'),
            ),
            error: PlayerCaptionCapture.getFailureError(result),
        };
    }

    /**
     * Detects background bridge-install failures without trusting extra fields.
     *
     * @param result Runtime message response.
     * @returns Whether install failed with a message.
     */
    private static isInstallFailure(
        result: unknown,
    ): result is { ok: false; error: string } {
        if (result === null || typeof result !== 'object') {
            return false;
        }
        return (
            Reflect.get(result, 'ok') === false &&
            typeof Reflect.get(result, 'error') === 'string'
        );
    }

    /**
     * Converts page bridge reason strings to the shared safe reason enum.
     *
     * @param reason Untrusted page bridge reason.
     * @returns Shared caption capture failure reason.
     */
    private static normalizeFailureReason(
        reason: unknown,
    ): CaptionCaptureFailureReason {
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady) {
            return CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.ActivationUnavailable) {
            return CAPTION_CAPTURE_FAILURE_REASON.ActivationUnavailable;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout) {
            return CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.ParseFailed) {
            return CAPTION_CAPTURE_FAILURE_REASON.ParseFailed;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable) {
            return CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.StaleVideo) {
            return CAPTION_CAPTURE_FAILURE_REASON.StaleVideo;
        }
        if (reason === CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed) {
            return CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed;
        }
        return CAPTION_CAPTURE_FAILURE_REASON.ActivationUnavailable;
    }

    /**
     * Keeps page bridge error text bounded and non-sensitive.
     *
     * @param result Untrusted page bridge result.
     * @returns Human-readable failure text.
     */
    private static getFailureError(result: object): string {
        const error: unknown = Reflect.get(result, 'error');
        if (typeof error === 'string' && error.length > 0) {
            return error;
        }
        return 'Caption capture activation failed';
    }

    /**
     * Waits between bounded activation attempts.
     *
     * @param delayMs Delay duration in milliseconds.
     * @returns Resolves after the timer fires.
     */
    private static delay(delayMs: number): Promise<void> {
        return new Promise((resolve) => {
            globalThis.setTimeout(resolve, delayMs);
        });
    }

    /**
     * Sends a bounded failure reason through the existing captions channel.
     *
     * @param videoId Current YouTube watch video id.
     * @param reason Safe failure reason.
     * @param error Human-readable failure message.
     * @param diagnostics Safe metadata for troubleshooting capture failures.
     * @returns Resolves after the message send settles.
     */
    private static async sendFailure(
        videoId: string,
        reason: CaptionCaptureFailureReason,
        error: string,
        diagnostics: {
            stage: string;
            bodyLength?: number;
            languageCode?: string;
            urlShape?: CapturedTimedtextUrlShape;
        },
    ): Promise<void> {
        await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: false,
                videoId,
                reason,
                error,
                diagnostics,
            },
        });
        PlayerCaptionCapture.log('failure-sent', {
            videoId,
            reason,
            error,
            diagnostics,
        });
    }

    /**
     * Best-effort cleanup for temporary page caption state.
     *
     * @returns Resolves after cleanup command is posted.
     */
    private static async cleanupActiveSession(): Promise<void> {
        if (PlayerCaptionCapture.cleanupStarted) {
            return;
        }
        PlayerCaptionCapture.log('cleanup-start', {
            videoId: PlayerCaptionCapture.activeSession?.videoId ?? null,
        });
        PlayerCaptionCapture.cleanupStarted = true;
        const result = await PlayerCaptionCapture.runBridgeCommand(
            'deactivate-captions',
        );
        const failure = PlayerCaptionCapture.getBridgeFailure(result);
        if (failure === null) {
            PlayerCaptionCapture.log('cleanup-finished', {
                videoId: PlayerCaptionCapture.activeSession?.videoId ?? null,
                ...PlayerCaptionCapture.getBridgeCommandDetails(result),
            });
            return;
        }
        PlayerCaptionCapture.log('cleanup-failed', {
            videoId: PlayerCaptionCapture.activeSession?.videoId ?? null,
            reason: failure.reason,
            error: failure.error,
        });
    }

    /**
     * Relays safe page-world bridge diagnostics to the service-worker console.
     *
     * @param data Untrusted page bridge diagnostic message.
     */
    private static logPageDiagnostic(data: object): void {
        const details = PlayerCaptionCapture.getPageDiagnosticDetails(data);
        if (details === null) {
            return;
        }
        PlayerCaptionCapture.log('page:' + details.stage, details);
    }

    /**
     * Whitelists page diagnostic fields so raw URLs and caption bodies stay out.
     *
     * @param data Untrusted page bridge diagnostic message.
     * @returns Safe diagnostic fields, or `null` for malformed messages.
     */
    private static getPageDiagnosticDetails(
        data: object,
    ): PageDiagnosticDetails | null {
        const stage: unknown = Reflect.get(data, 'stage');
        if (typeof stage !== 'string' || stage.length === 0) {
            return null;
        }
        const details: PageDiagnosticDetails = { stage };
        PlayerCaptionCapture.copyOptionalString(data, details, 'transport');
        PlayerCaptionCapture.copyOptionalString(data, details, 'reason');
        PlayerCaptionCapture.copyOptionalString(data, details, 'error');
        PlayerCaptionCapture.copyOptionalString(data, details, 'contentType');
        PlayerCaptionCapture.copyOptionalString(data, details, 'buttonPressed');
        PlayerCaptionCapture.copyOptionalNullableString(
            data,
            details,
            'videoId',
        );
        PlayerCaptionCapture.copyOptionalNullableString(
            data,
            details,
            'languageCode',
        );
        PlayerCaptionCapture.copyOptionalNumber(data, details, 'status');
        PlayerCaptionCapture.copyOptionalNumber(data, details, 'bodyLength');
        PlayerCaptionCapture.copyOptionalNullableNumber(
            data,
            details,
            'hasTracks',
        );
        PlayerCaptionCapture.copyOptionalBoolean(data, details, 'ok');
        PlayerCaptionCapture.copyOptionalBoolean(
            data,
            details,
            'userIntervened',
        );
        PlayerCaptionCapture.copyOptionalBoolean(
            data,
            details,
            'hideStylePresent',
        );
        PlayerCaptionCapture.copyOptionalNullableBoolean(
            data,
            details,
            'wasOn',
        );
        const urlShape: unknown = Reflect.get(data, 'urlShape');
        if (PlayerCaptionCapture.isUrlShape(urlShape)) {
            details.urlShape = urlShape;
        }
        const actions: unknown = Reflect.get(data, 'actions');
        if (
            Array.isArray(actions) &&
            actions.every((item) => typeof item === 'string')
        ) {
            details.actions = actions;
        }
        return details;
    }

    /**
     * Whitelists safe result fields returned by page bridge commands.
     *
     * @param result Untrusted page bridge command result.
     * @returns Safe fields that help prove manual activation behavior.
     */
    private static getBridgeCommandDetails(
        result: unknown,
    ): BridgeCommandDetails {
        const details: BridgeCommandDetails = {};
        if (result === null || typeof result !== 'object') {
            return details;
        }
        const ok: unknown = Reflect.get(result, 'ok');
        if (typeof ok === 'boolean') {
            details.ok = ok;
        }
        const wasOn: unknown = Reflect.get(result, 'wasOn');
        if (wasOn === null || typeof wasOn === 'boolean') {
            details.wasOn = wasOn;
        }
        const userIntervened: unknown = Reflect.get(result, 'userIntervened');
        if (typeof userIntervened === 'boolean') {
            details.userIntervened = userIntervened;
        }
        const hasTracks: unknown = Reflect.get(result, 'hasTracks');
        if (hasTracks === null || typeof hasTracks === 'number') {
            details.hasTracks = hasTracks;
        }
        const actions: unknown = Reflect.get(result, 'actions');
        if (
            Array.isArray(actions) &&
            actions.every((item) => typeof item === 'string')
        ) {
            details.actions = actions;
        }
        return details;
    }

    /**
     * Copies an optional string diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalString(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (typeof value === 'string') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Copies an optional nullable string diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalNullableString(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (value === null || typeof value === 'string') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Copies an optional number diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalNumber(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (typeof value === 'number') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Copies an optional nullable number diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalNullableNumber(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (value === null || typeof value === 'number') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Copies an optional boolean diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalBoolean(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (typeof value === 'boolean') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Copies an optional nullable boolean diagnostic field.
     *
     * @param data Untrusted source object.
     * @param details Safe destination object.
     * @param key Field to copy.
     */
    private static copyOptionalNullableBoolean(
        data: object,
        details: PageDiagnosticDetails,
        key: keyof PageDiagnosticDetails,
    ): void {
        const value: unknown = Reflect.get(data, key);
        if (value === null || typeof value === 'boolean') {
            Reflect.set(details, key, value);
        }
    }

    /**
     * Sends verbose manual-smoke diagnostics through the content log channel.
     *
     * @param stage Capture stage name.
     * @param details Safe structured metadata.
     */
    private static log(
        stage: string,
        details: Record<string, unknown> = {},
    ): void {
        if (!CAPTION_CAPTURE_VERBOSE_LOGS) {
            return;
        }
        contentLog.info('caption-capture', { ...details, stage });
    }
}
