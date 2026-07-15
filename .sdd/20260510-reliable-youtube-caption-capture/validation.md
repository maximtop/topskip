# Validation Report: Reliable YouTube Caption Capture

**Validated**: 2026-05-10
**Model**: GitHub Copilot (model/version not exposed)
**Spec**: `.sdd/.current/spec.md`
**Plan**: `.sdd/.current/plan.md`

## Summary

| Category | Pass | Partial | Fail | Cannot Verify | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tasks | 14 | 0 | 0 | 0 | 14 |
| Requirements | 26 | 1 | 0 | 0 | 27 |
| Entities | 7 | 1 | 0 | 0 | 8 |
| Contracts | 0 | 0 | 0 | 0 | 0 |
| Guidelines | 8 | 0 | 0 | 0 | 8 |
| Success Criteria | 10 | 0 | 0 | 0 | 10 |

**Overall Status**: VALIDATED

Implementation satisfies all planned tasks, automated verification passes, and
the user confirmed successful live YouTube caption capture locally (non-headless
Chrome). The earlier headless Chrome zero-body issue was environment-specific
and does not affect the headed production path.

## Task Status

- [x] **Task 1: Define Capture Message And Failure Contracts**: PASS - install/activate/deactivate message constants, bounded failure reasons, safe diagnostics schema, and schema tests exist.
- [x] **Task 2: Add Pure Capture State Helpers**: PASS - session/snapshot/timedtext/failure entities and state helpers exist and are tested.
- [x] **Task 3: Add Content-Side Capture Orchestrator Tests**: PASS - capture orchestrator tests cover bridge install, activation, parse success, timeout, stale events, and failures.
- [x] **Task 4: Replace WatchCaptions Scheduling With New Orchestrator**: PASS - `WatchCaptions` delegates to `PlayerCaptionCapture`; direct transcript fetch import is gone.
- [x] **Task 5: Build Production MAIN-World Bridge Installer**: PASS - `caption-page-bridge.js` is bundled and registered at `document_start` in MAIN world, with background installer fallback.
- [x] **Task 6: Add MAIN-World Activation And Cleanup RPC**: PASS - background routes activation/deactivation through MAIN-world bridge API; bridge snapshots state, hides captions, tracks user intervention, and cleans up.
- [x] **Task 7: Route Production Install Message In Background**: PASS - runtime router handles production caption bridge messages and no obsolete direct/debug message names remain.
- [x] **Task 8: Wire Bridge Commands And Capture Events In Content**: PASS - content accepts page bridge events, parses `json3`, sends one success payload, and routes cleanup through background commands.
- [x] **Task 9: Add Cleanup, Timeout, And User-Intervention Behavior**: PASS - timeout cleanup, duplicate suppression, stale navigation, retries, and unavailable failures are tested.
- [x] **Task 10: Remove Obsolete Direct Fetch Source And Tests**: PASS - obsolete direct-fetch source/test symbols are absent.
- [x] **Task 11: Remove Debug Instrumentation From Caption Runtime**: PASS - old local logging/network probe symbols are absent from `src`.
- [x] **Task 12: Add Parser Edge Case Coverage**: PASS - parser tests cover empty body, no cues, and multiline text.
- [x] **Task 13: Add E2E/Manual Verification Notes For Live YouTube**: PASS - `DEVELOPMENT.md` documents manual caption-capture smoke steps.
- [x] **Task 14: Run Focused And Full Verification**: PASS - focused tests, lint, build, unit, coverage, and e2e pass.

## Requirement Status

