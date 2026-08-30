import {
    CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS,
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_DIAGNOSTIC_STAGE,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_KIND,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
    type CaptionPageBridgeCommand,
    parseCaptionPageBridgeCommandRequest,
} from '@/content/captions/caption-page-bridge-contract';
import {
    CAPTION_PAGE_BRIDGE_INSTALL_FLAG,
    CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG,
} from '@/shared/caption-page-bridge-flags';

const INSTALL_FLAG = CAPTION_PAGE_BRIDGE_INSTALL_FLAG;
const TEARDOWN_FLAG = CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG;
const TIMEDTEXT_PATH = '/api/timedtext';
const PLAYER_NOT_READY_REASON = 'player-not-ready';
const ACTIVATION_UNAVAILABLE_REASON = 'activation-unavailable';
const CAPTIONS_UNAVAILABLE_REASON = 'captions-unavailable';
const CAPTIONS_BUTTON_SELECTOR = '.ytp-subtitles-button[aria-pressed]';
const HIDE_STYLE_ID = 'topskip-caption-hide-style';
const CAPTION_HIDE_CSS =
    '#movie_player .ytp-caption-window-container,#movie_player .caption-window{visibility:hidden!important;}';
const CAPTION_MODULE = 'captions';
const CAPTION_RELOAD_OPTION = 'reload';
const CAPTION_TRACK_OPTION = 'track';
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX_EXCLUSIVE = 300;
const VERBOSE_CAPTURE_LOGS =
    typeof __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__ !== 'undefined' &&
    __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__;
const AD_STATE_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-preview-container',
    '.ytp-ad-skip-button-container',
] as const;

/**
 * Sanitized timedtext URL metadata emitted from page-world capture.
 */
type PageBridgeUrlShape = {
    pathname: string;
    paramNames: string[];
    fmt: string | null;
    hasPot: boolean;
};

/**
 * Page-world message carrying a captured json3 timedtext response.
 */
type PageBridgeCaptureMessage = {
    source: typeof CAPTION_PAGE_BRIDGE_SOURCE.Main;
    kind: 'timedtext-capture';
    videoId: string | null;
    languageCode: string | null;
    body: string;
    contentType: string | null;
    bodyLength: number;
    urlShape: PageBridgeUrlShape;
};

/**
 * Page-world diagnostic message for bridge activation/capture stages.
 */
