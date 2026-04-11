import { makeAutoObservable, runInAction } from 'mobx';

import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type GetPrefsResponse,
  type SetPrefsResponse,
} from '@/shared/messages';

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

/**
 * Popup observable state for the enable switch; persists via background
 * messaging only.
 */
export class PreferencesStore {
  enabled = true;

  /**
   * Registers MobX observables for this store.
   */
  constructor() {
    makeAutoObservable(this);
  }

  /**
   * Loads the current preference from the background service worker.
   *
   * @returns A promise that resolves when `enabled` reflects stored prefs.
   */
  async load(): Promise<void> {
    const res = await browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.GET_PREFS,
    });
    if (!isGetPrefsOk(res)) {
      const err =
        res && typeof res === 'object' && 'error' in res
          ? String((res as { error: string }).error)
          : 'failed to load preferences';
      throw new Error(err);
    }
    runInAction(() => {
      this.enabled = res.prefs.enabled;
    });
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
            : 'failed to save preferences';
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