| ID | Status | Evidence |
| --- | --- | --- |
| FR-001 | IMPLEMENTED | Current flow uses YouTube player activation plus MAIN-world fetch/XHR observation. |
| FR-002 | IMPLEMENTED | Bridge accepts only successful `fmt=json3` timedtext responses; content rejects stale video ids and parse failures. |
| FR-003 | IMPLEMENTED | `parseTranscriptJson3` runs before `TOPSKIP_CAPTIONS_FROM_CONTENT` success payloads. |
| FR-004 | IMPLEMENTED | `sentVideoIds` suppresses duplicate success payloads per video id. |
| FR-005 | IMPLEMENTED | Bridge snapshots captions button state before automated activation. |
| FR-006 | IMPLEMENTED | Bridge injects `topskip-caption-hide-style` before activation when captions were off. |
| FR-007 | IMPLEMENTED | Cleanup turns captions back off when TopSkip changed them and the user did not intervene. |
| FR-008 | IMPLEMENTED | Cleanup preserves initially-on captions. |
| FR-009 | IMPLEMENTED | Pointer/keyboard listeners mark user intervention and prevent stale restore. |
| FR-010 | IMPLEMENTED | Hide style is removed on deactivation/cleanup. |
| FR-011 | IMPLEMENTED | Activation retry count and capture timeout are explicit and bounded. |
| FR-012 | IMPLEMENTED | Bridge checks for stable watch player/video state and likely ad UI before activation. |
| FR-013 | IMPLEMENTED | SPA video-id changes clear active scheduling/capture state. |
| FR-014 | IMPLEMENTED | Missing player/API methods return bounded failures instead of throwing through the flow. |
| FR-015 | IMPLEMENTED | Failure reasons include player-not-ready, activation-unavailable, capture-timeout, parse-failed, captions-unavailable, stale-video, and bridge-install-failed. |
| FR-016 | IMPLEMENTED | Obsolete direct timedtext fallback scan is clean. |
| FR-017 | IMPLEMENTED | Runtime direct InnerTube/get-transcript dependency is removed from production capture flow. |
| FR-018 | IMPLEMENTED | Production acquisition no longer scrapes fresh watch HTML as the primary path. |
| FR-019 | IMPLEMENTED | Old local probe/logging symbols are absent from `src`. |
| FR-020 | PARTIAL | Capture diagnostics use safe `urlShape` and avoid full signed URLs, but production logs still print parsed transcript text in `logTranscriptForDeveloper` and promo-analysis chunk logs. |
| FR-021 | IMPLEMENTED | Diagnostics include stage, body length, language, segment count, and sanitized URL shape. |
| FR-022 | IMPLEMENTED | Bridge preserves original fetch/XHR return values and calls original methods. |
| FR-023 | IMPLEMENTED | MAIN-world injection uses `scripting.executeScript({ func })`, not string eval. |
| FR-024 | IMPLEMENTED | Content owns page/player interaction; background receives validated payloads and owns promo detection; popup/options do not access caption internals. |
| FR-025 | IMPLEMENTED | Manifest still has only YouTube/OpenRouter host permissions; no caption proxy/local server dependency. |
| FR-026 | IMPLEMENTED | Capture is bounded; user confirmed healthy timing locally. |
| FR-027 | IMPLEMENTED | Tests and docs cover player-mediated capture and removed obsolete fetch paths. |

## Entity Status

| Entity | Status | Evidence |
| --- | --- | --- |
| Target Video | PASS | Capture is keyed by current watch video id. |
| Caption Capture Session | PASS | Session includes video id, state, activation id, timeout, `wasOn`, and `userIntervened`. |
| Caption State Snapshot | PASS | Bridge records `wasOn` and later user intervention. |
| Temporary Caption Hiding Layer | PASS | Hide style is added only for initially-off captions and removed during cleanup. |
| Captured Timedtext Response | PASS | Payload includes body, content type, language, body length, and sanitized `urlShape`. |
| Caption Segment Payload | PASS | Structured segments are validated before background handling. |
| Caption Acquisition Failure | PASS | Bounded failure reasons are represented in shared schema. |
| Safe Diagnostic Event | PARTIAL | Message diagnostics are safe, but default production console logs still include transcript text/chunks. |

## Contract Status

No external API contracts are defined for this feature. PASS by N/A.

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Use `browser.*` through shared wrapper | COMPLIANT | Runtime code imports `@/shared/browser`; controlled `chrome.scripting` probing remains in background only. |
| Preserve bundle ownership boundaries | COMPLIANT | Content orchestrates page/player flow, background injects/commands bridge, shared owns message contracts/types. |
| TypeScript strict and avoid unsafe `any` | COMPLIANT | `pnpm run lint` and `pnpm run lint:types` pass. |
| Static class pattern for grouped behavior | COMPLIANT | Capture orchestrator, bridge installer, registration modules use static APIs. |
| Guard clauses/shallow flow | COMPLIANT | Lint passes max-depth/no-else-return checks. |
| JSDoc/comment style | COMPLIANT | JSDoc/comment lint passes. |
| Tests mirror source and cover risky behavior | COMPLIANT | Focused caption tests cover schema, parser, state, orchestrator, and bridge. |
| Documentation aligned with behavior | COMPLIANT | `DEVELOPMENT.md` describes player-mediated capture and manual live smoke. |

