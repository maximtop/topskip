# Implementation Plan: TopSkip — YouTube Time-Based Auto-Skip (MVP)

**Input**: Feature specification from `/Volumes/dev/topskip/extension/specs/mvp/spec.md`
**Model**: Opus 4.6
**User Input**: None
**Status**: Validated (see `specs/mvp/validation.md`)

## Summary

Build a Chrome Manifest V3 extension that (1) auto-skips playback from **0:30 → 1:00** on `youtube.com` `/watch` pages when enabled, using the HTML5 video element’s `currentTime`, and (2) exposes a **React + Mantine** popup with a single **MobX-backed** toggle persisted in **`chrome.storage.sync`**, with changes propagating to open tabs immediately. The project is **greenfield**: scaffold **rspack** (multi-entry: background, content, popup), **Vitest** for unit tests, **Playwright** for integration tests, **ESLint**, **GitHub Actions**, and a **Makefile** per spec. No backend APIs.

## Technical Context

| Field | Value |
|--------|--------|
| **Language/Version** | TypeScript 5.x (strict), Node.js 20 LTS for tooling |
| **Primary Dependencies** | React 19.2+, Mantine 9+, MobX 6+, rspack, `@rspack/cli`, Vitest, Playwright, ESLint + typescript-eslint |
| **Storage** | `chrome.storage.sync` for `enabled: boolean` (default `true`) |
| **Testing** | Vitest (unit), Playwright (e2e against loaded extension + YouTube or fixture HTML) |
| **Target Platform** | Chrome MV3 extension (`manifest.json` v3) |
| **Project Type** | Single-repo browser extension (not a monorepo in MVP) |
| **Performance Goals** | Skip within ~200ms of crossing 30s (SC-001); toggle propagation &lt;500ms (SC-002) |
| **Constraints** | No network calls in MVP; minimal permissions (`storage` + `*://www.youtube.com/*`); must not skip during pre-roll ads; must distinguish playback vs manual seek |
| **Scale/Scope** | Single user, local extension; no server |

**Repository state**: `README.md` / `DEVELOPMENT.md` not present yet; implementation should add them per spec. No existing `src/` layout — structure below is proposed.

## Project Structure

Proposed layout under `/Volumes/dev/topskip/extension`:

```text
extension/
├── Makefile
├── package.json
├── tsconfig.json
├── rspack.config.ts
├── eslint.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── .github/workflows/ci.yml
├── dist/                      # rspack output (gitignored)
├── src/manifest.json          # MV3; emitted into dist by Rspack
└── src/
    ├── public/                # static assets if needed (icons, etc.)
    ├── background/
    │   ├── index.ts           # `Background.init()` only (entry)
    │   ├── background.ts      # class Background — register onInstalled + runtime messaging
    │   ├── storage/prefs-sync.ts   # class PrefsSyncStorage
    │   ├── messaging/               # PrefsRuntimeMessages, PrefsBroadcast
    │   └── lifecycle/on-installed.ts # class BackgroundInstallLifecycle
    ├── content/
    │   ├── index.ts           # `Content.init()` only (entry)
    │   ├── content.ts         # class Content — gate + `YoutubeWatch.init()`
    │   ├── youtube-watch.ts   # class YoutubeWatch — SPA nav, video binding, skip orchestration
    │   └── skip-logic.ts      # pure functions (tested by Vitest)
    ├── popup/
    │   ├── index.html
    │   ├── main.tsx           # `Popup.init()` only (entry)
    │   ├── popup.tsx          # class Popup — React root + Mantine + MobX Provider
    │   ├── PopupApp.tsx       # toggle UI
    │   └── preferences-store.ts  # MobX; messaging to background (no storage I/O)
    ├── shared/
    │   ├── constants.ts       # SKIP_START_SEC, SKIP_END_SEC, storage keys
    │   └── messages.ts        # message types (background ↔ content)
    └── types/
        └── chrome.d.ts        # if not fully covered by @types/chrome
```

**Build outputs**: rspack entries → `background.js`, `content.js`, `popup.js` (names aligned with `manifest.json`); copy `manifest.json` and `popup/index.html` into `dist/`; copy anything under `src/public/` into `dist/` when present.

