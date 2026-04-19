# Issue 7 — Options: Chrome Built-in onboarding widget

**Type**: Feature / UI
**Priority**: P1
**Status**: Validated
**Blocked by**: Issues 4, 6
**User Stories**: US-4
**Success Criteria**: SC-006, SC-008

## Goal

Replace the placeholder Chrome Built-in panel (issue 4) with a full onboarding widget that handles the model download lifecycle: unavailable → downloadable → downloading → available.

## Scope

### New files

| File | Purpose |
|------|---------|
| `src/options/ChromeBuiltinOnboarding.tsx` | Multi-state onboarding component |

### Modified files

| File | Change |
|------|--------|
| `src/options/ChromeBuiltinPanel.tsx` | Import and render `ChromeBuiltinOnboarding`. Fetch availability via `GET_CHROME_PROMPT_API_STATUS` message. |
| `src/shared/messages.ts` | Add `TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS` + response type `{ availability: ProviderAvailability }`. |
| `src/background/messaging/register-runtime-messages.ts` | Handle `GET_CHROME_PROMPT_API_STATUS` — delegates to `ChromePromptApiAdapter.availability()`. |

## UI states

### 1. `unavailable`

- Greyed out card.
- Text: "Chrome Built-in AI is not available on this device."
- Requirements note: "Requires Chrome 138+, 22 GB free storage, 4 GB+ VRAM or 16 GB RAM."
- Save button disabled for this provider.

### 2. `downloadable`

- Card with model name "Gemini Nano" and approximate size (~2 GB).
- Note: "The model runs entirely on your device — no data leaves your computer."
- Action button: "Download model".
- Save button disabled until model is available.

### 3. `downloading`

- Progress bar with percentage (from `downloadprogress` events via `monitor`).
- Text: "Downloading Gemini Nano… X%".
- Save button disabled.
- If download interrupted, show "Download interrupted — Retry" action.

### 4. `available`

- Green "Ready" badge.
- Text: "Gemini Nano is ready to use."
- Save button enabled.

## Download trigger flow

1. User clicks "Download model" → options page sends `TRIGGER_CHROME_MODEL_DOWNLOAD` message (or the adapter's `availability()` call triggers download implicitly via `LanguageModel.create({ monitor })`).
2. Background creates a session with `monitor` callback, listens for `downloadprogress` events.
3. Progress is relayed back to the options page via port or polling `GET_CHROME_PROMPT_API_STATUS`.
4. On completion, availability transitions to `available`.

## Acceptance criteria

- [x] Unavailable state renders greyed card with requirements text
- [x] Downloadable state renders card with "Download model" button
- [x] Downloading state renders progress bar with percentage
- [x] Download interrupted renders retry action (no stuck spinner)
- [x] Available state renders "Ready" badge with save enabled
- [x] Re-opening options page shows current state (not reset)
- [x] `pnpm run lint` passes

## Testing

- Unit: render component with `availability='unavailable'` → requirements note visible
- Unit: render with `availability='downloadable'` → download button visible
- Unit: render with `availability='downloading'` → progress bar visible
- Unit: render with `availability='available'` → "Ready" badge visible
- Unit: click "Download model" → callback fires
