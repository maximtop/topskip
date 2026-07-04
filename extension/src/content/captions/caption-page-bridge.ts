const INSTALL_FLAG = '__topskipCaptionCaptureInstalled';
const PAGE_API = '__topskipCaptionCaptureApi';
const TIMEDTEXT_PATH = '/api/timedtext';
const PAGE_SOURCE = 'TOPSKIP_CAPTION_CAPTURE_PAGE';
const PAGE_EVENT = 'topskip:caption-capture-page';
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
const VERBOSE_CAPTURE_LOGS = true;
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
    source: typeof PAGE_SOURCE;
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
    source: typeof PAGE_SOURCE;
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

const installCaptionPageBridge = (): void => {
    const existing: unknown = Reflect.get(globalThis, INSTALL_FLAG);
    if (existing === true) {
        return;
    }
    Reflect.set(globalThis, INSTALL_FLAG, true);

    let wasOn: boolean | null = null;
    let userIntervened = false;
    let trackedButton: Element | null = null;

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

    const postPageBridgeMessage = (message: PageBridgeMessage): void => {
        try {
            window.postMessage(message, window.location.origin);
        } catch {
            return;
        }
        try {
            document.dispatchEvent(
                new CustomEvent(PAGE_EVENT, {
                    detail: JSON.stringify(message),
                }),
            );
        } catch {
            return;
        }
    };

    const postTimedtextCapture = (
        transport: 'fetch' | 'xhr',
        rawUrl: string,
        body: string,
        contentType: string | null,
        status: number,
    ): void => {
        const parsed = isJson3Timedtext(rawUrl);
        if (parsed === null) {
            return;
        }
        const urlShape = getSanitizedUrlShape(parsed);
        postPageDiagnostic({
            stage: 'timedtext-observed',
            transport,
            status,
            bodyLength: body.length,
            contentType,
            videoId: parsed.searchParams.get('v'),
            languageCode: parsed.searchParams.get('lang'),
            urlShape,
        });
        if (body.length === 0) {
            postPageDiagnostic({
                stage: 'timedtext-empty-body',
                transport,
                status,
                bodyLength: body.length,
                videoId: parsed.searchParams.get('v'),
                languageCode: parsed.searchParams.get('lang'),
                urlShape,
            });
            return;
        }
        if (!body.trimStart().startsWith('{')) {
            postPageDiagnostic({
                stage: 'timedtext-non-json',
                transport,
                status,
                bodyLength: body.length,
                contentType,
                videoId: parsed.searchParams.get('v'),
                languageCode: parsed.searchParams.get('lang'),
                urlShape,
            });
            return;
        }
        postPageBridgeMessage({
            source: PAGE_SOURCE,
            kind: 'timedtext-capture',
            videoId: parsed.searchParams.get('v'),
            languageCode: parsed.searchParams.get('lang'),
            body,
            contentType,
            bodyLength: body.length,
            urlShape,
        });
        postPageDiagnostic({
            stage: 'timedtext-forwarded',
            transport,
            status,
            bodyLength: body.length,
            contentType,
            videoId: parsed.searchParams.get('v'),
            languageCode: parsed.searchParams.get('lang'),
            urlShape,
        });
    };

    const postPageDiagnostic = (
        message: Omit<PageBridgeDiagnosticMessage, 'source' | 'kind'>,
    ): void => {
        if (!VERBOSE_CAPTURE_LOGS) {
            return;
        }
        postPageBridgeMessage({
            source: PAGE_SOURCE,
            kind: 'diagnostic',
            ...message,
        });
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
        if (player === null) {
            return false;
        }
        return typeof Reflect.get(player, methodName) === 'function';
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

    const activateCaptions = (): Record<string, unknown> => {
        const actions: string[] = [];
        if (!isWatchPlayerStable()) {
            postPageDiagnostic({
                stage: 'activation-blocked',
                ok: false,
                reason: PLAYER_NOT_READY_REASON,
                error: 'Watch player is not ready for caption capture',
            });
            return {
                ok: false,
                reason: PLAYER_NOT_READY_REASON,
                error: 'Watch player is not ready for caption capture',
                actions,
            };
        }
        const button = document.querySelector(CAPTIONS_BUTTON_SELECTOR);
        if (button === null && !hasPlayerMethod('toggleSubtitlesOn')) {
            postPageDiagnostic({
                stage: 'activation-blocked',
                ok: false,
                reason: CAPTIONS_UNAVAILABLE_REASON,
                error: 'Caption controls are unavailable',
            });
            return {
                ok: false,
                reason: CAPTIONS_UNAVAILABLE_REASON,
                error: 'Caption controls are unavailable',
                actions,
            };
        }
        const pressed = button?.getAttribute('aria-pressed');
        wasOn = pressed === 'true';
        userIntervened = false;
        if (button !== null) {
            trackUserIntervention(button);
        }
        if (!wasOn) {
            ensureHideStyle();
            actions.push('hide-style-added');
        }
        if (callPlayerMethod('loadModule', [CAPTION_MODULE])) {
            actions.push('loadModule:captions');
        }
        const tracks = getPlayerOption('tracklist');
        const hasTracks = Array.isArray(tracks) ? tracks.length : null;
        if (wasOn) {
            actions.push('skipped:already-on');
            postPageDiagnostic({
                stage: 'activation-finished',
                ok: true,
                wasOn,
                userIntervened,
                buttonPressed: button?.getAttribute('aria-pressed') ?? null,
                hideStylePresent:
                    document.getElementById(HIDE_STYLE_ID) !== null,
                hasTracks,
                actions,
            });
            return { ok: true, wasOn, userIntervened, hasTracks, actions };
        }
        if (Array.isArray(tracks) && tracks.length > 0) {
            const firstTrack: unknown = Reflect.get(tracks, '0');
            if (setPlayerOption(CAPTION_TRACK_OPTION, firstTrack)) {
                actions.push('setOption:track');
            }
        } else if (setPlayerOption(CAPTION_RELOAD_OPTION, true)) {
            actions.push('setOption:reload');
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
            postPageDiagnostic({
                stage: 'activation-blocked',
                ok: false,
                reason: ACTIVATION_UNAVAILABLE_REASON,
                error: 'Caption activation is unavailable',
                wasOn,
                userIntervened,
                hasTracks,
                actions,
            });
            return {
                ok: false,
                reason: ACTIVATION_UNAVAILABLE_REASON,
                error: 'Caption activation is unavailable',
                wasOn,
                userIntervened,
                hasTracks,
                actions,
            };
        }
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

    const deactivateCaptions = (): Record<string, unknown> => {
        const actions: string[] = [];
        if (wasOn === false && !userIntervened) {
            if (callPlayerMethod('toggleSubtitlesOff')) {
                actions.push('toggleSubtitlesOff');
            }
            if (
                callPlayerMethod('setOption', [
                    CAPTION_MODULE,
                    CAPTION_TRACK_OPTION,
                    {},
                ])
            ) {
                actions.push('setOption:track-empty');
            }
            if (callPlayerMethod('unloadModule', [CAPTION_MODULE])) {
                actions.push('unloadModule:captions');
            }
        }
        removeHideStyle();
        actions.push('hide-style-removed');
        untrackUserIntervention();
        postPageDiagnostic({
            stage: 'cleanup-finished',
            ok: true,
            wasOn,
            userIntervened,
            hideStylePresent: document.getElementById(HIDE_STYLE_ID) !== null,
            actions,
        });
        return { ok: true, wasOn, userIntervened, actions };
    };

    Reflect.set(globalThis, PAGE_API, {
        activateCaptions,
        deactivateCaptions,
    });
    postPageDiagnostic({ stage: 'bridge-installed', ok: true });

    const originalFetch = window.fetch.bind(window);
    window.fetch = (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        let requestUrl = '';
        try {
            requestUrl = input instanceof Request ? input.url : String(input);
        } catch {
            return originalFetch(input, init);
        }
        return originalFetch(input, init).then((response) => {
            if (!response.ok || isJson3Timedtext(requestUrl) === null) {
                return response;
            }
            void response
                .clone()
                .text()
                .then((body) => {
                    postTimedtextCapture(
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

    const originalOpen: unknown = Reflect.get(XMLHttpRequest.prototype, 'open');
    const originalSend: unknown = Reflect.get(XMLHttpRequest.prototype, 'send');
    if (
        typeof originalOpen !== 'function' ||
        typeof originalSend !== 'function'
    ) {
        return;
    }
    XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async = true,
        username?: string | null,
        password?: string | null,
    ): void {
        try {
            Reflect.set(this, '__topskipCaptionCaptureUrl', String(url));
            Reflect.set(this, '__topskipCaptionCaptureMethod', method);
        } catch {
            return;
        }
        if (username !== undefined || password !== undefined) {
            Reflect.apply(originalOpen, this, [
                method,
                String(url),
                async,
                username ?? null,
                password ?? null,
            ]);
            return;
        }
        Reflect.apply(originalOpen, this, [method, String(url), async]);
    };
    XMLHttpRequest.prototype.send = function (
        body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
        let requestUrl = '';
        try {
            const rawUrl: unknown = Reflect.get(
                this,
                '__topskipCaptionCaptureUrl',
            );
            requestUrl = typeof rawUrl === 'string' ? rawUrl : '';
        } catch {
            Reflect.apply(originalSend, this, [body ?? null]);
            return;
        }
        if (isJson3Timedtext(requestUrl) !== null) {
            this.addEventListener(
                'loadend',
                () => {
                    try {
                        const responseBody: unknown = this.response;
                        let text = '';
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
                        const contentType =
                            this.getResponseHeader('content-type');
                        if (
                            this.status >= 200 &&
                            this.status < 300 &&
                            isJson3Timedtext(requestUrl) !== null
                        ) {
                            postTimedtextCapture(
                                'xhr',
                                this.responseURL || requestUrl,
                                text,
                                contentType,
                                this.status,
                            );
                        }
                    } catch {
                        return;
                    }
                },
                { once: true },
            );
        }
        Reflect.apply(originalSend, this, [body ?? null]);
    };
};

installCaptionPageBridge();