**Documentation** (spec): root `README.md`, `DEVELOPMENT.md`, `DEPLOYMENT.md`, `AGENTS.md` — add in a docs/setup phase or parallel to first implementation milestone.

## Research

### YouTube SPA navigation and reset of skip state

YouTube navigates between videos without full reloads. The content script stays alive; listeners must reset **per-video** state when the watch URL’s `v=` parameter changes (and optionally on `yt-navigate-finish` / `yt-page-data-updated` if available). **Recommendation**: listen to `popstate` and `yt-navigate-finish` (when present), and poll or observe `location.href` / `new URLSearchParams(location.search).get('v')` as a fallback. Reset `skipAlreadyFired` and re-bind the active `<video>` when the video id changes.

**Sources**: [Chrome extension content scripts — isolated world](https://developer.chrome.com/docs/extensions/mv3/content_scripts/); community patterns for YouTube SPA (observe URL + events).

### Distinguishing “playback crosses 30s” vs “user seeks into 30–60s”

The spec requires: skip only when playback **crosses** 30s naturally; if the user **seeks** to e.g. 0:45, **do not** skip.

**Approaches**:

1. **`seeking` / `seeked` events**: Set a short-lived flag while the user is seeking; if crossing 30 happens during/just after seek, do not treat as auto-skip.
2. **Large `timeupdate` delta**: If `currentTime - previousTime` exceeds a threshold (e.g. &gt; 1.5–2s at normal speeds, tune for 2× playback), treat as seek and do not fire skip when landing in 30–60s.

**Recommendation**: Combine both — `seeking`/`seeked` for explicit seeks, plus delta cap for edge cases (keyboard jumps, chapter clicks).

### Pre-roll ads vs main video

YouTube often uses separate ad creatives; the **main** video element may not be the one advancing during ads. **Recommendation**: Prefer the video element that YouTube uses for the primary watch experience (often the largest visible player `#movie_player` / `video` inside it). Listen for transition from ad to content if needed (`yt-player-updated`, class names on player — brittle). **Minimum viable**: attach to the primary `video` in the watch page container and ignore `timeupdate` until duration &gt; 0 and `currentTime` progression matches “main content” (heuristic: skip logic only when `video.duration` is finite and above a small threshold). Document follow-up if ads falsely trigger.

### Monitoring `currentTime` (not `setTimeout`)

Use `timeupdate` (and optionally `requestAnimationFrame` for tighter checks) to read `video.currentTime`. **Recommendation**: primary path = `timeupdate` + stored `previousTime` for crossing detection and seek heuristics.

### Rspack + Chrome extension

Rspack supports multi-entry configs similar to webpack. Output separate bundles per entry; use `copy` plugin or build step for `manifest.json` and `popup.html`. Ensure **content_scripts** `matches` and **service_worker** path match `dist/` output.

**Source**: [Rspack configuration](https://rspack.dev/guide/start/introduction).

### MobX + popup + storage

Popup: MobX store loads `chrome.storage.sync` on open, toggles write back. **Background** or **storage.onChanged** in content script: on `enabled` change, content scripts update in-memory flag immediately (FR-008). **Recommendation**: content script subscribes to `chrome.storage.onChanged` for `sync` area keys used by the extension.

### Playwright + extension

Use Playwright’s `launchPersistentContext` with `--load-extension=path/to/dist` (Chromium) to load the unpacked extension; navigate to YouTube or a **local fixture page** with a `<video>` and known `src` to avoid flakiness. For CI, prefer **fixture HTML** for deterministic tests; add one smoke test on real YouTube if acceptable.

**Source**: [Playwright Chrome extensions](https://playwright.dev/docs/chrome-extensions).

### Vitest and DOM / Chrome APIs

Pure **skip math** and **seek detection** live in `skip-logic.ts` with injectable clock/previous time — no browser globals in those tests. Mock **`@/shared/browser`** (`runtime.sendMessage`) for **`PreferencesStore`** tests.

## Entities

### UserPreferences

| Field | Type | Description |
|--------|------|-------------|
| `enabled` | `boolean` | Master switch; default `true` |

- **Persistence**: `browser.storage.sync` under `topskip:prefs` — **background service worker only**; popup/content use **`runtime` messaging**.
- **Validation**: **Valibot** `userPreferencesSchema` (`enabled: boolean`); default on first install; corrupt storage reset to default.

### SkipState (per tab / per video session)

| Field | Type | Description |
|--------|------|-------------|
| `skipFired` | `boolean` | Whether 30→60 skip already executed for current video |
| `videoId` | `string \| null` | Current `v=` id; reset when id changes |

- **Relationships**: Derived from URL + SPA; not persisted.
- **Transitions**: On new `videoId`, `skipFired = false`. After successful skip, `skipFired = true`.

## Contracts

**N/A** — no HTTP API. Internal contracts only (informal):

| Direction | Purpose |
|-----------|---------|
| `browser.storage.sync` | Read/write `UserPreferences` — **background only** |
| `browser.runtime.sendMessage` | Popup/content ↔ background (`GET_PREFS`, `SET_PREFS`, `PREFS_UPDATED`) |
| `browser.tabs.sendMessage` | Background → content: push `PREFS_UPDATED` after writes |

No OpenAPI files under `/Volumes/dev/topskip/extension/specs/mvp/contracts/` for this feature.

## Tasks

### Phase 0: Repository scaffold

- [x] **Task 0.1** (M): Initialize npm package, TypeScript strict, path aliases if needed  
  - **Prerequisites**: None  
  - **Verification**: `npm run build` (stub) exits 0  

- [x] **Task 0.2** (M): Add rspack multi-entry config (background, content, popup), output to `dist/`, copy `manifest.json` + popup HTML  
  - **Prerequisites**: Task 0.1  
  - **Verification**: `npm run build` produces three JS bundles + manifest in `dist/`  

- [x] **Task 0.3** (S): MV3 `manifest.json` — `storage`, host permissions `https://www.youtube.com/*`, `content_scripts` for `/watch`, `action.default_popup`, `background.service_worker`  
  - **Prerequisites**: Task 0.2  
  - **Verification**: Load unpacked extension in Chrome; no manifest errors  

- [x] **Task 0.4** (S): ESLint + TypeScript-eslint; align with strict TS  
  - **Prerequisites**: Task 0.1  
  - **Verification**: `npm run lint` passes on scaffold  

- [x] **Task 0.5** (S): Vitest config + sample unit test  
  - **Prerequisites**: Task 0.1  
  - **Verification**: `npm run test` (unit) passes  

- [x] **Task 0.6** (M): Playwright config + load-extension smoke (fixture page with `<video>` optional)  
  - **Prerequisites**: Task 0.2  
  - **Verification**: `npm run test:e2e` runs (may be no-op test first)  

- [x] **Task 0.7** (S): Makefile — `setup`, `build`, `lint`, `test` (delegate to npm)  
  - **Prerequisites**: Tasks 0.4–0.6  
  - **Verification**: `make build`, `make lint`, `make test` work  

- [x] **Task 0.8** (S): GitHub Actions workflow — install, lint, build, unit test; cache npm  
  - **Prerequisites**: Task 0.7  
  - **Verification**: CI green on push  

### Phase 1: Shared logic and constants

- [x] **Task 1.1** (S): `src/shared/constants.ts` — `SKIP_START_SEC = 30`, `SKIP_END_SEC = 60`, storage key  
  - **Prerequisites**: Phase 0  
  - **Verification**: Imported by content + popup without circular deps  

- [x] **Task 1.2** (M): `src/content/skip-logic.ts` — pure functions: `computeSkipTarget(currentTime, duration, skipStart, skipEnd)`, `shouldFireSkip(prevTime, currentTime, skipFired, flags)` with seek-safe rules  
  - **Prerequisites**: Task 1.1  
  - **Verification**: Vitest covers: long video → 60; 45s video → 45; &lt;30s → no skip; seek jump → no skip; first cross 30 → skip once  

### Phase 2: Background + storage bridge

- [x] **Task 2.1** (M): `chrome.storage.sync` defaults on install (`enabled: true`)  
  - **Prerequisites**: Task 1.1  
  - **Verification**: Fresh profile load shows default enabled  

- [x] **Task 2.2** (S): Background script minimal — optional `onInstalled`; ensure single source of truth for storage key  
  - **Prerequisites**: Task 2.1  
  - **Verification**: No console errors in service worker  

### Phase 3: Popup UI (React + Mantine + MobX)

- [x] **Task 3.1** (M): MobX store: load/save `enabled`, optimistic toggle  
  - **Prerequisites**: Task 2.1  
  - **Verification**: Manual: toggle persists after popup close / browser restart  

- [x] **Task 3.2** (M): `PopupApp.tsx` — Mantine `Switch` + label (“Skip 30s–1min on YouTube”)  
  - **Prerequisites**: Task 3.1  
  - **Verification**: Popup opens &lt;300ms (manual stopwatch acceptable)  

### Phase 4: Content script — skip orchestration

- [x] **Task 4.1** (L): Resolve primary `HTMLVideoElement` on watch page; handle player replacement  
  - **Prerequisites**: Task 1.2  
  - **Verification**: Console log duration on real YouTube watch page  

- [x] **Task 4.2** (L): Subscribe `chrome.storage.onChanged` to flip local `enabled` immediately  
  - **Prerequisites**: Task 3.1, Task 4.1  
  - **Verification**: With video at 0:20, turn off toggle before 0:30 — no skip; turn on — still no skip if already past 30 until next video (per spec: skip fires when crossing 30; clarify edge case: if disabled before 30 then enabled before 30, skip should fire — add test)  

- [x] **Task 4.3** (L): `timeupdate` loop + seek detection + call skip logic; set `currentTime` to `min(60, duration)`  
  - **Prerequisites**: Task 4.2  
  - **Verification**: Manual YouTube long video crosses 30 → lands at 60  

- [x] **Task 4.4** (M): SPA: detect `v=` change; reset `skipFired` and re-bind video  
  - **Prerequisites**: Task 4.3  
  - **Verification**: Manual: two videos in a row both skip once  

- [x] **Task 4.5** (M): Exclude Shorts / livestream URLs heuristically (`/shorts/`, live badge / URL patterns)  
  - **Prerequisites**: Task 4.3  
  - **Verification**: Manual or URL-based unit test for pathname helpers  

- [x] **Task 4.6** (S): Brief on-page “Skip applied” toast (Mantine notification in shadow DOM or minimal div) — matches spec “brief visual indication”  
  - **Prerequisites**: Task 4.3  
  - **Verification**: User sees toast once per skip  

### Phase 5: Testing and hardening

- [x] **Task 5.1** (M): Vitest coverage for `skip-logic.ts` ≥80% of module branches  
  - **Prerequisites**: Task 1.2  
  - **Verification**: `vitest --coverage` meets threshold  

- [x] **Task 5.2** (L): Playwright: fixture page with `<video>`, programmatic `currentTime`, assert jump to 60s  
  - **Prerequisites**: Task 4.3, Task 0.6  
  - **Verification**: e2e passes in CI  

- [x] **Task 5.3** (M): Playwright or manual script: toggle off → no skip  
  - **Prerequisites**: Task 4.2  
  - **Verification**: documented in DEVELOPMENT.md  

### Phase 6: Documentation (spec)

- [x] **Task 6.1** (M): `README.md` — what it does, load unpacked, `make` commands  
  - **Prerequisites**: Phase 5  
  - **Verification**: New contributor can build  

- [x] **Task 6.2** (M): `DEVELOPMENT.md` — architecture, folders, testing real YouTube  
  - **Prerequisites**: Task 6.1  

- [x] **Task 6.3** (S): `DEPLOYMENT.md` — zip `dist/`, Chrome Web Store checklist  
  - **Prerequisites**: Task 0.2  

- [x] **Task 6.4** (S): `AGENTS.md` — conventions for AI agents (rspack entries, no `fetch` in MVP)  
  - **Prerequisites**: Task 6.2  

---

## Risk register

| Risk | Mitigation |
|------|------------|
| YouTube DOM/player changes | Isolate selectors; document breakage process |
| Ad vs main video mis-detection | Heuristics + follow-up task to align with `player.getVideoData()` if exposed |
| Seek vs play ambiguity | Dual `seeking`/delta heuristic; extensive unit tests |

## Out of scope (reminder)

AI detection, configurable ranges, stats, after-install page (see `TODO.md`), backend APIs.
