import { makeAutoObservable, runInAction } from 'mobx';
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import { DEFAULT_PROVIDER_ID, PREFS_PORT_NAME } from '@/shared/constants';
import {
  TOPSKIP_MESSAGE,
  type GetActiveProviderResponse,
  type GetChromePromptApiStatusResponse,
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
  enabled = true;
  // FIXME add eslint rule, which will force jsdoc on props in the classes
  providerId: string = DEFAULT_PROVIDER_ID;
  providerDisplayName: string = '';
  modelDisplayName: string = '';
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
   * Fetches the active provider display name and model name from the
   * background and updates the corresponding observables.
   *
   * @returns Promise that resolves when the observables are updated.
   */
  private async refreshProviderDisplay(): Promise<void> {
    const res = await browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
    });
    if (isGetActiveProviderOk(res)) {
      runInAction(() => {
        this.providerDisplayName = res.displayName;
        this.modelDisplayName = res.modelName;
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
    if (this.providerId !== 'chrome-prompt-api') {
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
    const [prefsRes, providerRes] = await Promise.all([
      browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_PREFS }),
      browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
      }),
    ]);

    // FIXME use valibot for validating, also I think we should setup types, so that we could believe to our background page, and types catch errors if developer changes structure of response.
    if (!isGetPrefsOk(prefsRes)) {
      const err =
        prefsRes && typeof prefsRes === 'object' && 'error' in prefsRes
          ? String((prefsRes as { error: string }).error)
          : translator.getMessage('prefs_error_load');
      throw new Error(err);
    }

    runInAction(() => {
      this.enabled = prefsRes.prefs.enabled;

      // FIXME type should be specified
      if (typeof prefsRes.prefs.providerId === 'string') {
        this.providerId = prefsRes.prefs.providerId;
      }
      if (isGetActiveProviderOk(providerRes)) {
        this.providerDisplayName = providerRes.displayName;
        this.modelDisplayName = providerRes.modelName;
      }
    });

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
