# Issue 5 — Popup: display active provider & model label

**Type**: Feature / UI
**Priority**: P1
**Blocked by**: Issue 4
**Status**: Validated
**User Stories**: US-2, US-9
**Success Criteria**: SC-003

## Goal

Show the active LLM provider and model name in the popup status area (e.g. "OpenRouter · gemini-3.1-pro-preview" or "Chrome Built-in · Gemini Nano").

## Scope

### Modified files

| File | Change |
|------|--------|
| `src/popup/preferences-store.ts` | Add `activeProviderId`, `providerDisplayName`, `modelDisplayName` observables. Fetch via `GET_ACTIVE_PROVIDER` on `load()`. Update from port messages if `providerId` changes. |
| `src/popup/PopupApp.tsx` | Render provider + model label in the status area. Pass provider info into `buildPopupViewModel`. When `providerId === 'openrouter'` and no API key, show "Not configured" badge alongside provider name. |
| `tests/popup/preferences-store.test.ts` | Add tests for `activeProviderId` / `providerDisplayName` / `modelDisplayName` loading and observable updates. |

### No changes

- Options page (already done in issue 4), background, content script.

## UI sketch

```
┌──────────────────────────────┐
│  TopSkip             [ON/OFF]│
│                              │
│  ⚡ OpenRouter · gemini-3.1  │  ← provider label
│                              │
│  ┌─ Status ────────────────┐ │
│  │ Analyzing captions…     │ │
│  └─────────────────────────┘ │
│                              │
│  [Open settings]             │
└──────────────────────────────┘
```

When no provider is configured, the label reads "OpenRouter · Not configured" with a warning badge linking to options.

## Acceptance criteria

- [ ] `PreferencesStore.load()` fetches active provider info from background
- [ ] Provider + model label renders in the popup status area
- [ ] Label updates when provider changes (via port message)
- [ ] `not_configured` view-model state includes provider name
- [ ] Chrome Built-in label shows "Chrome Built-in · Gemini Nano"
- [ ] `pnpm run lint` passes

## Testing

- Unit: `PreferencesStore` loads `activeProviderId` + display names from mock response
- Unit: port message with new `providerId` updates observables
- Unit: `buildPopupViewModel` maps provider info into status headline correctly
