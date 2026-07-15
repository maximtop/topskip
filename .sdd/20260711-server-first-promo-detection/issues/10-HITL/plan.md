# Implementation Plan: Private BYOK mode UX and enforcement

- **Created**: 2026-07-10
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/10-HITL/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: Approved an explicit `TopSkip Server` (default) / `Private BYOK` selector. BYOK reveals the retained provider setup, never falls back to the server, and the popup always identifies the selected mode. Mode changes start a different analysis route only on the next video; switching to BYOK may stop privacy-sensitive server polling immediately but must not start BYOK analysis for the current video. An unconfigured BYOK route must publish setup-required from a caption-independent watch-open preflight, including caption-success, capture-failure, captions-unavailable, and no-payload paths, without any server fallback or backend call.

## Summary

Complete the partially introduced `analysisMode` preference as an intentional product mode. Add a background-owned mode mutation contract, render a localized segmented mode selector before the existing model setup, and show provider/model controls only in Private BYOK mode. Lock content-side route selection to the current video so a preference broadcast cannot start the other route mid-video, while retaining background defense-in-depth checks that make TopSkip backend cache/client access unreachable whenever the persisted mode is BYOK. When a locked BYOK route opens, send a one-per-video background readiness preflight before caption outcome is known; an absent or unavailable selected adapter immediately publishes local-provider `not_configured`, even if caption capture later fails, captions are unavailable, or no caption payload arrives. Propagate the selected mode into popup state so the UI never implies shared server caching.

## Technical Context

- **Language/Version**: TypeScript 5.x in strict ESM mode
- **Primary Dependencies**: React 19, Mantine 9, MobX 6, Valibot, `webextension-polyfill`
- **Storage**: Background-only `browser.storage.local` through `PrefsSyncStorage`; UI and content bundles use runtime messages/ports
- **Testing**: Vitest 4 with mocked `@/shared/browser`; focused integration-style content/background tests
- **Target Platform**: Chrome Manifest V3 extension with background service worker, options page, popup, and YouTube watch content script

## Research

### Existing mode foundation

`src/shared/constants.ts` already defines `ANALYSIS_MODE`, `AnalysisMode`, the Valibot schema, and a server-default `analysisMode` field on `UserPreferences`. `PrefsSyncStorage` already migrates legacy rows to server mode. Issue 10 should preserve these definitions and expose a typed mutation path instead of creating a second setting.

### Current routing boundaries

`YoutubeWatch.syncVideoBinding` currently chooses between `REQUEST_SERVER_ANALYSIS` and caption capture from the latest in-memory preferences. `ServerAnalysisRuntimeMessages` reloads preferences before local-cache reads and backend requests/polls, while `CaptionRuntimeMessages` only forwards successful caption payloads in BYOK mode. Those guards already form the correct security boundary, but periodic binding and preference broadcasts can currently start a newly selected route on the current video. A current-video route lock is required.

### Caption-independent BYOK readiness

`CaptionRuntimeMessages.handle` returns immediately for failed caption payloads, and `PromoAnalysis.run` is entered only for successful payloads. Provider setup checks inside `PromoAnalysis.run` therefore cannot satisfy setup-required on watch open when capture times out, captions are unavailable, activation fails, or the content script never sends a caption payload. The content script must send a distinct `PREFLIGHT_BYOK_SETUP` message once when a video is first assigned the BYOK route. A background handler must re-check enabled/BYOK preferences, resolve the selected adapter from the injected `ProviderRegistry`, call only its local `availability()` readiness probe, and publish `{ videoId, status: 'not_configured', source: 'local_provider' }` when the adapter is absent or unavailable. The handler must not import or call server analysis/cache modules, and caption failures must not replace this setup state.

### Existing provider setup

The options page already owns model selection, connection-key setup, and custom OpenRouter models through `ModelSelectionPanel`, `ConnectionsPanel`, and `AddModelPanel`. These controls should remain intact and be conditionally revealed under Private BYOK. Server mode should not load a provider as a prerequisite or display provider setup as the normal flow.

