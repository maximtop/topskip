# Implementation Plan: YouTube web-client captions (developer / analysis)

**Created**: 2026-04-12
**Status**: Validated
**Input**: Feature specification from `extension/.sdd/20260414-youtube-web-client-captions-dev/spec.md`
**Model**: Auto (agent-authored)
**Implemented by**: Auto (sdd-implement)
**Validated by**: Auto (sdd-validate)
**SDD Version**: v2.0.2-2-gdf44b20
**User Input**: None

## Summary

Implement **caption retrieval** for the **current YouTube watch-page video** using the same **class** of flow as third-party tools (watch / InnerTube `player` → caption track `baseUrl` → timed text XML), executed in the **MV3 service worker**, with **structured segments** logged to the **service worker console** (and clear errors on failure). **Video identity** comes from the **content script** (same rules as `shouldActivateTopSkip` / `getWatchVideoIdFromSearch`). **Reliability disclaimer** (FR-D*) and **optional HTML transcript page** (FR-006) are **out of scope** for this plan unless explicitly pulled in later.

## Technical Context

**Language/Version**: TypeScript **5.x** (strict), **ESM** (`package.json` → `"type": "module"`)

**Primary Dependencies**: **Rspack** (bundler), **React 19** + **Mantine 9** + **MobX** (popup only), **webextension-polyfill**, **Valibot** (prefs). Caption code: **no new UI framework in background**; use **`fetch`** in the service worker (allowed for `https://www.youtube.com/*` via existing `host_permissions`).

**Storage**: No new persisted storage required for P1; optional later: `chrome.storage.local` for last transcript if analysis pipeline needs it (spec: implementation detail).

**Testing**: **Vitest** 4.x (unit tests for pure parsers / URL guards); **Playwright** e2e exists but **live YouTube caption fetch** is fragile for CI—prefer **manual verification** on a real watch page for SC-001, or **mocked `fetch`** in unit/integration tests.

**Target Platform**: **Chrome** MV3 extension (`src/manifest.json` → `dist/`)

**Project Type**: Single-package extension repo (`extension/` package root)

**Performance Goals**: No formal SLA; avoid **single multi-megabyte `console.log`** for long videos—**chunk** or **summarize** segment counts per FR-004 / edge cases.

**Constraints**: **Undocumented** InnerTube behavior—implementation may break when YouTube changes; **no** new network hosts beyond existing YouTube permission unless justified. **Content script** must not hold prefs in `storage.sync` (unchanged). **Shorts** excluded by `shouldActivateTopSkip`—do not treat `/shorts/` as watch.

**Scale/Scope**: Developer inspection + future analysis; one fetch per explicit trigger (not continuous polling unless later specified).

## Project Structure

| Area | Change |
|------|--------|
| `src/shared/messages.ts` | Add new `TOPSKIP_*` message type(s) for caption fetch command + typed responses. |
| `src/shared/` | New types module for **caption segments** (e.g. `CaptionSegment`: `startSec`, `durationSec`, `text`) and shared error result shapes. |
| `src/background/` | New **caption fetcher** module (InnerTube + transcript download + XML parse); wire into **`runtime.onMessage`** (extend or new small registrar alongside prefs). |
| `src/content/youtube-watch.ts` (or `content.ts`) | **Trigger**: send message with **current `videoId`** only when page is an activated watch URL (reuse `getWatchVideoIdFromSearch` + `shouldActivateTopSkip`). |
| `rspack.config.ts` | No new entry if work stays in `background.js` / `content.js` bundles; add only if a dedicated chunk is needed. |
| `tests/` | Mirror layout: unit tests for parsers; optional mocked fetch tests. |

**Deferred (not in this plan)**: Post-install HTML (`HtmlRspackPlugin` new entry), FR-D disclaimer UI.

## Research

### InnerTube + caption tracks (web-client-style)

- **Reference behavior**: Tools such as [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) **GET** `https://www.youtube.com/watch?v={id}`, extract **`INNERTUBE_API_KEY`** from HTML, **POST** `https://www.youtube.com/youtubei/v1/player?key=...` with a **client context** (e.g. Android client name/version), read `captions.playerCaptionsTracklistRenderer.captionTracks[]`, use each track’s **`baseUrl`** (may strip `fmt=srv3`), **GET** transcript XML, parse segments (`start`, `dur`, text nodes).
- **Risks**: **`PoTokenRequired`**-style URLs, **consent** HTML (EU), **playability** errors (`LOGIN_REQUIRED`, bot checks). Background **`fetch`** from the extension may differ from Python `requests` (cookies, headers). Plan: implement **happy path** + **structured errors** logged in the service worker (FR-005).
- **Alternative**: Run fetch from **content script** (same origin as `youtube.com`)—possible, but centralizing in **background** keeps one implementation and matches “developer inspects service worker” story.

### Video identity (current watch only)

- **Existing code**: `getWatchVideoIdFromSearch` + `shouldActivateTopSkip` in `src/content/page-guards.ts` already define **watch** vs **Shorts** vs e2e fixture.
- **Rule**: Only message background when `shouldActivateTopSkip` is true and `videoId` is non-null—satisfies FR-002 and edge cases.

### XML parsing in the service worker

- Prefer **`DOMParser`** if available in the service worker context (Chromium: yes for `text/xml`), or a **small pure parser** for segment elements—**no** heavy XML dependency unless needed. **defusedxml**-style safety is less critical for server-trusted YouTube XML in-extension, but avoid **XXE** by not using unsafe XML features.

## Entities

### CaptionSegment

- **Fields**:
  - `startSec`: `number` — segment start time in seconds (from XML `start`).
  - `durationSec`: `number` — segment on-screen duration (`dur`, default `0` if missing).
  - `text`: `string` — segment text (strip HTML tags per product rules).