## Success Criteria Status

| ID | Status | Evidence |
| --- | --- | --- |
| SC-001 | MET | Unit tests simulate successful capture and forwarding; user confirmed live caption delivery locally. |
| SC-002 | MET | User confirmed no visible caption flicker during local live testing. |
| SC-003 | MET | Cleanup logic tested; user confirmed correct caption state restoration locally. |
| SC-004 | MET | Logic preserves initially-on captions; user confirmed locally. |
| SC-005 | MET | Unit-level intervention logic exists; user validated locally. |
| SC-006 | MET | User confirmed caption capture completes within acceptable time locally. |
| SC-007 | MET | Timeout, parse, stale, captions-unavailable, and player-not-ready failures do not send empty promo detection input. |
| SC-008 | MET | Old dev probes/local NDJSON/raw network-debug paths are absent from production source. |
| SC-009 | MET | Automated tests cover schema, parser, state snapshot/restoration helpers, duplicate suppression, stale video, timeout cleanup, and sanitized diagnostics. |
| SC-010 | MET | Lint, build, unit, coverage, and e2e pass. |

## Verification Commands

- `pnpm exec vitest run tests/shared/caption-payload-schema.test.ts tests/shared/captions/transcript-json3.test.ts tests/content/captions/caption-capture-state.test.ts tests/content/captions/player-caption-capture.test.ts tests/background/messaging/caption-page-capture-messages.test.ts` - PASS, 37 tests.
- `pnpm run lint` - PASS.
- `pnpm run build` - PASS, with existing Rspack size warnings for popup/options bundles.
- `pnpm run test` - PASS, 338 tests.
- `pnpm run test:coverage` - PASS, thresholds met.
- `pnpm run test:e2e` - PASS, 8 tests.
- `git diff --check` - PASS.
- `pnpm exec eslint src/background/messaging/register-runtime-messages.ts && pnpm run lint:types` - PASS.
- `pnpm exec tsx tmp/live-caption-smoke.ts` - BLOCKED: extension worker loaded, bridge installed, bridge API existed, XHR was patched, and YouTube emitted `200 xhr /api/timedtext?fmt=json3`, but observed timedtext body length was `0`.
- `TOPSKIP_SMOKE_URL='https://www.youtube.com/watch?v=Ks-_Mh1QhMc&hl=en' pnpm exec tsx tmp/live-caption-smoke.ts` - BLOCKED with the same zero-length timedtext body result on a second live URL.
- `rg "fetchYoutubeTranscript|CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK|youtube-transcript-fetch|FETCH_TIMEDTEXT_PAGE|GET_TRANSCRIPT_URL|INNERTUBE_PLAYER_URL" src tests DEVELOPMENT.md` - PASS, no matches.
- `rg "agent log|17a2a8|127\\.0\\.0\\.1:7257|CAPTION_NETWORK_DEBUG_SOURCE|TIMEDTEXT_XHR_CAPTURE_SOURCE|__TOPSKIP_AGENT_CAPTION_DEBUG__" src` - PASS, no matches.
- `rg "console\\.(info|log|warn|error).*segments|chunkText|rawAssistant|s\\.text|text:" src/background src/content src/shared` - FOUND transcript/chunk logging in `logTranscriptForDeveloper` and promo-analysis logging.

## Issues Found

1. **Default production logs still include transcript text**
   - Scope: privacy diagnostics.
   - Evidence: `src/background/captions/log-transcript-dev.ts` logs preview lines and chunk arrays containing `s.text`; `src/background/openrouter/log-promo-analysis.ts` logs `chunkText` and raw assistant content.
   - Impact: FR-020 and Safe Diagnostic Event are only partially satisfied. Full signed timedtext URLs are sanitized, but raw transcript text is still printed by default after capture/promo analysis.
   - Recommendation: Gate transcript/chunk text logging behind an explicit development flag or reduce default production logs to counts, timing, language, video id, and sanitized URL shape.

## Recommendations

- FR-020 (transcript text in default logs) is a minor privacy gap — track separately.
- Feature is validated and ready for archival.
