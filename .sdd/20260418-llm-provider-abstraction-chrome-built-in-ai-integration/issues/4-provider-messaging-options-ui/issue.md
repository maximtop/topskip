# Issue 4 — Provider messaging + options provider selector UI

**Type**: Feature / UI
**Priority**: P1
**Blocked by**: Issues 2, 3
**Status**: Validated
**User Stories**: US-2, US-3
**Success Criteria**: SC-002, SC-006

## Goal

Add `GET_ACTIVE_PROVIDER` / `SET_ACTIVE_PROVIDER` runtime message types. Refactor the options page into a tabbed provider selector with the existing OpenRouter config as one tab and a Chrome Built-in placeholder as the other.

## Scope

### New/modified files

| File | Change |
|------|--------|
| `src/shared/messages.ts` | Add `TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER`, `SET_ACTIVE_PROVIDER`, `GET_PROVIDER_LIST`. Add response types `GetActiveProviderResponse`, `SetActiveProviderResponse`, `GetProviderListResponse` with `{ id, displayName, availability }[]`. |
| `src/background/messaging/register-runtime-messages.ts` | Handle `GET_ACTIVE_PROVIDER` (reads `providerId` from prefs + resolves display info from registry), `SET_ACTIVE_PROVIDER` (validates ID against registry, writes to prefs, aborts in-flight if changed), `GET_PROVIDER_LIST` (enumerates registry, queries each adapter's `availability()`). |
| `src/options/options.tsx` | Refactor into tabbed layout: `SegmentedControl` at top with provider options. Below: conditionally render `OpenRouterConfigPanel` (existing form, extracted) or `ChromeBuiltinPanel` (placeholder — "Coming soon" or minimal; fleshed out in issue 7). Master `enabled` switch stays at top level. On mount, fetch provider list + active provider. On tab switch, send `SET_ACTIVE_PROVIDER`. |
| `src/options/OpenRouterConfigPanel.tsx` | Extract existing OpenRouter form from `options.tsx` into a standalone component. No behavior change. |
| `src/options/ChromeBuiltinPanel.tsx` | Placeholder panel: shows availability status text. Full onboarding widget is issue 7. |

### No changes

- Popup (issue 5), content script, background pipeline (already wired in issue 3).

## Message flow

```
Options page                      Background
    |                                 |
    |-- GET_PROVIDER_LIST ----------->|  → registry.getAll() + availability()
    |<-- [{id, displayName, avail}] --|
    |                                 |
    |-- GET_ACTIVE_PROVIDER --------->|  → prefs.providerId + displayName
    |<-- {providerId, displayName} ---|
    |                                 |
    |-- SET_ACTIVE_PROVIDER(id) ----->|  → validate, save prefs, abort inflight
    |<-- {ok: true} ------------------|
```

## Acceptance criteria

- [ ] `GET_PROVIDER_LIST` returns both `openrouter` and `chrome-prompt-api` with availability
- [ ] `GET_ACTIVE_PROVIDER` returns current `providerId` and `displayName`
- [ ] `SET_ACTIVE_PROVIDER` with valid ID updates prefs and returns `ok: true`
- [ ] `SET_ACTIVE_PROVIDER` with unknown ID returns `ok: false` with error
- [ ] Options page renders segmented control with two provider tabs
- [ ] Selecting "OpenRouter" tab shows the existing API key / model config form
- [ ] Selecting "Chrome Built-in" tab shows a placeholder panel with availability status
- [ ] Master `enabled` switch remains at top level, independent of provider
- [ ] OpenRouter config form behavior is identical to before (no regressions)
- [ ] `pnpm run lint` passes

## Testing

- Unit test: `GET_PROVIDER_LIST` handler returns expected structure
- Unit test: `SET_ACTIVE_PROVIDER` writes to prefs and returns ok
- Unit test: `SET_ACTIVE_PROVIDER` with invalid ID returns error
- Existing E2E tests remain green (OpenRouter path unchanged)
