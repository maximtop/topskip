# Feature Specification: TopSkip — YouTube Sponsor Segment Skipper

**Created**: 2026-04-11
**Status**: Validated
**Implemented by**: GPT-5.2
**Validated by**: GPT-5.2 (gap closure: spec alignment, CI e2e, tests)
**Model**: Opus 4.6 (original spec author)
**Input**: User description: "lets start extension which will be skipping sponsor integrations in yt videos. mvp should skip youtube videos from 30sec to 1min. it should use rspack for building, react + mantine for ui, mobx as a state manager, typescript as language, vitest for unit testing, playwright for integration testing, eslint for linting, github actions for ci, makefile with main commands, agents.md, readme.md, development.md, deployment.md, support for chrome in mvp."

Clarifications from user:

- "for mvp we first should start with skipping videos without determination. in future I plan to use ai to determine timings which should be used for skipping."
- "just skip in all videos from 30 sec to 1 min, this is enough for testing that we know how to skip videos based on time. add toggle on popup, which will disable skip if we do not want to skip anymore."

## Assumptions

- **Automatic time-based skip (hardcoded range)**: Every YouTube video automatically skips the segment from 0:30 to 1:00. No detection, no user trigger — the content script monitors `currentTime` and jumps from 30s to 60s. This is a proof-of-concept to validate the skip mechanism before adding intelligent detection later.
- **Chrome Manifest V3**: The extension targets Manifest V3, as V2 is deprecated and new Chrome Web Store submissions require V3.
- **Vitest for unit testing**: Confirmed by user.
- **Playwright for integration testing**: Confirmed by user.
- **No external API dependencies**: The extension is entirely self-contained. No network calls, no third-party services. Pure client-side time-based logic.
- **Content script injection**: A content script runs on YouTube `/watch` pages, monitors the video element's `currentTime`, and performs the skip by setting `currentTime = 60` when it reaches 30.
- **Background service worker**: A Manifest V3 service worker manages the enabled/disabled preference and communicates it to content scripts. Minimal role in MVP.
- **Popup UI is minimal**: Just a toggle switch (enabled/disabled) with clear labeling. Built with React + Mantine for consistency with future iterations, but the surface area is intentionally tiny.
- **Videos shorter than 60 seconds**: If a video is shorter than 60 seconds, the skip range may partially or fully exceed the video duration. The extension should skip to the end of the video if it's between 30s and 60s long, and do nothing if it's under 30s.
- **Skip happens once per video load**: The 30s→60s skip triggers once. If the user manually seeks back into the 30–60s range, the extension does NOT re-trigger the skip (to avoid trapping the user in a loop).

## Product Vision & Roadmap Context

1. **MVP (current spec)**: Hardcoded auto-skip from 0:30 to 1:00 on all YouTube videos + popup toggle. Proves the plumbing works.
2. **Phase 2**: AI-powered detection of actual sponsor segment boundaries (start/end timestamps)
3. **Phase 3**: Cross-browser support (Firefox, Safari, Opera)
4. **Phase 4**: Community features, configurable ranges, per-channel settings

This spec covers only Phase 1 (MVP).

## User Scenarios & Testing

### User Story 1 — Auto-Skip the 30s–60s Range (Priority: P1)

A user navigates to any YouTube video. When the video playback reaches the 30-second mark, the extension automatically jumps the playhead to the 1-minute mark. The user sees a brief visual indication that a skip occurred.

**Why this priority**: This is the entire product in MVP. It validates that the extension can monitor video playback and manipulate `currentTime` reliably on YouTube.

**Independent Test**: Open any YouTube video longer than 1 minute. Let it play past 0:30. Verify it jumps to 1:00.

**Acceptance Scenarios**:

1. **Given** a YouTube `/watch` page with a video longer than 60 seconds and the extension enabled, **When** the video `currentTime` reaches 30 seconds, **Then** the video jumps to 60 seconds.
2. **Given** a YouTube video of 45 seconds total duration, **When** `currentTime` reaches 30 seconds, **Then** the video jumps to the end (45s), not beyond.
3. **Given** a YouTube video shorter than 30 seconds, **When** the video plays to completion, **Then** nothing happens — the extension does not interfere.
4. **Given** the extension already skipped the 30–60s range on a video, **When** the user manually seeks back to 0:25 and plays, **Then** the skip does NOT re-trigger.
5. **Given** the extension is disabled via the popup toggle, **When** a video plays past 0:30, **Then** no skip occurs.

---

### User Story 2 — Toggle Skip On/Off via Popup (Priority: P1)

The user clicks the extension's toolbar icon. A popup appears with a single toggle switch. When off, no skipping occurs on any video. When on (default), the auto-skip is active. The preference persists across browser sessions.

