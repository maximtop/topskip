# Issue 2 — Unify `enabled` flags into `providerId` in prefs + storage migration

**Type**: Architecture / Storage
**Priority**: P1
**Blocked by**: Issue 1
**Status**: Validated
**User Stories**: US-3, US-8
**Success Criteria**: SC-005

## Goal

Add `providerId` to `userPreferencesSchema` so a single field identifies the active LLM backend. Remove the `enabled` flag from `OpenRouterStorage`. Write a one-time migration in `Background.init()` that maps the old dual-flag state to the new schema. Remove `reconcileDivergentEnabled()`.

## Scope

### Modified files

| File | Change |
|------|--------|
| `src/shared/constants.ts` | Add `providerId` (string, default `'openrouter'`) to `userPreferencesSchema`. Export `DEFAULT_PROVIDER_ID`. |
| `src/background/storage/openrouter-storage.ts` | Remove `enabled` from `OpenRouterConfig` and its schema/default. Remove `canRunPromoAnalysis()`. Adjust `save()` validation (no more `enabled` guard). |
| `src/background/storage/prefs-sync.ts` | Update `defaultPrefs` to include `providerId`. Schema auto-repairs missing `providerId` on load (existing users). |
| `src/background/background.ts` | Replace `reconcileDivergentEnabled()` with `migrateProviderIdFromLegacy()`. New migration: if `topskip:openrouter.enabled === true` and prefs have no `providerId`, set `providerId: 'openrouter'`; if `openrouter.enabled === false`, set `providerId: 'none'` (or keep `'openrouter'` depending on `prefs.enabled`). Delete the `enabled` key from the stored OpenRouter blob. |
| `src/background/messaging/promo-analysis.ts` | Read `providerId` from prefs instead of checking `orConfig.enabled`. (Pipeline still calls OpenRouter directly — issue 3 wires the adapter.) |
| `src/shared/messages.ts` | Add `providerId` to `GetPrefsResponse` payload so popup/options can read it. |
| `src/popup/preferences-store.ts` | Accept `providerId` in `load()` response; expose as observable (for issue 5). |
| `tests/background/storage/*` | New/updated tests for schema, migration, load/save round-trip. |
| `tests/popup/preferences-store.test.ts` | Mock response includes `providerId`. |

### Deleted code

- `reconcileDivergentEnabled()` in `background.ts`
- `OpenRouterStorage.canRunPromoAnalysis()` (replaced by provider-aware check)
- `enabled` field in `OpenRouterConfig` type + schema

## Migration logic (pseudo-code)

```ts
async function migrateProviderIdFromLegacy(): Promise<void> {
  const prefs = await PrefsSyncStorage.load();
  if (prefs.providerId !== undefined) return; // already migrated

  const raw = await browser.storage.local.get(STORAGE_KEY_OPENROUTER);
  const orBlob = raw[STORAGE_KEY_OPENROUTER];
  const wasOrEnabled = orBlob?.enabled === true;

  await PrefsSyncStorage.save({
    ...prefs,
    providerId: wasOrEnabled ? 'openrouter' : 'openrouter', // default to openrouter
  });

  // Strip `enabled` from stored OpenRouter config
  if (orBlob && 'enabled' in orBlob) {
    const { enabled: _, ...rest } = orBlob;
    await browser.storage.local.set({ [STORAGE_KEY_OPENROUTER]: rest });
  }
}
```

## Acceptance criteria

- [ ] `userPreferencesSchema` includes `providerId` with Valibot fallback
- [ ] `PrefsSyncStorage.load()` returns `providerId` for both new installs and migrated users
- [ ] `OpenRouterConfig` no longer has an `enabled` field
- [ ] `reconcileDivergentEnabled()` is deleted
- [x] No migration needed (app unreleased); legacy `enabled` field cleaned up opportunistically if present
- [ ] `GET_PREFS` response includes `providerId`
- [ ] `PreferencesStore` exposes `providerId` observable
- [ ] Existing E2E and unit tests pass (with updated mocks where needed)
- [ ] `pnpm run lint` passes

## Testing

- Storage round-trip: save prefs with `providerId`, load back, verify
- Migration: seed storage with old dual-flag format → call migration → verify `providerId` written and `enabled` stripped from OpenRouter blob
- Schema repair: load prefs with missing `providerId` → defaults to `'openrouter'`
- `preferences-store.test.ts` updated for `providerId` in responses
