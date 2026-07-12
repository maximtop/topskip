# Issue Validation Report: Private BYOK mode UX and enforcement

- **Validated**: 2026-07-11
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/10-HITL/issue.md`
- **Plan**: `.sdd/.current/issues/10-HITL/plan.md`
- **Validation attempt**: 2

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 6 | 0 | 0 | 6 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 2 | 0 | 0 | 2 |
| Guidelines | 5 | 0 | 0 | 5 |

**Overall Status**: COMPLETE

The prior validation gaps are resolved. The full repository quality gates pass,
and the new deterministic Playwright workflow exercises a local backend to prove
that BYOK produces no server request, a same-video mode change does not start a
server route, and a fresh Server-mode video does.

## Task Status

- [x] **Task 1**: Add a background-owned analysis mode mutation - PASS.
  `SET_ANALYSIS_MODE` persists through `PrefsSyncStorage`, retains provider and
  model settings, and fans out the saved snapshot to tabs and preference ports;
  this is covered by `tests/background/messaging/enabled-sync.test.ts`.
- [x] **Task 2**: Add the approved options mode selector and BYOK disclosure -
  PASS. `AnalysisModePanel` renders localized Server-default and Private BYOK
  choices, while `options.tsx` reveals retained provider controls only for BYOK.
  Unit and E2E options tests cover the intentional state transition.
- [x] **Task 3**: Lock route selection to a video lifecycle - PASS. The content
  lifecycle harness covers `PREFS_UPDATED`, poll cycles, video-element
  replacement, and navigation: no alternate route starts for video A and video
  B adopts the current mode.
- [x] **Task 4**: Add caption-independent BYOK readiness and enforce zero server
  access - PASS. Preflight checks only the local provider, preserves
  setup-required through caption failures, and server request/refresh handlers
  exit before cache or backend collaborators under persisted BYOK.
- [x] **Task 5**: Surface the selected mode in popup state and copy - PASS. The
  preferences store synchronizes `analysisMode`; popup view models show explicit
  mode and local-provider setup state without shared-cache wording.
- [x] **Task 6**: Verify the complete mode workflow - PASS. Full lint, build,
  unit/coverage, and 14-test Playwright suite pass. The local-backend E2E route
  workflow provides repeatable verification of the planned privacy/resumption
  smoke sequence.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | BYOK makes no TopSkip cache, job, status, or result-upload call. | MET | `server-analysis-runtime-messages.test.ts` asserts request/refresh collaborators are untouched in BYOK. Playwright `Private BYOK keeps the local backend idle until a fresh Server watch lifecycle` observes no backend traffic. |
| 2 | Configured BYOK captions use the selected provider without shared-cache writes. | MET | `CaptionRuntimeMessages` and `PromoAnalysis` require persisted enabled BYOK, tag state `local_provider`, and have no server cache/client path. Provider and source behavior is covered by focused tests. |
| 3 | Unconfigured BYOK shows setup-required without server fallback. | MET | `ByokSetupRuntimeMessages` resolves local-provider availability before caption outcome; focused tests cover absent, unavailable, ready, disabled, and Server states, while popup tests cover BYOK setup copy. |
| 4 | Switching BYOK to Server resumes server lookup only for a new video. | MET | Message-level lifecycle tests prove the route lock through broadcasts, polling, element replacement, and navigation. The local-backend E2E confirms a same-video switch is idle and a fresh video starts Server analysis. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| `UserPreferences` | OK | OK | Schema defaults legacy values to Server; mode writes retain provider/model settings. | PASS |
| `CurrentVideoAnalysisRoute` | OK | OK | Mode and preflight markers remain fixed per video and reset on ID change. | PASS |
| `ByokSetupPreflight` | OK | OK | Requires tab/video context, enabled BYOK preferences, and local adapter readiness. | PASS |
| `PromoDetectionStatePayload` | OK | OK | Every BYOK state is `local_provider`. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `TOPSKIP_SET_ANALYSIS_MODE` | Runtime message | PASS | Typed, background-owned persistence and preference fan-out. |
| `TOPSKIP_PREFLIGHT_BYOK_SETUP` | Runtime message | PASS | Typed watch-open readiness probe with no server fallback. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background-only preference storage | COMPLIANT | UI and content use runtime messages; persistence stays in `PrefsSyncStorage`. |
| BYOK bundle ownership and no server I/O | COMPLIANT | Provider readiness/analysis modules do not access server client or cache modules. |
| Localized user-visible copy | COMPLIANT | Mode and setup keys are present across locale files; locale checks pass. |
| TypeScript, lint, and formatting rules | COMPLIANT | `pnpm run lint` passes fully. |
| Required quality gates | COMPLIANT | Build, unit/coverage, and E2E pass; build emits only existing Rspack asset-size warnings. |

## Issues Found

None.

## Checks Run

- `pnpm run lint`: PASS.
- `pnpm run build`: PASS; Rspack reports non-blocking popup/options asset-size warnings.
- `pnpm run test`: PASS, 71 files and 543 tests.
- `pnpm run test:coverage`: PASS, 71 files and 543 tests; configured thresholds pass.
- `pnpm run test:e2e`: PASS, 14 Playwright tests, including the local-backend BYOK/no-server/new-video-Server workflow.

## Recommendations

- No further issue-10 work is required.