type PageBridgeDiagnosticMessage = {
    source: typeof CAPTION_PAGE_BRIDGE_SOURCE.Main;
    kind: 'diagnostic';
    stage: string;
    videoId?: string | null;
    languageCode?: string | null;
    transport?: 'fetch' | 'xhr';
    status?: number;
    bodyLength?: number;
    contentType?: string | null;
    urlShape?: PageBridgeUrlShape;
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
 * Union of page-world messages accepted by the content script listener.
 */
type PageBridgeMessage = PageBridgeCaptureMessage | PageBridgeDiagnosticMessage;

/**
 * Logical message shared by both page-to-content transports.
 */
type IdentifiedPageBridgeMessage = PageBridgeMessage & {
    messageId: string;
};

/**
 * The first caption state is retained until the entire active period ends.
 */
type CaptionRestoreSnapshot = Readonly<{
    wasOn: boolean;
}>;

/**
 * URL metadata stays outside page-owned XHR objects and disappears with them.
 */
type XhrRequestMetadata = {
    url: string;
};

const installCaptionPageBridge = (): void => {
    const previousTeardown: unknown = Reflect.get(globalThis, TEARDOWN_FLAG);
    if (typeof previousTeardown === 'function') {
        try {
            Reflect.apply(previousTeardown, globalThis, []);
        } catch {
            // Page navigation may invalidate nodes while the old bridge retires.
        }
    }
    Reflect.set(globalThis, INSTALL_FLAG, true);

    const bridgeInstanceId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let nextBridgeMessageSequence = 0;
    let nextCaptureGeneration = 0;
    let activeCaptureGeneration: number | null = null;
    let restoreSnapshot: CaptionRestoreSnapshot | null = null;
    let userIntervened = false;
    let trackedButton: Element | null = null;
    let activeLeaseTimer: ReturnType<typeof setTimeout> | null = null;
    let tornDown = false;

    const isCurrentGeneration = (generation: number): boolean =>
        generation === activeCaptureGeneration;

    const isJson3Timedtext = (rawUrl: string): URL | null => {
        try {
            const parsed = new URL(rawUrl, location.href);
            if (parsed.pathname !== TIMEDTEXT_PATH) {
                return null;
            }
            if (parsed.searchParams.get('fmt') !== 'json3') {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    };

    const getSanitizedUrlShape = (parsed: URL): PageBridgeUrlShape => ({
        pathname: parsed.pathname,
        paramNames: Array.from(parsed.searchParams.keys()).sort(),
        fmt: parsed.searchParams.get('fmt'),
        hasPot: parsed.searchParams.has('pot'),
    });

    const postPageBridgeMessage = (
        message: PageBridgeMessage,
        generation?: number,
    ): void => {
        if (
            generation !== undefined &&
            !isCurrentGeneration(generation)
        ) {
            return;
        }
        nextBridgeMessageSequence += 1;
        const identifiedMessage: IdentifiedPageBridgeMessage = {
            ...message,
            messageId: `${bridgeInstanceId}:${nextBridgeMessageSequence}`,
        };
        try {
            window.postMessage(identifiedMessage, window.location.origin);
        } catch {
            // The DOM event below remains available when cross-world messaging fails.
        }
        if (
            generation !== undefined &&
            !isCurrentGeneration(generation)
        ) {
            return;
        }
        try {
            document.dispatchEvent(
                new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.PageMessage, {
                    detail: JSON.stringify(identifiedMessage),
                }),
            );
        } catch {
            // Capture must not interfere with YouTube when neither transport works.
        }
    };

    const postPageDiagnostic = (
        message: Omit<PageBridgeDiagnosticMessage, 'source' | 'kind'>,
        generation?: number,
    ): void => {
        if (!VERBOSE_CAPTURE_LOGS) {
            return;
        }
        postPageBridgeMessage(
            {
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'diagnostic',
                ...message,
            },
            generation,
        );
    };

    const postTimedtextCapture = (
        generation: number,
        transport: 'fetch' | 'xhr',
        rawUrl: string,
        body: string,
        contentType: string | null,
        status: number,
    ): void => {
        if (!isCurrentGeneration(generation)) {
            return;
        }
        const parsed = isJson3Timedtext(rawUrl);
        if (parsed === null) {
            return;
        }
        const urlShape = getSanitizedUrlShape(parsed);
        postPageDiagnostic(
            {
                stage: 'timedtext-observed',
                transport,
                status,
                bodyLength: body.length,
                contentType,
                videoId: parsed.searchParams.get('v'),
                languageCode: parsed.searchParams.get('lang'),
                urlShape,
            },
            generation,
        );
        if (!isCurrentGeneration(generation)) {
            return;
        }
        if (body.length === 0) {
            postPageBridgeMessage(
                {
                    source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                    kind: 'diagnostic',
                    stage: CAPTION_PAGE_BRIDGE_DIAGNOSTIC_STAGE.TimedtextEmptyBody,
                    transport,
                    status,
                    bodyLength: body.length,
                    videoId: parsed.searchParams.get('v'),
                    languageCode: parsed.searchParams.get('lang'),
                    urlShape,
                },
                generation,
            );
            return;
        }
        if (!body.trimStart().startsWith('{')) {
            postPageDiagnostic(
                {
                    stage: 'timedtext-non-json',
                    transport,
                    status,
                    bodyLength: body.length,
                    contentType,
                    videoId: parsed.searchParams.get('v'),
                    languageCode: parsed.searchParams.get('lang'),
                    urlShape,
                },
                generation,
            );
            return;
        }
        if (!isCurrentGeneration(generation)) {
            return;
        }
        postPageBridgeMessage(
            {
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'timedtext-capture',
                videoId: parsed.searchParams.get('v'),
                languageCode: parsed.searchParams.get('lang'),
                body,
                contentType,
                bodyLength: body.length,
                urlShape,
            },
            generation,
        );
        postPageDiagnostic(
            {
                stage: 'timedtext-forwarded',
                transport,
                status,
                bodyLength: body.length,
                contentType,
                videoId: parsed.searchParams.get('v'),
                languageCode: parsed.searchParams.get('lang'),
                urlShape,
            },
            generation,
        );
    };

    const getMoviePlayer = (): Element | null =>
        document.getElementById('movie_player');

    const getMainVideo = (): HTMLVideoElement | null =>
        document.querySelector('#movie_player video.html5-main-video') ??
        document.querySelector('video.html5-main-video');

    const isVisibleElement = (element: Element): boolean =>
        element instanceof HTMLElement && element.offsetParent !== null;

    const isAdLikelyActive = (): boolean => {
        const player = getMoviePlayer();
        if (player?.classList.contains('ad-showing') === true) {
            return true;
        }
        return AD_STATE_SELECTORS.some((selector) => {
            const element = document.querySelector(selector);
            return element !== null && isVisibleElement(element);
        });
    };

    const isWatchPlayerStable = (): boolean => {
        const player = getMoviePlayer();
        const video = getMainVideo();
        if (player === null || video === null || isAdLikelyActive()) {
            return false;
        }
        return video.readyState >= HTMLMediaElement.HAVE_METADATA;
    };

    const callPlayerMethod = (
        methodName: string,
        args: unknown[] = [],
    ): boolean => {
        const player = getMoviePlayer();
        if (player === null) {
            return false;
        }
        const method: unknown = Reflect.get(player, methodName);
        if (typeof method !== 'function') {
            return false;
        }
        try {
            Reflect.apply(method, player, args);
            return true;
        } catch {
            return false;
        }
    };

    const getPlayerOption = (optionName: string): unknown => {
        const player = getMoviePlayer();
        if (player === null) {
            return null;
        }
        const method: unknown = Reflect.get(player, 'getOption');
        if (typeof method !== 'function') {
            return null;
        }
        try {
            return Reflect.apply(method, player, [CAPTION_MODULE, optionName]);
        } catch {
            return null;
        }
    };

    const setPlayerOption = (optionName: string, value: unknown): boolean => {
        const player = getMoviePlayer();
        if (player === null) {
            return false;
        }
        const method: unknown = Reflect.get(player, 'setOption');
        if (typeof method !== 'function') {
            return false;
        }
        try {
            Reflect.apply(method, player, [CAPTION_MODULE, optionName, value]);
            return true;
        } catch {
            return false;
        }
    };

    const hasPlayerMethod = (methodName: string): boolean => {
        const player = getMoviePlayer();
        return (
            player !== null &&
            typeof Reflect.get(player, methodName) === 'function'
        );
    };

    const ensureHideStyle = (): void => {
        if (document.getElementById(HIDE_STYLE_ID) !== null) {
            return;
        }
        const style = document.createElement('style');
        style.id = HIDE_STYLE_ID;
        style.textContent = CAPTION_HIDE_CSS;
        document.documentElement.append(style);
    };

    const removeHideStyle = (): void => {
        document.getElementById(HIDE_STYLE_ID)?.remove();
    };

    const markUserIntervened = (): void => {
        userIntervened = true;
    };

    const trackUserIntervention = (button: Element): void => {
        if (trackedButton === button) {
            return;
        }
        trackedButton?.removeEventListener('pointerdown', markUserIntervened);
        trackedButton?.removeEventListener('keydown', markUserIntervened);
        trackedButton = button;
        button.addEventListener('pointerdown', markUserIntervened);
        button.addEventListener('keydown', markUserIntervened);
    };

    const untrackUserIntervention = (): void => {
        trackedButton?.removeEventListener('pointerdown', markUserIntervened);
        trackedButton?.removeEventListener('keydown', markUserIntervened);
        trackedButton = null;
    };

    const clearActiveLease = (): void => {
        if (activeLeaseTimer === null) {
            return;
        }
        clearTimeout(activeLeaseTimer);
        activeLeaseTimer = null;
    };

    const restoreCaptionState = (): Record<string, unknown> => {
        const snapshot = restoreSnapshot;
        restoreSnapshot = null;
        const intervened = userIntervened;
        const actions: string[] = [];
        if (snapshot?.wasOn === false && !intervened) {
            if (callPlayerMethod('toggleSubtitlesOff')) {
                actions.push('toggleSubtitlesOff');
            }
            if (setPlayerOption(CAPTION_TRACK_OPTION, {})) {
                actions.push('setOption:track-empty');
            }
            if (callPlayerMethod('unloadModule', [CAPTION_MODULE])) {
                actions.push('unloadModule:captions');
            }
        }
        removeHideStyle();
        actions.push('hide-style-removed');
        untrackUserIntervention();
        userIntervened = false;
        postPageDiagnostic({
            stage: 'cleanup-finished',
            ok: true,
            wasOn: snapshot?.wasOn ?? null,
            userIntervened: intervened,
            hideStylePresent: document.getElementById(HIDE_STYLE_ID) !== null,
            actions,
        });
        return {
            ok: true,
            wasOn: snapshot?.wasOn ?? null,
            userIntervened: intervened,
            actions,
        };
    };

    const deactivateCaptions = (): Record<string, unknown> => {
        activeCaptureGeneration = null;
        clearActiveLease();
        return restoreCaptionState();
    };

    const refreshActiveLease = (): void => {
        clearActiveLease();
        activeLeaseTimer = setTimeout(() => {
            deactivateCaptions();
        }, CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS);
    };

    const failActivation = (
        reason: string,
        error: string,
        actions: string[],
    ): Record<string, unknown> => {
        deactivateCaptions();
        postPageDiagnostic({
            stage: 'activation-blocked',
            ok: false,
            reason,
            error,
            actions,
        });
        return { ok: false, reason, error, actions };
    };

    const finishActivation = (
        generation: number,
        button: Element | null,
        hasTracks: number | null,
        actions: string[],
    ): Record<string, unknown> => {
        if (!isCurrentGeneration(generation)) {
            return {
                ok: false,
                reason: ACTIVATION_UNAVAILABLE_REASON,
                error: 'Caption activation was interrupted',
                actions,
            };
        }
        const wasOn = restoreSnapshot?.wasOn ?? null;
        postPageDiagnostic({
            stage: 'activation-finished',
            ok: true,
            wasOn,
            userIntervened,
            buttonPressed: button?.getAttribute('aria-pressed') ?? null,
            hideStylePresent: document.getElementById(HIDE_STYLE_ID) !== null,
            hasTracks,
            actions,
        });
        return { ok: true, wasOn, userIntervened, hasTracks, actions };
    };

    const activateCaptions = (): Record<string, unknown> => {
        const actions: string[] = [];
        if (!isWatchPlayerStable()) {
            return failActivation(
                PLAYER_NOT_READY_REASON,
                'Watch player is not ready for caption capture',
                actions,
            );
        }
        const button = document.querySelector(CAPTIONS_BUTTON_SELECTOR);
        if (button === null && !hasPlayerMethod('toggleSubtitlesOn')) {
            return failActivation(
                CAPTIONS_UNAVAILABLE_REASON,
                'Caption controls are unavailable',
                actions,
            );
        }

        const isReactivation = activeCaptureGeneration !== null;
        if (!isReactivation) {
            restoreSnapshot = Object.freeze({
                wasOn: button?.getAttribute('aria-pressed') === 'true',
            });
            userIntervened = false;
        }
        nextCaptureGeneration += 1;
        const generation = nextCaptureGeneration;
        activeCaptureGeneration = generation;
        refreshActiveLease();

        if (button !== null) {
            trackUserIntervention(button);
        }
        if (restoreSnapshot?.wasOn === false) {
            ensureHideStyle();
            actions.push('hide-style-added');
        }
        if (callPlayerMethod('loadModule', [CAPTION_MODULE])) {
            actions.push('loadModule:captions');
        }
        const tracks = getPlayerOption('tracklist');
        const hasTracks = Array.isArray(tracks) ? tracks.length : null;
        const captionsCurrentlyOn =
            button?.getAttribute('aria-pressed') === 'true';

        if (isReactivation) {
            if (setPlayerOption(CAPTION_RELOAD_OPTION, true)) {
                actions.push('setOption:reload');
            }
            if (Array.isArray(tracks) && tracks.length > 0) {
                const firstTrack: unknown = Reflect.get(tracks, '0');
                if (setPlayerOption(CAPTION_TRACK_OPTION, firstTrack)) {
                    actions.push('setOption:track');
                }
            }
            if (captionsCurrentlyOn) {
                actions.push('reactivated:already-on');
                return finishActivation(
                    generation,
                    button,
                    hasTracks,
                    actions,
                );
            }
        } else if (restoreSnapshot?.wasOn === true) {
            actions.push('skipped:already-on');
            return finishActivation(
                generation,
                button,
                hasTracks,
                actions,
            );
        }

        if (!isReactivation) {
            if (Array.isArray(tracks) && tracks.length > 0) {
                const firstTrack: unknown = Reflect.get(tracks, '0');
                if (setPlayerOption(CAPTION_TRACK_OPTION, firstTrack)) {
                    actions.push('setOption:track');
                }
            } else if (setPlayerOption(CAPTION_RELOAD_OPTION, true)) {
                actions.push('setOption:reload');
            }
        }

        let activated = false;
        if (callPlayerMethod('toggleSubtitlesOn')) {
            actions.push('toggleSubtitlesOn');
            activated = true;
        } else if (button instanceof HTMLElement) {
            button.click();
            actions.push('button:click');
            activated = true;
        }
        if (!activated) {
            return failActivation(
                ACTIVATION_UNAVAILABLE_REASON,
                'Caption activation is unavailable',
                actions,
            );
        }
        return finishActivation(generation, button, hasTracks, actions);
    };

    const commandHandlers = {
        [CAPTION_PAGE_BRIDGE_COMMAND.Probe]: () => ({ ok: true }),
        [CAPTION_PAGE_BRIDGE_COMMAND.Activate]: activateCaptions,
        [CAPTION_PAGE_BRIDGE_COMMAND.Deactivate]: deactivateCaptions,
        // The acknowledgement still goes out because `onCommand` only checks
        // `tornDown` before dispatching a handler, so an orphaned ISOLATED
        // caller learns the wrappers are gone instead of waiting for timeout.
        [CAPTION_PAGE_BRIDGE_COMMAND.Teardown]: () => {
            teardown();
            return { ok: true };
        },
    } satisfies Record<CaptionPageBridgeCommand, () => unknown>;

    const onCommand = (event: Event): void => {
        if (tornDown) {
            return;
        }
        if (!(event instanceof CustomEvent)) {
            return;
        }
        const request = parseCaptionPageBridgeCommandRequest(event.detail);
        if (request === null) {
            return;
        }
        let result: unknown;
        try {
            result = commandHandlers[request.command]();
        } catch {
            deactivateCaptions();
            result = {
                ok: false,
                reason: ACTIVATION_UNAVAILABLE_REASON,
                error: 'Caption bridge command failed',
            };
        }
        try {
            document.dispatchEvent(
                new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.CommandResult, {
                    detail: JSON.stringify({
                        source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                        kind: CAPTION_PAGE_BRIDGE_KIND.CommandResult,
                        protocolVersion:
                            CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                        requestId: request.requestId,
                        result,
                    }),
                }),
            );
        } catch {
            // A broken page event target must not affect ordinary playback.
        }
    };

    // Captured unbound on purpose: every call site re-supplies the receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalFetch = window.fetch;
    const wrappedFetch: typeof window.fetch = (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const callOriginalFetch = (): Promise<Response> =>
            init === undefined
                ? originalFetch.call(window, input)
                : originalFetch.call(window, input, init);
        const generation = activeCaptureGeneration;
        if (generation === null) {
            return callOriginalFetch();
        }
        let requestUrl = '';
        try {
            requestUrl = input instanceof Request ? input.url : String(input);
        } catch {
            return callOriginalFetch();
        }
        if (isJson3Timedtext(requestUrl) === null) {
            return callOriginalFetch();
        }
        return callOriginalFetch().then((response) => {
            if (!response.ok || !isCurrentGeneration(generation)) {
                return response;
            }
            let clonedResponse: Response;
            try {
                clonedResponse = response.clone();
            } catch {
                return response;
            }
            if (!isCurrentGeneration(generation)) {
                return response;
            }
            void clonedResponse
                .text()
                .then((body) => {
                    if (!isCurrentGeneration(generation)) {
                        return;
                    }
                    postTimedtextCapture(
                        generation,
                        'fetch',
                        response.url || requestUrl,
                        body,
                        response.headers.get('content-type'),
                        response.status,
                    );
                })
                .catch(() => undefined);
            return response;
        });
    };
    window.fetch = wrappedFetch;

    const xhrRequestMetadata = new WeakMap<XMLHttpRequest, XhrRequestMetadata>();
    const originalOpen: unknown = Reflect.get(XMLHttpRequest.prototype, 'open');
    const originalSend: unknown = Reflect.get(XMLHttpRequest.prototype, 'send');
    let wrappedOpen: unknown = null;
    let wrappedSend: unknown = null;

    if (
        typeof originalOpen === 'function' &&
        typeof originalSend === 'function'
    ) {
        wrappedOpen = function (
            this: XMLHttpRequest,
            method: string,
            url: string | URL,
            async = true,
            username?: string | null,
            password?: string | null,
        ): void {
            let requestUrl: string;
            try {
                requestUrl = String(url);
                xhrRequestMetadata.set(this, { url: requestUrl });
            } catch {
                Reflect.apply(originalOpen, this, [method, url, async]);
                return;
            }
            if (username !== undefined || password !== undefined) {
                Reflect.apply(originalOpen, this, [
                    method,
                    requestUrl,
                    async,
                    username ?? null,
                    password ?? null,
                ]);
                return;
            }
            Reflect.apply(originalOpen, this, [method, requestUrl, async]);
        };
        Reflect.set(XMLHttpRequest.prototype, 'open', wrappedOpen);

        wrappedSend = function (
            this: XMLHttpRequest,
            body?: Document | XMLHttpRequestBodyInit | null,
        ): void {
            const generation = activeCaptureGeneration;
            const requestUrl = xhrRequestMetadata.get(this)?.url ?? '';
            const shouldObserve =
                generation !== null &&
                isJson3Timedtext(requestUrl) !== null;
            if (shouldObserve) {
                this.addEventListener(
                    'loadend',
                    () => {
                        if (
                            !isCurrentGeneration(generation) ||
                            this.status < HTTP_SUCCESS_MIN ||
                            this.status >= HTTP_SUCCESS_MAX_EXCLUSIVE
                        ) {
                            return;
                        }
                        let text: string;
                        try {
                            const responseBody: unknown = this.response;
                            if (typeof responseBody === 'string') {
                                text = responseBody;
                            } else if (
                                responseBody !== null &&
                                typeof responseBody === 'object'
                            ) {
                                text = JSON.stringify(responseBody);
                            } else {
                                text = this.responseText;
                            }
                        } catch {
                            return;
                        }
                        if (!isCurrentGeneration(generation)) {
                            return;
                        }
                        postTimedtextCapture(
                            generation,
                            'xhr',
                            this.responseURL || requestUrl,
                            text,
                            this.getResponseHeader('content-type'),
                            this.status,
                        );
                    },
                    { once: true },
                );
            }
            const args = body === undefined ? [] : [body];
            Reflect.apply(originalSend, this, args);
        };
        Reflect.set(XMLHttpRequest.prototype, 'send', wrappedSend);
    }

    document.addEventListener(CAPTION_PAGE_BRIDGE_EVENT.Command, onCommand);

    const teardown = (): void => {
        if (tornDown) {
            return;
        }
        tornDown = true;
        activeCaptureGeneration = null;
        clearActiveLease();
        restoreCaptionState();
        document.removeEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            onCommand,
        );
        if (window.fetch === wrappedFetch) {
            window.fetch = originalFetch;
        }
        if (
            typeof wrappedOpen === 'function' &&
            Reflect.get(XMLHttpRequest.prototype, 'open') === wrappedOpen
        ) {
            Reflect.set(XMLHttpRequest.prototype, 'open', originalOpen);
        }
        if (
            typeof wrappedSend === 'function' &&
            Reflect.get(XMLHttpRequest.prototype, 'send') === wrappedSend
        ) {
            Reflect.set(XMLHttpRequest.prototype, 'send', originalSend);
        }
        Reflect.set(globalThis, INSTALL_FLAG, false);
        if (Reflect.get(globalThis, TEARDOWN_FLAG) === teardown) {
            Reflect.deleteProperty(globalThis, TEARDOWN_FLAG);
        }
    };

    Reflect.set(globalThis, TEARDOWN_FLAG, teardown);
    postPageDiagnostic({ stage: 'bridge-installed', ok: true });
};

installCaptionPageBridge();
