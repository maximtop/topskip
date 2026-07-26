import * as v from 'valibot';

import { BackgroundStorageAccess } from '@/background/storage/background-storage-access';
import browser from '@/shared/browser';
import {
    ANALYSIS_MODE,
    DEFAULT_PROVIDER_ID,
    STORAGE_KEY_PREFS,
    userPreferencesSchema,
    type UserPreferences,
} from '@/shared/constants';
import {
    CHROME_BUILTIN_MODEL_ID,
    DEFAULT_DETECTION_MODEL_ID,
    resolveDetectionModel,
} from '@/shared/detection-models';
import { PROVIDER_ID } from '@/shared/providers';

/**
 * Namespace for `browser.storage.local` prefs (query + command); not
 * instantiable.
 */
export class PrefsSyncStorage {
    /**
     * Fallback prefs when storage is empty or repaired.
     */
    private static readonly defaultPrefs: UserPreferences = {
        enabled: true,
        providerId: DEFAULT_PROVIDER_ID,
        activeModelId: DEFAULT_DETECTION_MODEL_ID,
        analysisMode: ANALYSIS_MODE.Server,
    };

    /**
     * Single-flight guard for one-time storage listener wiring.
     */
    private static initPromise: Promise<void> | null = null;

    /**
     * Parses and validates a value from storage using `userPreferencesSchema`.
     *
     * @param raw Untrusted value previously read from `browser.storage.local`.
     * @returns Validated preferences object.
     */
    private static parseStoredPrefs(raw: unknown): UserPreferences {
        const parsed = v.parse(userPreferencesSchema, raw);
        const rawActiveModelId = PrefsSyncStorage.readRawActiveModelId(raw);
        const activeModelId =
            rawActiveModelId !== undefined && rawActiveModelId.length > 0
                ? rawActiveModelId
                : PrefsSyncStorage.legacyProviderToModelId(parsed.providerId);
        const model = resolveDetectionModel(activeModelId, []);
        const providerId =
            model?.providerId ??
            PrefsSyncStorage.providerIdFromModelId(activeModelId);
        return {
            enabled: parsed.enabled,
            providerId,
            activeModelId: model?.id ?? activeModelId,
            analysisMode: parsed.analysisMode,
        };
    }

    /**
     * Reads the stored active model before Valibot fallback hides whether a
     * legacy row had no model-first field.
     *
     * @param raw Untrusted storage value.
     * @returns Raw active model id when present.
     */
    private static readRawActiveModelId(raw: unknown): string | undefined {
        if (
            raw === null ||
            typeof raw !== 'object' ||
            !('activeModelId' in raw) ||
            typeof raw.activeModelId !== 'string'
        ) {
            return undefined;
        }
        return raw.activeModelId;
    }

    /**
     * Checks whether the untrusted storage row already matches normalized prefs.
     *
     * @param raw Previous storage value.
     * @param prefs Normalized preferences.
     * @returns Whether a repair write is unnecessary.
     */
    private static storedPrefsMatch(
        raw: unknown,
        prefs: UserPreferences,
    ): boolean {
        return (
            raw !== null &&
            typeof raw === 'object' &&
            'enabled' in raw &&
            'providerId' in raw &&
            'activeModelId' in raw &&
            'analysisMode' in raw &&
            raw.enabled === prefs.enabled &&
            raw.providerId === prefs.providerId &&
            raw.activeModelId === prefs.activeModelId &&
            raw.analysisMode === prefs.analysisMode
        );
    }

    /**
     * Legacy provider-only prefs need a model ID so model-first UI has a
     * stable selection after upgrade.
     *
     * @param providerId Legacy provider id.
     * @returns Equivalent default model id.
     */
    private static legacyProviderToModelId(providerId: string): string {
        if (providerId === PROVIDER_ID.ChromePromptApi) {
            return CHROME_BUILTIN_MODEL_ID;
        }
        return DEFAULT_DETECTION_MODEL_ID;
    }

    /**
     * Custom model IDs may not resolve without provider-specific storage, but
     * their prefix still preserves runtime routing.
     *
     * @param modelId Stored active model id.
     * @returns Provider route inferred from the model id.
     */
    private static providerIdFromModelId(modelId: string): string {
        if (modelId.startsWith(`${PROVIDER_ID.OpenAI}:`)) {
            return PROVIDER_ID.OpenAI;
        }
        if (modelId.startsWith(`${PROVIDER_ID.ChromePromptApi}:`)) {
            return PROVIDER_ID.ChromePromptApi;
        }
        return PROVIDER_ID.OpenRouter;
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
            const prefs = PrefsSyncStorage.parseStoredPrefs(raw);
            await PrefsSyncStorage.repairIfChanged(raw, prefs);
            return prefs;
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
     * Persists upgraded prefs only when a legacy or stale row changed shape.
     *
     * @param raw Previous storage value.
     * @param prefs Normalized preferences.
     * @returns Promise resolved after optional repair.
     */
    private static async repairIfChanged(
        raw: unknown,
        prefs: UserPreferences,
    ): Promise<void> {
        if (PrefsSyncStorage.storedPrefsMatch(raw, prefs)) {
            return;
        }
        await PrefsSyncStorage.save(prefs);
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
        await BackgroundStorageAccess.ready();
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