**Why this priority**: Equal to the skip itself. Without a way to disable it, the extension is hostile — forcibly skipping parts of every video with no recourse.

**Independent Test**: Toggle off, play a video past 0:30, verify no skip. Toggle on, reload or navigate to a new video, verify skip at 0:30.

**Acceptance Scenarios**:

1. **Given** the popup is open and the extension is enabled (default), **When** the user sees the toggle, **Then** it is in the "on" position.
2. **Given** the extension is enabled, **When** the user toggles it off, **Then** the currently playing video (and all subsequent videos) no longer skip at 0:30.
3. **Given** the extension is disabled, **When** the user toggles it on, **Then** skipping resumes. If a video is currently playing before the 30s mark, the skip will trigger when it reaches 30s.
4. **Given** the extension is disabled, **When** the user closes and reopens the browser, **Then** the extension remains disabled.
5. **Given** the extension is enabled, **When** the user closes and reopens the browser, **Then** the extension remains enabled.

---

### Edge Cases

- **YouTube SPA navigation**: YouTube is a single-page app. The content script must detect navigation to new videos (via `yt-navigate-finish` event or URL change observation) and reset the skip state for each new video.
- **Multiple YouTube tabs**: Each tab has its own content script instance. The enabled/disabled state is shared via the **background** (sync storage + runtime messages), but skip tracking (whether the skip already fired) is per-tab.
- **Video paused at 30s**: If the user pauses the video exactly at 30s and the extension is enabled, the skip should trigger (setting `currentTime` to 60), and the video remains paused at the new position.
- **User seeks past 30s manually**: If the user manually seeks to 0:45 (within the skip range), the skip should NOT trigger — it only triggers when `currentTime` crosses the 30s threshold during normal playback.
- **YouTube Shorts**: MVP does not target Shorts — only `/watch` pages. Content script should not activate on Shorts URLs.
- **Livestreams**: Skipping forward is meaningless on live content. The extension should not attempt to skip on livestreams.
- **Embedded videos**: MVP targets `youtube.com` only, not embedded iframes on third-party sites.
- **Fullscreen mode**: The skip must work identically in fullscreen — content scripts have access to the video element regardless of fullscreen state.
- **Ads playing before video**: YouTube pre-roll ads use a different video element or state. The skip must not trigger during ad playback — only on the main video content.

## Requirements

### Functional Requirements

- **FR-001**: The extension MUST automatically skip from 30s to 60s on YouTube `/watch` video pages when the extension is enabled.
- **FR-002**: The skip MUST be triggered by monitoring the video element's `currentTime` during normal playback (not by `setTimeout`), to correctly handle buffering, pausing, and variable playback speed.
- **FR-003**: The skip MUST fire at most once per video page load / SPA navigation. If the user seeks back into the skip range, the extension MUST NOT re-trigger.
- **FR-004**: If the video duration is less than 60 seconds but greater than 30 seconds, the extension MUST skip to the video's end rather than beyond it.
- **FR-005**: If the video duration is less than 30 seconds, the extension MUST NOT perform any skip.
- **FR-006**: The extension MUST provide a popup UI with a single toggle switch to enable/disable skipping.
- **FR-007**: The extension MUST persist the enabled/disabled preference via `browser.storage.sync` across browser sessions. **Only the background service worker** MUST read or write that storage key; the popup and content scripts MUST use **`runtime` messaging** to request reads/updates. Stored JSON MUST be validated (e.g. with **Valibot**) before use — no unchecked `as` casts on persisted data.
- **FR-008**: The toggle state change MUST take effect immediately on all open YouTube tabs without requiring a page reload (background applies writes, then notifies other extension contexts — e.g. `tabs.sendMessage` to content scripts).
- **FR-009**: The extension MUST handle YouTube SPA navigation, resetting skip state when the user navigates to a new video.
- **FR-010**: The extension MUST NOT interfere with ad playback — the skip must only apply to the main video content.
- **FR-011**: The extension MUST use Chrome Manifest V3 with minimal permissions: **`storage`**, **`tabs`** (to deliver preference updates to open tabs after a write), and host access for **`https://www.youtube.com/*`** (HTTPS). Development / CI builds MAY additionally include a **`http://127.0.0.1:*`** match solely so automated browser tests can load a local static fixture; release builds intended for the Chrome Web Store SHOULD omit that dev-only origin (see `DEPLOYMENT.md`).
- **FR-012**: The extension MUST NOT run TopSkip logic on arbitrary third-party origins. Production behavior targets **youtube.com** watch pages only; the optional localhost match in **FR-011** exists only for local e2e and MUST NOT be relied on for end-user behavior.
- **FR-013**: The skip MUST work in both normal and fullscreen video modes.
- **FR-014**: The popup UI MUST be built with React + Mantine.
- **FR-015**: The extension SHOULD NOT skip on YouTube Shorts or livestream pages.

