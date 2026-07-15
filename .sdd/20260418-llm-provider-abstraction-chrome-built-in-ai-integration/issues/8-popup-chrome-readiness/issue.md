# Issue 8 — Popup: Chrome Built-in model readiness status

**Type**: Feature / UI
**Priority**: P2
**Status**: Validated
**Blocked by**: Issues 5, 6
**User Stories**: US-9
**Success Criteria**: SC-003

## Goal

When the active provider is `chrome-prompt-api` and the model is not yet ready, show a clear status in the popup ("Model downloading…" or "Model unavailable") so the user knows why detection is not running.

## Scope

### Modified files

| File | Change |
|------|--------|
| `src/popup/PopupApp.tsx` | Extend `buildPopupViewModel` with chrome-specific states: `model_downloading` (tone: brand, "Model downloading…" body) and `model_unavailable` (tone: warning, "Model unavailable" body + link to options). |
| `src/popup/preferences-store.ts` | Add `chromeModelAvailability` observable (fetched alongside active provider, or via a lightweight `GET_CHROME_PROMPT_API_STATUS` call when `providerId === 'chrome-prompt-api'`). |
| `tests/popup/preferences-store.test.ts` | Test `chromeModelAvailability` loading. |

## View-model additions

| Condition | Tone | Badge | Status headline |
|-----------|------|-------|-----------------|
| `chrome-prompt-api` + `downloading` | brand | Downloading | "Model downloading…" |
| `chrome-prompt-api` + `unavailable` | warning | Unavailable | "Model unavailable — check settings" |
| `chrome-prompt-api` + `downloadable` | neutral | Setup | "Model not downloaded yet" |
| `chrome-prompt-api` + `available` | (existing status logic) | — | (defers to detection status) |

## Acceptance criteria

- [x] When `chrome-prompt-api` is active and model is downloading, popup shows "Model downloading…"
- [x] When `chrome-prompt-api` is active and model is unavailable, popup shows "Model unavailable" + link
- [x] When `chrome-prompt-api` is active and model is downloadable, popup shows "Model not downloaded yet"
- [x] When model is available, existing detection status logic applies
- [x] When provider is `openrouter`, chrome model states are not shown
- [x] `pnpm run lint` passes

## Testing

- Unit: `buildPopupViewModel` with `chrome-prompt-api` + `downloading` → correct tone and headline
- Unit: `buildPopupViewModel` with `chrome-prompt-api` + `unavailable` → correct tone and headline
- Unit: `PreferencesStore.chromeModelAvailability` set from mock response