- **Relationships**: Many segments belong to one **TranscriptResult** for one **TargetVideo** (`videoId: string`).
- **Validation**: `startSec >= 0`, `durationSec >= 0`, `text` may be empty in edge cases; reject invalid XML at parse boundary.

### TranscriptFetchResult

- **Fields**:
  - `ok: true` → `videoId`, `languageCode?`, `segments: CaptionSegment[]`
  - `ok: false` → `error: string` (human-readable for logs)
- **Validation**: Produced only after InnerTube + HTTP steps complete or fail.

### TargetVideo

- **Fields**: `videoId: string` (11-char YouTube id from watch `v` param or e2e placeholder).
- **Relationships**: One optional transcript per fetch request.
- **Validation**: Must not fetch when `videoId` is null or page is not watch (content-side guard).

## Contracts

**N/A** — no external HTTP API owned by this product.

### Internal extension messaging (summary)

New runtime messages (names indicative; exact strings in `src/shared/messages.ts`):

| Direction | Purpose |
|-----------|---------|
| content → background | **Command**: fetch captions for `{ type, videoId }` where `videoId` matches current watch page. |
| background → content | **Optional**: not required for P1 if logging-only; omit or use for future UI. |

**Response shape** (background returns Promise to content): `{ ok: true, segmentCount: number, preview?: string }` **or** `{ ok: false, error: string }` — avoid returning full transcript to content if unnecessary for P1 (reduces message size); **full segments** must appear in **service worker** logs per FR-003.

Detailed TypeScript types live in `src/shared/messages.ts` and are enforced at handlers.

## Tasks

### Phase 1: Types and messages

- [x] **Task 1.1** (S): Add `CaptionSegment` / fetch result types under `src/shared/` (e.g. `caption-types.ts`) and export from a stable import path.
  - Prerequisites: None
  - Verification: `pnpm run lint:types` passes.

- [x] **Task 1.2** (S): Extend `src/shared/messages.ts` with a **single** new message type for “fetch captions for videoId” + response union; document in a short comment that it is **developer/diagnostic** until product UX is defined.
  - Prerequisites: Task 1.1
  - Verification: `pnpm run lint:types`; grep shows no duplicate `type` strings.

### Phase 2: Pure parsing + unit tests

- [x] **Task 2.1** (M): Implement **XML → `CaptionSegment[]`** parser in a **pure** module (e.g. `src/background/captions/transcript-xml.ts` or `src/shared/` if reusable), with HTML-tag stripping for cue text.
  - Prerequisites: Task 1.1
  - Verification: `pnpm run test` with fixtures (minimal XML strings in `tests/`).

- [x] **Task 2.2** (S): Add unit tests for **failure** inputs (malformed XML, empty transcript) returning sensible errors.
  - Prerequisites: Task 2.1
  - Verification: Vitest green; coverage if module is included in `vitest.config.ts`.

### Phase 3: InnerTube fetcher (background)

- [x] **Task 3.1** (L): Implement **watch HTML fetch** → **extract API key** → **POST InnerTube player** → **extract `captionTracks`** → pick language (e.g. `en` first) → **GET `baseUrl`** → parse with Task 2.1 parser. Use **`fetch`** + TypeScript strict typing for JSON **without** unsafe `as` where avoidable.
  - Prerequisites: Task 2.1
  - Verification: Manual: load unpacked extension, trigger fetch on a known captioned video; service worker console shows segments or a clear error.

- [x] **Task 3.2** (M): Implement **structured logging**: `console.info` / `console.error` with **segment count**, optional **first N segments** preview, **chunked** logs for long lists (edge case: long transcripts).
  - Prerequisites: Task 3.1
  - Verification: Manual inspection of service worker console; no single unusable megabyte string.

- [x] **Task 3.3** (S): Map YouTube / network failures to **human-readable** `TranscriptFetchResult` errors (FR-005).
  - Prerequisites: Task 3.1
  - Verification: Unit test with mocked `fetch` returning 403 / invalid JSON where feasible.

### Phase 4: Wiring and triggers

- [x] **Task 4.1** (M): Register a **background** `runtime.onMessage` handler (extend `PrefsRuntimeMessages` pattern or separate class) that validates message shape, calls fetcher, logs segments, returns **ack** to content.
  - Prerequisites: Tasks 1.2, 3.2
  - Verification: `pnpm run lint`; manual end-to-end on `youtube.com/watch?v=...`.

- [x] **Task 4.2** (M): From **content** (`YoutubeWatch` or `Content.init` path), **trigger** fetch only when `shouldActivateTopSkip` and `videoId` present—choose one explicit trigger (e.g. **keyboard shortcut** via `document` listener, **devtools-only** `window` hook, or **one-time** after player ready) documented in `DEVELOPMENT.md` for developers.
  - Prerequisites: Task 4.1
  - Verification: On non-watch pages, no fetch; on Shorts path (`shouldActivateTopSkip` false), no fetch.

### Phase 5: Verification and docs

- [x] **Task 5.1** (S): Document **manual verification** steps in `DEVELOPMENT.md` (open service worker inspector, run trigger, expect logs / errors).
  - Prerequisites: Task 4.2
  - Verification: Another developer can follow steps without reading source.

- [x] **Task 5.2** (S): Run `pnpm run lint` and `pnpm run build`; fix any bundle issues (background must not pull Mantine/React).
  - Prerequisites: Phase 4
  - Verification: CI-equivalent commands pass locally.

---

**Out of scope for this plan**: FR-D disclaimer, FR-006 HTML page, automated Playwright against live YouTube captions (optional follow-up with mocks or staging).
