# Validation Report: YouTube web-client captions (developer / analysis)

**Validated**: 2026-04-14
**Model**: Composer (SDD validate)
**Spec**: `specs/20260414-youtube-web-client-captions-dev/spec.md`
**Plan**: `specs/20260414-youtube-web-client-captions-dev/plan.md`

## Summary

| Category | Pass | Partial | Fail | N/A | Total |
|----------|------|---------|------|-----|-------|
| Tasks | 10 | 0 | 0 | 0 | 10 |
| Requirements (P1) | 5 | 0 | 0 | 1 | 6 |
| Requirements (deferred) | 0 | 0 | 0 | 6 | 6 |
| Entities | 3 | 0 | 0 | 0 | 3 |
| Contracts | 0 | 0 | 0 | 1 | 1 |
| Guidelines (sampled) | 5 | 0 | 0 | 0 | 5 |
| Success Criteria | 0 | 2 | 0 | 2 | 4 |

**Overall Status**: **COMPLETE**

P1 caption retrieval, background logging, messaging, tests, and docs satisfy the specification. Deferred items (FR-D*, optional HTML transcript) remain out of scope. **SC-001** / **SC-002** are only fully demonstrable on live YouTube via manual service-worker inspection; unit tests use mocked `fetch` and parsers.

## Task Status

### Phase 1: Types and messages

- [x] **Task 1.1**: **PASS** — `src/shared/caption-types.ts` defines `CaptionSegment` and `TranscriptFetchResult`. Verified: `pnpm run lint:types` (2026-04-14).
- [x] **Task 1.2**: **PASS** — `TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT`, `CaptionsFromContentPayload`, `CaptionsFromContentAck`, and `TopSkipRuntimeMessage` in `src/shared/messages.ts`; developer/diagnostic comment on caption message.

### Phase 2: Pure parsing + unit tests

- [x] **Task 2.1**: **PASS** — `src/shared/captions/transcript-xml.ts` parses XML → segments; related JSON helpers under `src/shared/captions/`.
- [x] **Task 2.2**: **PASS** — Malformed/empty inputs covered in `tests/background/captions/transcript-xml.test.ts` and related tests; `pnpm run test`: **43 passed** (8 files).

### Phase 3: InnerTube + transcript fetch (content) and logging (background)

- [x] **Task 3.1**: **PASS** — `src/content/captions/youtube-transcript-fetch.ts` implements web-client-style flow (`ytInitialPlayerResponse` from page, timedtext GET, optional InnerTube `player` / `get_transcript` per flags). Network I/O lives in the **content** bundle (not the service worker), which matches AGENTS.md; transcript is forwarded to the worker for logging.
- [x] **Task 3.2**: **PASS** — `src/background/captions/log-transcript-dev.ts`: summary line, preview cues, chunked `console.info` for long lists.
- [x] **Task 3.3**: **PASS** — Human-readable `{ ok: false, error }` from `fetchYoutubeTranscript`; `tests/content/captions/youtube-transcript-fetch.test.ts` mocks failures (plan example cited 403; tests use other HTTP/error paths—equivalent FR-005 coverage).

### Phase 4: Wiring and triggers

- [x] **Task 4.1**: **PASS** — `CaptionRuntimeMessages` + `register-runtime-messages.ts`; validates payload; `logTranscriptForDeveloper` on success; `console.error` on invalid payload / forwarded failure.
- [x] **Task 4.2**: **PASS** — `WatchCaptions.scheduleForVideoId` debounced (~450ms) from `YoutubeWatch` on watch `videoId` change and initial `init` (not a keyboard shortcut). Skips e2e fixture host. Gated by `shouldActivateTopSkip` / watch URL via `YoutubeWatch` activation.

### Phase 5: Verification and docs

- [x] **Task 5.1**: **PASS** — `DEVELOPMENT.md` “Developer: caption fetch (diagnostic)” with service worker steps, debounce trigger, file pointers.
- [x] **Task 5.2**: **PASS** — `pnpm run lint`, `pnpm run test`, `pnpm run build` all succeed (2026-04-14); popup size warnings only; background does not import Mantine/React.

## Requirement Status

| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| FR-001 | Web-client-style caption access | **IMPLEMENTED** | `youtube-transcript-fetch.ts`, `page-player-response.ts`, `shared/captions/*`; not presented as official Google API |
| FR-002 | Current watch `videoId` only | **IMPLEMENTED** | `getWatchVideoIdFromSearch` + `WatchCaptions` with id from page; `scheduleForVideoId(null)` early exit; e2e host skipped |
| FR-003 | Developer-inspectable output in service worker | **IMPLEMENTED** | `log-transcript-dev.ts`; errors via `console.error` / forwarded payload |
| FR-004 | Structured segments | **IMPLEMENTED** | `CaptionSegment`; logs include `start` / `dur` / `text` in chunks |
| FR-005 | Clear error on failure in background | **IMPLEMENTED** | Failed fetch → message with `ok: false`; worker logs `[TopSkip captions]` error |
| FR-006 | MAY: HTML page | **N/A** | Optional; not implemented |
| FR-D01–FR-D06 | Deferred disclaimer | **N/A** | Deferred in spec |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
|--------|--------|---------------|------------|--------|
| CaptionSegment | `startSec`, `durationSec`, `text` | Many per successful fetch | Parser / JSON paths | **PASS** |
| TranscriptFetchResult | Union in `caption-types.ts` | Success includes `videoId`, segments | Error strings on failure | **PASS** |
| Target video | `videoId` from watch URL | One debounced fetch per id change (when dev flag on) | No fetch when not watch / no id / e2e | **PASS** |

## Contract Status

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| *(none)* | — | **N/A** | Internal `runtime` messages only |

**Internal messaging**: `TOPSKIP_CAPTIONS_FROM_CONTENT` with `CaptionsFromContentPayload` — content performs fetch, background logs (differs from plan table wording “command with videoId only” but matches implemented types).

## Guidelines Compliance (AGENTS.md — applicable)

| Guideline | Status | Notes |
|-----------|--------|-------|
| Three bundles; fetch in content; `shared/` pure | **COMPLIANT** | YouTube `fetch` under `src/content/captions/` |
| `browser.*` via `@/shared/browser` | **COMPLIANT** | `watch-captions.ts`, messaging |
| Prefs: only background `storage.sync` for prefs | **COMPLIANT** | Caption path does not add prefs writes |
| TypeScript strict | **COMPLIANT** | Payload parsing uses narrowing |
| JSDoc on public APIs | **COMPLIANT** | Matches repo conventions |

## Success Criteria Status

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| SC-001 | Transcript substance visible from background after success | **PARTIALLY MET** | **Code:** `logTranscriptForDeveloper`. **Tests:** mocked chains. **Manual:** `DEVELOPMENT.md` steps on real `/watch?v=…` with CC |
| SC-002 | Discernible error on failure in background | **PARTIALLY MET** | **Code:** `console.error`, failed payload path. **Tests:** mocked failures. **Manual:** full live-site matrix optional |
| SC-D01–D02 | Disclaimer | **N/A** | Deferred |

## Issues Found

1. **Documentation vs code: caption dev toggle default**
   - **Location**: `src/shared/constants.ts` (`CAPTION_TRANSCRIPT_DEV_ENABLED`), `DEVELOPMENT.md` (states default `false`).
   - **Description**: Source currently uses `true` for `CAPTION_TRANSCRIPT_DEV_ENABLED` while the developer guide describes `false` as the default for shipping.
   - **Impact**: Contributors may misunderstand whether caption network activity is on in a clean checkout.
   - **Recommendation**: Set the constant to `false` for default-off behavior, or update `DEVELOPMENT.md` to match the intentional default.

2. **Live YouTube not exercised in CI**
   - **Location**: E2E / Vitest vs `youtube.com`.
   - **Description**: Unit tests mock `fetch`; no Playwright assertion against live captions (plan: out of scope).
   - **Impact**: SC-001/SC-002 “MET” in production sense needs manual verification.
   - **Recommendation**: Keep `DEVELOPMENT.md` manual checklist; optional recorded fixtures (fragile).

3. **Plan Task 3.3 example status code**
   - **Location**: Plan text vs `youtube-transcript-fetch.test.ts`.
   - **Description**: Plan mentioned mocked 403; tests use other failure modes.
   - **Impact**: Traceability only.
   - **Recommendation**: Doc-only alignment in plan if desired.

## Recommendations

- Resolve **Issue 1** before a release candidate so defaults and docs agree.
- Optional: add coverage includes for `src/content/captions/**` if raising thresholds.
- Optional: **FR-006** extension page if non-developer transcript UI is prioritized later.