### Popup state

`PreferencesStore` receives full preference snapshots from `GET_PREFS` and `PrefsPortHub`, but currently mirrors only `enabled` and provider metadata. `PromoDetectionStatePayload.source` supports `local_provider`; local provider analysis does not consistently populate it. The popup can identify the mode reliably by combining the persisted `analysisMode` with an explicit local-provider source on BYOK detection states.

### Localization

All new labels, descriptions, setup guidance, and active-mode text must be added to every `src/_locales/*/messages.json`. English source strings may be reused in locales without an available translation so lookups never render empty.

## Entities

### UserPreferences

- **Fields**:
    - `enabled: boolean` - master auto-skip switch
    - `providerId: string` - retained BYOK provider route
    - `activeModelId: string` - retained BYOK model selection
    - `analysisMode: 'server' | 'byok'` - selected analysis source
- **Relationships**: Persisted by `PrefsSyncStorage`, broadcast to content scripts and UI ports, consumed by options and popup state.
- **Validation**: `analysisModeSchema` accepts only `ANALYSIS_MODE.Server` or `ANALYSIS_MODE.Byok`; missing legacy values normalize to server.
- **States**: `server` (default) -> `byok` -> `server`; provider/model fields remain stored across either transition.

### CurrentVideoAnalysisRoute

- **Fields**:
    - `videoId: string`
    - `analysisMode: AnalysisMode`
    - `byokPreflightRequested: boolean` - prevents duplicate setup probes during polling or video-element replacement
- **Relationships**: Captured by `YoutubeWatch` when a new watch video is first routed; reset on SPA navigation to a different video ID.
- **Validation**: The route is created only after preferences and a supported video ID are available.
- **States**: `unassigned` -> `server` or `byok` for one video -> `unassigned` on the next video.

### ByokSetupPreflight

- **Fields**:
    - `videoId: string` - current watch video whose popup state may be updated
    - `status: 'inactive' | 'ready' | 'setup_required'` - acknowledgement to the content script
- **Relationships**: Requested by `YoutubeWatch` once for a locked BYOK route; resolved in the background from `PrefsSyncStorage` and `ProviderRegistry`; setup-required is stored only in the in-memory `PromoDetectionStore`.
- **Validation**: A sender tab ID, enabled preferences, persisted BYOK mode, and a non-empty video ID are required before probing. Missing/unavailable adapters map to `setup_required`; Server or disabled state maps to `inactive`.
- **States**: `unchecked` -> `ready` or `setup_required`; a different video starts again at `unchecked`.

### PromoDetectionStatePayload

- **Fields**:
    - Existing detection fields plus `source: 'local_provider'` for BYOK-originated states.
- **Relationships**: Written by `PromoAnalysis`, read by the popup through `PromoDetectionStore`.
- **Validation**: BYOK analysis must never emit `server`, `server_cache`, or `local_cache` as its source.
- **States**: `not_configured` -> `analyzing` -> `detected`, `no_promo`, or `error`, all retaining `local_provider` source.

## Contracts

No HTTP API changes are required. Add the extension runtime contract below in `src/shared/messages.ts`:

```ts
| {
      type: typeof TOPSKIP_MESSAGE.SET_ANALYSIS_MODE;
      analysisMode: AnalysisMode;
  }

export type SetAnalysisModeResponse =
    | { ok: true; prefs: UserPreferences }
    | { ok: false; error: string };

| {
      type: typeof TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP;
      payload: { videoId: string };
  }

export type PreflightByokSetupResponse =
    | { ok: true; status: 'inactive' | 'ready' | 'setup_required' }
    | { ok: false; error: string };
```