### Key Entities

- **UserPreferences**: Single field — `enabled` (boolean, default `true`). Persisted under **`browser.storage.sync`** by the **background** service worker only; validated at the boundary with **Valibot**.
- **SkipState** (per tab): Tracks whether the skip has already been executed for the current video. Resets on navigation to a new video.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The skip executes (video jumps from ~30s to 60s) within 200ms of `currentTime` reaching 30 seconds.
- **SC-002**: The toggle state change propagates to all open YouTube tabs within 500ms.
- **SC-003**: The popup UI renders within 300ms of user click.
- **SC-004**: The extension adds no more than 5ms to YouTube page load time.
- **SC-005**: All unit tests pass with ≥80% code coverage on business logic (skip logic, preference management).
- **SC-006**: Integration tests verify: (a) skip triggers at 30s, (b) skip does not re-trigger on seek-back, (c) toggle disables skip, (d) skip works across SPA navigation.
- **SC-007**: The extension passes Chrome Web Store review requirements (Manifest V3 compliance, minimal permissions).
- **SC-008**: Zero console errors during normal operation on YouTube pages.

### Verification methodology (MVP)

| ID | How verified |
|----|----------------|
| **SC-001–004** | **Targets** for UX/perf. Not continuously measured in CI. Spot-check while debugging; see `DEVELOPMENT.md` manual YouTube steps. |
| **SC-005** | **Automated**: `pnpm run test` and `pnpm run test:coverage` (Vitest thresholds on `skip-logic.ts`, `page-guards.ts`, `src/popup/preferences-store.ts`). |
| **SC-006** | **(a)(c)** Playwright e2e (`e2e/extension.spec.ts`). **(b)** Unit tests on `evaluateSkipOnTimeUpdate` + `skipFired` (`tests/content/skip-logic.test.ts`). **(d)** Unit tests ensuring distinct `v=` values and SPA-related URL rules (`tests/content/page-guards.test.ts`); full in-browser SPA is covered by code paths in `youtube-watch.ts` + manual check in `DEVELOPMENT.md`. CI runs e2e **headless** (see `.github/workflows/ci.yml`). |
| **SC-007** | **Manual** pre-submit checklist in `DEPLOYMENT.md`; actual store approval is external to the repo. |
| **SC-008** | **Manual** smoke: open DevTools on a YouTube watch page with the extension enabled; no unexpected errors during normal playback (see `DEVELOPMENT.md`). |

## Technical Stack (User-Specified)

| Concern              | Choice               | Notes                                      |
|----------------------|----------------------|--------------------------------------------|
| Language             | TypeScript           | Strict mode                                |
| Bundler              | rspack               | Multi-entry (popup, content script, background service worker) |
| UI Framework         | React + Mantine      | Popup UI                                   |
| State Management     | MobX                 | Observable store for preferences            |
| Unit Testing         | Vitest               | Fast, Vite-compatible                      |
| Integration Testing  | Playwright           | Cross-browser future-proofing              |
| Linting              | ESLint               | With TypeScript plugin                     |
| CI                   | GitHub Actions       | Build, lint, test on push/PR               |
| Build Automation     | Makefile             | `make setup`, `make build`, `make lint`, `make test` |
| Target Browser (MVP) | Chrome (MV3)         | Firefox, Safari, Opera in future           |

## Documentation Requirements

| Document          | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `README.md`       | Project overview, quick start, feature summary           |
| `DEVELOPMENT.md`  | Local setup, architecture, coding conventions            |
| `DEPLOYMENT.md`   | Build for production, Chrome Web Store publishing steps  |
| `AGENTS.md`       | AI agent instructions for contributing to this codebase  |

## Future Roadmap (Out of MVP Scope)

- **AI-powered sponsor detection**: Replace hardcoded 30–60s range with intelligent identification of actual sponsor segment boundaries.
- **Configurable skip ranges**: Let users define custom time ranges or multiple skip zones.
- **Skip button / keyboard shortcut**: Manual skip trigger for on-demand use.
- **Undo mechanism**: Toast with "undo" to revert a skip.
- **Skip statistics**: Track skips performed and time saved.
- **Cross-browser support**: Firefox, Safari, Opera.
- **Per-channel settings**: Different behavior per YouTube channel.
- **Community segment database**: Crowd-sourced sponsor timestamps.

## Open Questions

None. The MVP scope is fully defined: auto-skip 30s→60s on all YouTube videos, popup toggle to disable. Everything else is future work.
