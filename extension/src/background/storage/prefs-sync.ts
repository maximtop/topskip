import * as v from 'valibot';

import browser from '@/shared/browser';
import {
  STORAGE_KEY_PREFS,
  userPreferencesSchema,
  type UserPreferences,
} from '@/shared/constants';

/**
 * Namespace for `browser.storage.local` prefs (query + command); not
 * instantiable.
 */
export class PrefsSyncStorage {
  private constructor() {}

  private static readonly defaultPrefs: UserPreferences = { enabled: true };

  private static initPromise: Promise<void> | null = null;

  /**
   * Parses and validates a value from storage using `userPreferencesSchema`.
   *
   * @param raw Untrusted value previously read from `browser.storage.local`.
   * @returns Validated preferences object.
   */
  private static parseStoredPrefs(raw: unknown): UserPreferences {
    return v.parse(userPreferencesSchema, raw);
  }

  /**
   * Query: reads preferences from `browser.storage.local`, repairing corrupt
   * data to defaults.
   *
   * @returns The current preferences, or defaults after a repair write.
   */
  static async load(): Promise<UserPreferences> {
    const result = await browser.storage.local.get(STORAGE_KEY_PREFS);
    const raw = result[STORAGE_KEY_PREFS];
    if (raw === undefined) {
      return PrefsSyncStorage.defaultPrefs;
    }
    try {
      return PrefsSyncStorage.parseStoredPrefs(raw);
    } catch {
      await PrefsSyncStorage.save(PrefsSyncStorage.defaultPrefs);
      return PrefsSyncStorage.defaultPrefs;
    }
  }

  /**
   * Command: validates and persists preferences under `STORAGE_KEY_PREFS`.
   *
   * @param prefs Preferences to store after validation.
   * @returns A promise that resolves when the value has been written.
   */
  static async save(prefs: UserPreferences): Promise<void> {
    const validated = v.parse(userPreferencesSchema, prefs);
    await browser.storage.local.set({ [STORAGE_KEY_PREFS]: validated });
  }

  /**
   * Resolves when `browser.storage.local` has been validated or seeded with
   * defaults (single flight).
   *
   * @returns Promise that resolves when preferences storage is ready for reads
   * and writes.
   */
  static ready(): Promise<void> {
    if (PrefsSyncStorage.initPromise === null) {
      PrefsSyncStorage.initPromise = PrefsSyncStorage.ensureInitialized();
    }
    return PrefsSyncStorage.initPromise;
  }

  /**
   * Command: ensures a valid prefs object exists on first run or after corrupt
   * storage.
   *
   * @returns A promise that resolves when defaults are ensured.
   */
  private static async ensureInitialized(): Promise<void> {
    const result = await browser.storage.local.get(STORAGE_KEY_PREFS);
    const raw = result[STORAGE_KEY_PREFS];
    if (raw === undefined) {
      await PrefsSyncStorage.save(PrefsSyncStorage.defaultPrefs);
      return;
    }
    try {
      PrefsSyncStorage.parseStoredPrefs(raw);
    } catch {
      await PrefsSyncStorage.save(PrefsSyncStorage.defaultPrefs);
    }
  }
}