The background validates the incoming mode through the typed runtime router and `PrefsSyncStorage.save`, persists it without changing provider/model fields, broadcasts the full preference snapshot to tabs and ports, and returns that snapshot to the options page. `PREFLIGHT_BYOK_SETUP` is a separate content-to-background watch-open contract: it performs provider readiness I/O only, publishes setup-required through `PromoDetectionStore`, and has no server fallback, backend request, cache read, or result write.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/messages.ts` | Modify | Add mode mutation and BYOK watch-open preflight message/response contracts. |
| `src/background/messaging/runtime-messages.ts` | Modify | Persist a validated mode change and fan out the updated preference snapshot. |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Route mode mutation and BYOK preflight messages and inject the provider registry. |
| `src/background/messaging/byok-setup-runtime-messages.ts` | Create | Resolve caption-independent selected-provider readiness and publish local setup-required state. |
| `src/options/AnalysisModePanel.tsx` | Create | Render the explicit localized Server/BYOK segmented selector and privacy/setup copy. |
| `src/options/options.tsx` | Modify | Load and save analysis mode, render the selector, and reveal retained provider controls only in BYOK mode. |
| `src/content/youtube-watch.ts` | Modify | Lock route selection per video, send one BYOK setup preflight on watch open, and prevent mode broadcasts from starting the alternate route mid-video. |
| `src/background/messaging/caption-runtime-messages.ts` | Modify | Keep the BYOK-only caption boundary explicit and disabled-safe. |
| `src/background/messaging/promo-analysis.ts` | Modify | Re-check BYOK mode before provider work and tag all BYOK detection states as `local_provider`. |
| `src/popup/preferences-store.ts` | Modify | Mirror `analysisMode` from `GET_PREFS` and preference-port broadcasts. |
| `src/popup/PopupApp.tsx` | Modify | Display the selected mode and BYOK setup/status without server-cache implications. |
| `src/_locales/*/messages.json` | Modify | Add mode selector, mode status, and BYOK setup strings to every locale. |
| `tests/background/messaging/enabled-sync.test.ts` | Modify | Cover persistence and both preference fan-out paths for mode changes. |
| `tests/options/model-first-settings.test.ts` | Modify | Cover selector semantics and conditional provider setup visibility. |
| `tests/content/youtube-watch-skip-integration.test.ts` | Modify | Cover per-video route locking and next-video mode activation. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Prove BYOK mode performs no local server-cache or backend client access for request and poll handlers. |
| `tests/background/messaging/caption-runtime-messages.test.ts` | Modify | Prove only enabled BYOK mode enters provider analysis. |
| `tests/background/messaging/byok-setup-runtime-messages.test.ts` | Create | Cover ready/setup-required/inactive preflight results and prove caption outcomes and absent payloads are irrelevant. |
| `tests/background/messaging/promo-analysis.test.ts` | Modify | Cover setup-required/local-provider source and a mode re-check before provider calls. |
| `tests/popup/preferences-store.test.ts` | Modify | Cover initial and live mode synchronization. |
| `tests/popup/popup-view-model.test.ts` | Modify | Cover explicit Server/Private BYOK labels and no server-cache wording in BYOK states. |

## Tasks

### [x] Task 1: Add a background-owned analysis mode mutation

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/background/messaging/runtime-messages.ts`
- Modify: `src/background/messaging/register-runtime-messages.ts`
- Test: `tests/background/messaging/enabled-sync.test.ts`

- [x] **Step 1: Write the failing runtime preference tests**

Add tests that invoke the mode handler with `ANALYSIS_MODE.Byok` and assert that it preserves `enabled`, `providerId`, and `activeModelId`, saves the full preferences, broadcasts to content tabs and `PrefsPortHub`, and returns the saved snapshot. Add the inverse server transition and an error-path assertion.

```ts
const response = await PrefsRuntimeMessages.handleSetAnalysisMode(
    ANALYSIS_MODE.Byok,
);

expect(storageMocks.save).toHaveBeenCalledWith({
    ...currentPrefs,
    analysisMode: ANALYSIS_MODE.Byok,
});
expect(response).toEqual({
    ok: true,
    prefs: { ...currentPrefs, analysisMode: ANALYSIS_MODE.Byok },
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/background/messaging/enabled-sync.test.ts`

Expected: FAIL because `SET_ANALYSIS_MODE` and `handleSetAnalysisMode` do not exist.

- [x] **Step 3: Implement the contract and handler**

Add `TOPSKIP_MESSAGE.SET_ANALYSIS_MODE`, its `TopSkipRuntimeMessage` member, and `SetAnalysisModeResponse`. Implement `PrefsRuntimeMessages.handleSetAnalysisMode(analysisMode)` by loading current preferences, saving `{ ...current, analysisMode }`, then calling both existing fan-out mechanisms. Route the message in `registerRuntimeMessages`.

```ts
static async handleSetAnalysisMode(
    analysisMode: AnalysisMode,
): Promise<SetAnalysisModeResponse> {
    await PrefsSyncStorage.ready();
    try {
        const current = await PrefsSyncStorage.load();
        const prefs = { ...current, analysisMode };
        await PrefsSyncStorage.save(prefs);
        await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
        PrefsPortHub.broadcastPrefsUpdate(prefs);
        return { ok: true, prefs };
    } catch (error) {
        return { ok: false, error: getErrorMessage(error) };
    }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/background/messaging/enabled-sync.test.ts`

Expected: PASS, including mode persistence and both broadcasts.

**Verification**: A mode write occurs only in the background and never overwrites retained BYOK provider/model setup.

### [x] Task 2: Add the approved options mode selector and BYOK disclosure

**Files:**

- Create: `src/options/AnalysisModePanel.tsx`
- Modify: `src/options/options.tsx`
- Modify: `src/_locales/*/messages.json`
- Test: `tests/options/model-first-settings.test.ts`

- [x] **Step 1: Write failing options rendering tests**

Render the new panel in Server and BYOK modes. Assert accessible radio/segmented semantics, the labels `TopSkip Server` and `Private BYOK`, server as the selected default, and privacy copy that states BYOK uses the user's provider. Add an `OptionsApp`-level exported view helper or narrow component test proving model, connection, and custom-model panels render only when `analysisMode === ANALYSIS_MODE.Byok` while their state is retained.

```tsx
<AnalysisModePanel
    value={ANALYSIS_MODE.Server}
    disabled={false}
    onChange={onChange}
