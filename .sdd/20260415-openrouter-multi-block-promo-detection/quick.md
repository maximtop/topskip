# Implementation Plan: Show saved API key indicator after Save

**Created**: 2026-04-15
**Status**: Implemented
**Implemented by**: GitHub Copilot GPT-5.4 medium
**Model**: Claude Sonnet 4.6
**Type**: Bug Fix
**Input**: "when I press save button, I see message that it was saved, but key input shows that key was not added"

## Problem

After the user enters an API key and clicks **Save**, the options page shows
"Saved." but the key input immediately becomes empty. The user has no indication
that a key is stored, so they believe their key was not saved (even though it
was).

## Research Findings

### Root Cause

`load()` in `OptionsApp` (`src/options/options.tsx`) always calls
`setApiKey('')` after a successful GET response:

```ts
// src/options/options.tsx  ~line 258
setApiKey('');   // ← always clears the field, even when a key is stored
```

The GET response from the background includes `apiKeyMasked` (e.g. `"****xxxx"`
returned by `OpenRouterStorage.maskApiKey`). That value is parsed into
`data.apiKeyMasked` by `parseGetOpenRouterConfigOk`, but **never stored in any
React state or shown in the UI**.

`onSave()` calls `load()` on success, so the sequence is:

1. User types key → `apiKey` state = `"sk-or-v1-abc…"`
2. User clicks Save → background saves the key, returns `{ ok: true }`
3. `onSave` calls `load()`
4. `load()` calls `setApiKey('')` → input becomes empty
5. User sees empty field and concludes the key was not saved

The save itself works correctly. The background's `handleSet` logic already
handles an empty `apiKey` string by keeping the existing key:

```ts
// src/background/messaging/openrouter-runtime-messages.ts  ~line 97
const apiKey = apiKeyRaw.length > 0 ? apiKeyRaw : current.apiKey;
```

### Patterns to Follow

- `parseGetOpenRouterConfigOk` already returns `apiKeyMasked: string | null`
  (line ~115 in `options.tsx`). The fix must use this already-available field.
- Other pieces of state loaded from the background (e.g. `customModels`,
  `modelChoice`) are stored in dedicated `useState` variables and rendered
  directly. Follow the same pattern for `savedApiKeyMasked`.
- The `TextInput` for API key already has a `description` prop showing static
  text. Change it to dynamic text based on `savedApiKeyMasked`.

### Edge Cases

- `savedApiKeyMasked` must be reset to `null` after the user explicitly saves
  with an empty key field (i.e. if they clear the key). Currently empty apiKey
  on save keeps the old key — this is intentional by design and the description
  must reflect it.
- `load()` is also called on component mount and on manual Reload. Both paths
  must update `savedApiKeyMasked`.
