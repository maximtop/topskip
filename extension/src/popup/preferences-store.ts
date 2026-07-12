import { makeAutoObservable, runInAction } from 'mobx';
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
    ANALYSIS_MODE,
    DEFAULT_PROVIDER_ID,
    PREFS_PORT_NAME,
    type AnalysisMode,
} from '@/shared/constants';
import { PROVIDER_ID } from '@/shared/providers';
import {
    TOPSKIP_MESSAGE,
    type GetActiveProviderResponse,
    type GetChromePromptApiStatusResponse,
    type GetModelSettingsResponse,
    type GetPrefsResponse,
    type ProviderAvailabilityMessage,
    type SetPrefsResponse,
    isPrefsPortMessage,
} from '@/shared/messages';
import { translator } from '@/shared/i18n/translator';

/**
 * Type guard for a successful GET_PREFS response from the background page.
 *
 * @param res Untyped `runtime.sendMessage` result.
 * @returns Whether `res` is `{ ok: true, prefs }` with a boolean `enabled`.
 */
function isGetPrefsOk(
    res: unknown,
): res is Extract<GetPrefsResponse, { ok: true }> {
    return (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok === true &&
        'prefs' in res &&
        typeof (res as { prefs: { enabled?: boolean } }).prefs?.enabled ===
            'boolean'
    );
}

/**
 * Type guard for a successful SET_PREFS response from the background page.
 *
 * @param res Untyped `runtime.sendMessage` result.
 * @returns Whether `res` is `{ ok: true }`.
 */
function isSetPrefsOk(
    res: unknown,
): res is Extract<SetPrefsResponse, { ok: true }> {
    return (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok === true
    );
}

// FIXME use valibot for checking shapes
/**
 * Type guard for a successful GET_ACTIVE_PROVIDER response.
 *
 * @param res - Untyped `runtime.sendMessage` result.
 * @returns Whether `res` is `{ ok: true, providerId, displayName, modelName }`.
 */
function isGetActiveProviderOk(
    res: unknown,
): res is Extract<GetActiveProviderResponse, { ok: true }> {
    return (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok === true &&
        'displayName' in res &&
        typeof (res as { displayName: unknown }).displayName === 'string'
    );
}

/**
 * Type guard for successful model-first settings response.
 *
 * @param res - Untyped `runtime.sendMessage` result.
 * @returns Whether `res` includes active model and model list.
 */
function isGetModelSettingsOk(
    res: unknown,
): res is Extract<GetModelSettingsResponse, { ok: true }> {
    return (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok === true &&
        'activeModelId' in res &&
        typeof (res as { activeModelId: unknown }).activeModelId === 'string' &&
        'models' in res &&
        Array.isArray((res as { models: unknown }).models)
    );
}

// FIXME use valibot for checking shapes
/**
 * Type guard for a successful GET_CHROME_PROMPT_API_STATUS response.
 *
 * @param res - Untyped `runtime.sendMessage` result.
 * @returns Whether `res` includes a valid availability payload.
 */
function isGetChromePromptApiStatusOk(
    res: unknown,
): res is Extract<GetChromePromptApiStatusResponse, { ok: true }> {
    return (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok === true &&
        'availability' in res &&
        typeof (res as { availability: unknown }).availability === 'string'
    );
}

/**
 * Popup observable state for the enable switch; persists via background
 * messaging only.
 */
export class PreferencesStore {
    /**
     * Whether TopSkip is enabled for this browser profile.
     */
    enabled = true;
    /**
     * Selected analysis route mirrored from background preferences.
     */
    analysisMode: AnalysisMode = ANALYSIS_MODE.Server;
    /**
     * Active LLM provider id mirrored from background prefs.
     */
    providerId: string = DEFAULT_PROVIDER_ID;
    /**
     * Provider label for the popup header.
     */
    providerDisplayName: string = '';
    /**
     * Model label (OpenRouter slug or built-in name) when applicable.
     */
    modelDisplayName: string = '';
    /**
     * Chrome built-in model availability snapshot for inline status.
     */
    chromeModelAvailability: ProviderAvailabilityMessage | null = null;

    /**
     * Registers MobX observables for this store.
     */
    constructor() {
        makeAutoObservable(this);
    }

    /**
     * Long-lived port to the background for live preference updates.
     */
    private port: Runtime.Port | null = null;