/>
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/options/model-first-settings.test.ts`

Expected: FAIL because `AnalysisModePanel` and conditional BYOK settings do not exist.

- [x] **Step 3: Implement mode loading, optimistic saving, and conditional UI**

Load `GET_PREFS` alongside `GET_MODEL_SETTINGS`, store `analysisMode`, and add an optimistic `onAnalysisModeChange` that sends `SET_ANALYSIS_MODE`, reverts on failure, and uses only localized user-visible text. Render `AnalysisModePanel` before provider settings. In Server mode render concise server/shared-cache copy; in BYOK mode reveal the existing three provider/model panels without clearing their data.

Use Mantine `SegmentedControl` (or an equivalent radio group with stable dimensions) for the two modes, not generic text buttons. Disable the control while its write is in flight to avoid reordering saves.

- [x] **Step 4: Add locale entries everywhere**

Add the selector heading, Server/BYOK labels, both descriptions, privacy/no-fallback note, setup-required text, and save-error text to every `src/_locales/*/messages.json`. Use the approved English source string where translations are unavailable.

- [x] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/options/model-first-settings.test.ts tests/shared/i18n/check-locale.test.ts`

Expected: PASS with both modes and locale parity covered.

**Verification**: Server is the normal first view; selecting BYOK intentionally reveals the existing provider setup, and switching away/back does not erase it.

### [x] Task 3: Lock route selection to a video lifecycle

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/content/youtube-watch.ts`
- Test: `tests/content/youtube-watch-skip-integration.test.ts`

- [x] **Step 1: Write failing navigation, preflight, and preference-broadcast tests**

Add a server-to-BYOK case proving that a mode broadcast on video A does not send `PREFLIGHT_BYOK_SETUP` or schedule captions for video A, and a BYOK-to-server case proving it does not send `REQUEST_SERVER_ANALYSIS` for video A. For an initially BYOK video, assert the content script sends exactly one preflight containing that video ID when the route is first assigned, before any caption result exists; repeated binding polls and a video-element swap must not duplicate it. Then navigate to video B and assert exactly the newly selected route starts. Also assert selecting BYOK clears pending server polling so no additional privacy-sensitive status request fires after the selection.

```ts
expect(sendMessage).toHaveBeenCalledTimes(1);
expect(sendMessage).toHaveBeenCalledWith({
    type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
    payload: { videoId: 'video-a' },
});

navigateToVideo('video-b');
expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
        type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
    }),
);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/content/youtube-watch-skip-integration.test.ts`

Expected: FAIL because `syncVideoBinding` currently reads the new global mode for the current video and there is no BYOK setup preflight contract or one-per-video marker.

- [x] **Step 3: Implement a current-video route lock and watch-open preflight**

Add `TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP`, `PreflightByokSetupPayload`, `PreflightByokSetupResponse`, and the corresponding `TopSkipRuntimeMessage` member. In `YoutubeWatch`, add private `analysisModeForCurrentVideo: AnalysisMode | null` and `byokPreflightVideoId: string | null`. Assign the route from current preferences exactly once when a non-null video is first routable, including the initial case where the video ID was observed before `GET_PREFS` completed; clear both fields only when the video ID changes.

Use the locked mode for server request, poll, preflight, and caption-scheduling decisions. For a locked BYOK route, set `byokPreflightVideoId` before sending `PREFLIGHT_BYOK_SETUP` so periodic sync cannot duplicate the request, then continue the existing caption schedule independently of the response. This ensures the readiness check runs even if capture later fails or never emits a payload and does not make provider readiness depend on captions. On `PREFS_UPDATED`, update the cached preferences and stop active server polling when the newly selected preference is BYOK, but do not clear route markers, preflight the current Server-routed video, or start the alternate analysis route. Periodic binding must continue to use the locked route.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/content/youtube-watch-skip-integration.test.ts tests/content/server-analysis-request.test.ts`

Expected: PASS with one route per video and the new mode used on the next video.

**Verification**: A mode switch never causes both server and BYOK analysis for the same video; every newly locked BYOK video sends one setup preflight without waiting for captions; returning to Server resumes local/server cache lookup only after a new video ID is observed.

### [x] Task 4: Add caption-independent BYOK readiness and enforce zero server access

**Files:**

- Create: `src/background/messaging/byok-setup-runtime-messages.ts`
- Modify: `src/background/messaging/register-runtime-messages.ts`
- Modify: `src/background/messaging/caption-runtime-messages.ts`
- Modify: `src/background/messaging/promo-analysis.ts`
- Test: `tests/background/messaging/byok-setup-runtime-messages.test.ts`
- Test: `tests/background/messaging/caption-runtime-messages.test.ts`
- Test: `tests/background/messaging/promo-analysis.test.ts`
- Test: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write failing preflight and defense-in-depth tests**

Create focused preflight tests with an injected registry and sender tab. For enabled BYOK, cover both an unknown selected provider and an adapter returning `PROVIDER_AVAILABILITY.UNAVAILABLE`; each must publish `{ videoId, status: 'not_configured', source: 'local_provider' }` and return `setup_required` without calling any caption or server/cache module. Cover an available adapter returning `ready` without writing setup-required, plus disabled and persisted Server states returning `inactive` without probing the adapter.

Prove caption independence with all required paths: (a) call only the preflight and send no caption payload, (b) preflight and then deliver a successful caption payload, and (c) preflight and then deliver failure payloads for `capture-timeout` and `captions-unavailable`. In every unconfigured case, `PromoDetectionStore` must contain or retain local-provider `not_configured`; neither failure payload may replace it with `unavailable` or `error`. The successful path may repeat the same readiness guard in `PromoAnalysis`, but must not be the first or only source of setup-required.

For both initial server requests and status refreshes, set persisted mode to BYOK and assert `ServerResultCacheStorage.loadFresh`, `ServerAnalysisClient.requestAnalysis`, `ServerAnalysisClient.requestJobStatus`, cache save, detection delivery, and tab delivery are untouched. For caption/provider handling, assert disabled or Server mode never invokes provider analysis; enabled BYOK with successful captions does. Add a mode-change race where captions were captured in BYOK but persisted mode is Server before `PromoAnalysis.run` reaches the adapter, and assert no adapter call.

- [x] **Step 2: Run the tests to verify failures expose missing checks/source data**

Run: `pnpm exec vitest run tests/background/messaging/byok-setup-runtime-messages.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/background/messaging/caption-runtime-messages.test.ts tests/background/messaging/promo-analysis.test.ts`

Expected: FAIL because the preflight handler/router do not exist and new disabled/race/source assertions are not yet satisfied.

- [x] **Step 3: Implement the preflight, preserve setup state on caption failure, and tighten BYOK execution**

Create static-only `ByokSetupRuntimeMessages` with an injected `ProviderRegistry`. Its `handle(payload, sender)` must require a sender tab ID, await/load `PrefsSyncStorage`, return `inactive` unless preferences are enabled and still BYOK, resolve only the selected adapter, and call `adapter.availability()`. If the adapter is absent or returns `PROVIDER_AVAILABILITY.UNAVAILABLE`, call `PromoDetectionStore.set(tabId, { videoId: payload.videoId, status: 'not_configured', source: 'local_provider' })` and return `setup_required`; return `ready` for the existing runnable availability states. Catch readiness failures into the typed error response without invoking another analysis source. Register the handler and inject the same production registry used by `PromoAnalysis` and `ProviderRuntimeMessages`.

Keep failed `CAPTIONS_FROM_CONTENT` handling diagnostic-only so it cannot overwrite an already published setup-required state. For successful captions, update `CaptionRuntimeMessages` to require both `prefs.enabled` and BYOK. In `PromoAnalysis.run`, require both again immediately before registry/provider work and return without setting a server-like state otherwise. Supply `source: 'local_provider'` on every state written by this run, including `not_configured`, `analyzing`, progressive/final `detected`, `no_promo`, `unavailable`, and `error`.

Do not import or call `ServerAnalysisClient` or `ServerResultCacheStorage` from the BYOK path. BYOK results remain delivered only through the existing tab message and in-memory `PromoDetectionStore`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/background/messaging/byok-setup-runtime-messages.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/background/messaging/caption-runtime-messages.test.ts tests/background/messaging/promo-analysis.test.ts`

Expected: PASS with setup-required established before captions, preserved across timeout/unavailable caption failures, repeated on successful-caption provider checks, and no server/cache interactions in BYOK.

**Verification**: Opening a video in unconfigured BYOK yields `not_configured`/setup-required whether captions succeed, fail, are unavailable, or never arrive, and cannot reach server cache lookup, job creation, polling, result persistence, backend calls, or fallback.

### [x] Task 5: Surface the selected mode in popup state and copy

**Files:**

- Modify: `src/popup/preferences-store.ts`
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/_locales/*/messages.json`
- Test: `tests/popup/preferences-store.test.ts`
- Test: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Write failing popup store and view-model tests**

Assert `PreferencesStore.load` and the prefs port copy `analysisMode`. Extend `buildPopupViewModel` inputs with `analysisMode` and assert every Server state exposes a localized `TopSkip Server` mode label while idle, setup-required, analyzing, detected, no-promo, and error BYOK states expose `Private BYOK`. For preflight-produced BYOK `not_configured`, assert setup guidance appears before any caption payload, still appears after simulated `capture-timeout` and `captions-unavailable` outcomes, names the selected provider, and contains no server/cache/fallback wording. Also cover the successful-caption `not_configured` state so popup behavior is identical regardless of how setup readiness was discovered.

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/popup/preferences-store.test.ts tests/popup/popup-view-model.test.ts`