- `maskApiKey` returns `null` for an empty key, so `savedApiKeyMasked === null`
  means no key is stored — distinguish this from "unknown".

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/options/options.tsx` | Modify | Add `savedApiKeyMasked` state; update `load()`; update `TextInput` description |

## Solution

Add a single new piece of state `savedApiKeyMasked: string | null` to
`OptionsApp`. Populate it from `data.apiKeyMasked` inside `load()`. Show the
masked key in the `TextInput`'s `description` prop so the user sees "Saved key:
****xxxx — leave blank to keep it." when a key exists, and "No key saved yet."
when `null`.

Do **not** populate the `apiKey` input with the masked value (the save flow
sends `apiKey` to the background; pre-filling with a masked string would
overwrite the real key with garbage).

### Alternatives Considered

- **Pre-fill `apiKey` with `apiKeyMasked`**: Rejected. The `handleSet` handler
  uses `apiKeyRaw` directly when non-empty. Sending the masked value like
  `"****xxxx"` would replace the real key. Requires explicit sentinel comparison
  to suppress — unnecessary complexity.
- **Add a separate "Key saved ✓" badge only after Save**: Rejected. The
  indication should also appear on page load / Reload so users always know the
  current state.

## Tasks

### [x] Task 1: Add `savedApiKeyMasked` state and populate it in `load()`

**Files:**
- Modify: `src/options/options.tsx:197–260`

- [x] **Step 1: Add the new state variable**

  In `OptionsApp`, directly below the `saved` state declaration (around line 207):

  ```tsx
  const [saved, setSaved] = useState(false);
  const [savedApiKeyMasked, setSavedApiKeyMasked] = useState<string | null>(null);
  ```

- [x] **Step 2: Populate it inside `load()`**

  In `load()`, after `setModelChoice(nextModel)` and `setApiKey('')` (around line 258):

  ```ts
  setModelChoice(nextModel);
  setApiKey('');
  setSavedApiKeyMasked(data.apiKeyMasked);  // ← add this line
  ```

- [x] **Step 3: Build to verify no type errors**

  ```
  pnpm run build
  ```

  Expected: build succeeds with no TypeScript errors.

---

### [x] Task 2: Update the `TextInput` description to reflect saved-key state

**Files:**
- Modify: `src/options/options.tsx` (the `TextInput` for `apiKey`, around line 345)

- [x] **Step 1: Replace the static `description` string**

  Find:

  ```tsx
  <TextInput
    label="OpenRouter API key"
    placeholder="sk-or-…"
    type="password"
    autoComplete="off"
    value={apiKey}
    onChange={(e) => {
      setApiKey(e.currentTarget.value);
    }}
    description="Leave blank to keep the saved key."
  />
  ```

  Replace with:

  ```tsx
  <TextInput
    label="OpenRouter API key"
    placeholder="sk-or-…"
    type="password"
    autoComplete="off"
    value={apiKey}
    onChange={(e) => {
      setApiKey(e.currentTarget.value);
    }}
    description={
      savedApiKeyMasked !== null
        ? `Saved key: ${savedApiKeyMasked} — leave blank to keep it.`
        : 'No key saved yet.'
    }
  />
  ```

- [x] **Step 2: Build again**

  ```
  pnpm run build
  ```

  Expected: build succeeds.

---

### [ ] Task 3: Manual verification

- [ ] Load the extension from `dist/` in Chrome (`chrome://extensions` →
  Load unpacked → select `dist/`).
- [ ] Open the options page (right-click extension icon → Options, or
  `chrome://extensions` → Details → Extension options).
- [ ] **Before entering a key**: Confirm the description reads
  "No key saved yet."
- [ ] Enter any non-empty key (e.g. `sk-or-test-1234`) and click **Save**.
- [ ] After "Saved." appears, confirm:
  - The key input is empty (not pre-filled).
  - The description now reads "Saved key: ****1234 — leave blank to keep it."
- [ ] Click **Reload** without changing anything. Confirm the masked indicator
  persists.
- [ ] Click **Save** again with the key field empty. Confirm the saved indicator
  still shows the same masked key (the key was kept, not cleared).

## Final Verification

- [x] Run full test suite: `pnpm run test`
- [x] Run linter: `pnpm run lint`
- [x] Run build: `pnpm run build`
- [ ] Complete manual verification steps in Task 3

## Notes

No automated unit test is added here because `OptionsApp` is a React component
that calls `browser.runtime.sendMessage` internally and the codebase has no
existing options-page component tests (only the `PreferencesStore` MobX unit
tests in `tests/popup/`). The fix is a three-line change (one new `useState`,
one `setSavedApiKeyMasked` call, one changed `description` prop) that is fully
verifiable manually and through build type-checking.

Implementation notes:

- Added `savedApiKeyMasked` state in `OptionsApp` and populated it from
  `data.apiKeyMasked` inside `load()`.
- Kept the API key input empty after save to avoid ever writing the masked
  value back to storage.
- Updated the API key field description to show either `Saved key: ****xxxx -
  leave blank to keep it.` or `No key saved yet.` based on current stored
  state.
- Automated verification completed successfully with `pnpm run build`,
  `pnpm run lint`, and `pnpm run test`.