    /**
     * Fetches the active model display name and provider metadata from the
     * background and updates the corresponding observables.
     *
     * @returns Promise that resolves when the observables are updated.
     */
    private async refreshProviderDisplay(): Promise<void> {
        const res = await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_MODEL_SETTINGS,
        });
        if (isGetModelSettingsOk(res)) {
            const activeModel = res.models.find(
                (model) => model.id === res.activeModelId,
            );
            if (activeModel) {
                runInAction(() => {
                    this.providerId = activeModel.providerId;
                    this.providerDisplayName = activeModel.providerLabel;
                    this.modelDisplayName = activeModel.label;
                });
                return;
            }
        }

        const legacyRes = await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
        });
        if (isGetActiveProviderOk(legacyRes)) {
            runInAction(() => {
                this.providerDisplayName = legacyRes.displayName;
                this.modelDisplayName = legacyRes.modelName;
            });
        }
    }

    /**
     * Fetches Chrome model availability when Chrome Built-in is active.
     * Clears availability when another provider is selected.
     *
     * @returns Promise that resolves when availability observable is updated.
     */
    private async refreshChromeModelAvailability(): Promise<void> {
        if (this.providerId !== PROVIDER_ID.ChromePromptApi) {
            runInAction(() => {
                this.chromeModelAvailability = null;
            });
            return;
        }

        const res = await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
        });

        runInAction(() => {
            if (isGetChromePromptApiStatusOk(res)) {
                this.chromeModelAvailability = res.availability;
            } else {
                this.chromeModelAvailability = null;
            }
        });
    }

    /**
     * Opens a long-lived port to the background and listens for preference
     * updates. Call once on mount; call {@link disconnectPort} on unmount.
     */
    connectPort(): void {
        this.port = browser.runtime.connect({ name: PREFS_PORT_NAME });
        this.port.onMessage.addListener((msg: unknown) => {
            if (isPrefsPortMessage(msg)) {
                const prevProviderId = this.providerId;
                runInAction(() => {
                    this.enabled = msg.prefs.enabled;
                    this.analysisMode =
                        msg.prefs.analysisMode ?? ANALYSIS_MODE.Server;
                    if (typeof msg.prefs.providerId === 'string') {
                        this.providerId = msg.prefs.providerId;
                    }
                });
                if (msg.prefs.providerId !== prevProviderId) {
                    void this.refreshProviderDisplay();
                    void this.refreshChromeModelAvailability();
                }
            }
        });
    }

    /**
     * Disconnects the live-update port. Safe to call if not connected.
     */
    disconnectPort(): void {
        if (this.port) {
            this.port.disconnect();
            this.port = null;
        }
    }

    /**
     * Loads the current preference from the background service worker.
     *
     * @returns A promise that resolves when `enabled` reflects stored prefs.
     */
    async load(): Promise<void> {
        const [prefsRes] = await Promise.all([
            browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_PREFS }),
        ]);

        // FIXME use valibot for validating; tighten response types so the
        // background contract is checked when message shapes change.
        if (!isGetPrefsOk(prefsRes)) {
            const err =
                prefsRes && typeof prefsRes === 'object' && 'error' in prefsRes
                    ? String((prefsRes as { error: string }).error)
                    : translator.getMessage('prefs_error_load');
            throw new Error(err);
        }

        runInAction(() => {
            this.enabled = prefsRes.prefs.enabled;
            this.analysisMode =
                prefsRes.prefs.analysisMode ?? ANALYSIS_MODE.Server;

            // FIXME type should be specified
            if (typeof prefsRes.prefs.providerId === 'string') {
                this.providerId = prefsRes.prefs.providerId;
            }
        });

        await this.refreshProviderDisplay();
        await this.refreshChromeModelAvailability();
    }

    /**
     * Updates the enabled flag via the background and reverts on failure.
     *
     * @param value New enabled state for the master switch.
     * @returns A promise that resolves when the preference is saved.
     */
    async setEnabled(value: boolean): Promise<void> {
        const previous = this.enabled;
        runInAction(() => {
            this.enabled = value;
        });
        try {
            const res = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.SET_PREFS,
                enabled: value,
            });
            if (!isSetPrefsOk(res)) {
                const err =
                    res && typeof res === 'object' && 'error' in res
                        ? String((res as { error: string }).error)
                        : translator.getMessage('prefs_error_save');
                throw new Error(err);
            }
        } catch (e) {
            runInAction(() => {
                this.enabled = previous;
            });
            throw e instanceof Error ? e : new Error(getErrorMessage(e));
        }
    }
}