Expected: FAIL because the store/view model do not carry analysis mode.

- [x] **Step 3: Implement mode-aware popup rendering**

Initialize `PreferencesStore.analysisMode` to Server, update it from both preference channels, and pass it to `buildPopupViewModel`. Add a stable, compact mode row/badge to the popup using localized labels. In BYOK mode, provider/model detail may appear beneath the mode label; in Server mode, do not present provider configuration as active. Ensure `local_provider` states use BYOK-specific copy and cannot enter server-cache branches.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/popup/preferences-store.test.ts tests/popup/popup-view-model.test.ts`

Expected: PASS across Server, configured BYOK, and setup-required BYOK states.

**Verification**: The popup always identifies the selected analysis mode, shows setup-required independently of caption availability, and never implies that BYOK watched video IDs or results are shared with TopSkip servers.

### [x] Task 6: Verify the complete mode workflow

**Files:**

- Verify all files listed above

- [x] **Step 1: Run issue-focused tests**

Run:

```bash
pnpm exec vitest run \
  tests/background/messaging/enabled-sync.test.ts \
  tests/background/messaging/byok-setup-runtime-messages.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/background/messaging/caption-runtime-messages.test.ts \
  tests/background/messaging/promo-analysis.test.ts \
  tests/content/server-analysis-request.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts \
  tests/options/model-first-settings.test.ts \
  tests/popup/preferences-store.test.ts \
  tests/popup/popup-view-model.test.ts \
  tests/shared/i18n/check-locale.test.ts
```

Expected: PASS.

- [x] **Step 2: Run static quality gates for touched code**

Run:

```bash
pnpm run lint:types
pnpm run lint:ox
pnpm run lint:eslint
pnpm run lint:md
pnpm exec oxfmt --check \
  src/shared/messages.ts \
  src/background/messaging/runtime-messages.ts \
  src/background/messaging/register-runtime-messages.ts \
  src/background/messaging/byok-setup-runtime-messages.ts \
  src/background/messaging/caption-runtime-messages.ts \
  src/background/messaging/promo-analysis.ts \
  src/content/youtube-watch.ts \
  src/options/AnalysisModePanel.tsx \
  src/options/options.tsx \
  src/popup/preferences-store.ts \
  src/popup/PopupApp.tsx \
  tests/background/messaging/enabled-sync.test.ts \
  tests/background/messaging/byok-setup-runtime-messages.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/background/messaging/caption-runtime-messages.test.ts \
  tests/background/messaging/promo-analysis.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts \
  tests/options/model-first-settings.test.ts \
  tests/popup/preferences-store.test.ts \
  tests/popup/popup-view-model.test.ts
```

Expected: PASS. If repo-wide formatting reports only unrelated pre-existing files, record that separately and keep all issue-owned files clean.

- [x] **Step 3: Run production build and manual route smoke test**

Run: `pnpm run build`

Then load `dist/`, select Private BYOK with an unconfigured provider, and open supported watch videos with the local backend running in three conditions: captions available, captions unavailable, and caption capture blocked/timed out. Confirm setup-required appears immediately from the watch-open preflight in every condition, including when no caption payload arrives, and confirm the backend receives no analysis/cache/status traffic. Configure the provider and confirm a caption-success video uses only the provider path. Switch to Server while the video remains open and confirm no server request starts for that video; navigate to a new watch video and confirm server/local-cache lookup resumes.

Expected: Build passes and the manual sequence matches all four acceptance criteria.

**Verification**: The implementation is ready for per-issue validation with no automatic fallback and no ambiguous active-mode UI.
