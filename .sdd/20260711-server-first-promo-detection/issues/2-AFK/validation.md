# Issue Validation Report: Server Cache Hit Applies Promo Blocks

- **Validated**: 2026-07-06
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/2-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/2-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 7 | 0 | 0 | 7 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 5 | 0 | 0 | 5 |
| Guidelines | 9 | 0 | 0 | 9 |

**Overall Status**: COMPLETE

The implementation satisfies the issue scope. Canonical `pnpm run ...` commands are currently blocked before task execution by an unrelated untracked `pnpm-workspace.yaml` build-approval placeholder that causes `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`; equivalent local binaries were used to verify the implementation without changing workspace files.

## Task Status

- [x] **Task 1: Add Ready Response Contract Schemas** - PASS
  - Evidence: `src/shared/server-analysis-contract.ts` exports `promoBlockSchema`, `readyResponseSchema`, and `serverAnalysisResponseSchema`; `tests/shared/server-analysis-contract.test.ts` covers ready parsing, processing/ready union parsing, invalid `endSec`, and non-finite `startSec`/`endSec` rejection.
- [x] **Task 2: Return Ready From Backend Fixture Cache** - PASS
  - Evidence: `src/backend/cache-fixtures.ts` seeds `e2eFixture1`; `src/backend/analysis-api.ts` returns `200 ready` before the `202 processing` fallback; backend API and HTTP tests cover ready, processing, invalid JSON, invalid video ID, and oversized body behavior.
- [x] **Task 3: Parse Ready Responses In The Background Client** - PASS
  - Evidence: `src/background/server-analysis-client.ts` parses `serverAnalysisResponseSchema`; `tests/background/server-analysis-client.test.ts` covers processing, ready response parsing, metadata-only request body, and timeout handling.
- [x] **Task 4: Deliver Ready Blocks Through Existing Runtime Message Path** - PASS
  - Evidence: `src/background/messaging/server-analysis-runtime-messages.ts` validates matching `videoId`, sends `TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED` to the originating tab, stores `source: 'server_cache'`, and rejects mismatched ready responses without delivery; tests cover all these branches.
- [x] **Task 5: Show Server Cache Ready State In Popup** - PASS
  - Evidence: `src/popup/PopupApp.tsx` returns server-cache detected copy before Chrome Prompt API availability branches; all locale files include `popup_detection_server_cache_*`; popup view-model tests cover precedence for downloading, unavailable, and downloadable Chrome model states.
- [x] **Task 6: Prove Server Ready Blocks Trigger A Fixture Skip** - PASS
  - Evidence: `e2e/extension.spec.ts` includes the server-cache ready fixture test, and the official targeted Playwright run passed: `1 passed (9.4s)`.
- [x] **Task 7: Run Focused Regression Checks** - PASS
  - Evidence: focused Vitest passed `8` files / `66` tests; Rspack build passed with existing asset-size warnings; full extension e2e passed `10` tests. Direct oxlint, ESLint, markdownlint, and TypeScript checks passed. The only lint subcommand failure was `oxfmt --check .` on untracked `pnpm-workspace.yaml`, unrelated to this issue's source changes.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given the local backend has a ready cache entry for the current video and algorithm version, When the extension requests analysis, Then the backend returns normalized promo blocks without starting a new job. | MET | `BackendCacheFixtures.findReady` matches `e2eFixture1` + `server-v1`; `BackendAnalysisApi.handleAnalysisRequest` returns `{ statusCode: 200, body: ready }`; backend tests pass. |
| 2 | Given the extension receives ready promo blocks from the backend, When the current video ID matches, Then it forwards those blocks to the content script through the existing promo-block delivery path. | MET | `ServerAnalysisRuntimeMessages.handleRequest` sends `PROMO_BLOCKS_DETECTED` via `browser.tabs.sendMessage`; runtime tests verify delivery and popup store parity. |
| 3 | Given server-provided blocks are active, When playback naturally crosses a block start, Then TopSkip skips to that block's end exactly once. | MET | `YoutubeWatch.onPromoBlocksMessage` installs blocks into the existing `evaluatePromoBlocksSkip` path; focused content tests passed; targeted and full Playwright e2e confirmed skip past the seeded block end. |
| 4 | Given the backend returns blocks for a different video ID, When the extension processes the response, Then it does not apply those blocks to the current video. | MET | Runtime handler checks `response.videoId !== payload.videoId` before delivery, stores a server error state, and tests assert `tabs.sendMessage` is not called. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Server Cache Fixture Entry | OK: `videoId`, `algorithmVersion`, `source`, `promoBlocks` seeded in `src/backend/cache-fixtures.ts`. | OK: read by `BackendAnalysisApi` after request validation. | OK: seeded response is parsed through `readyResponseSchema`. | PASS |
| Ready Response | OK: `status`, `videoId`, `algorithmVersion`, `source`, `promoBlocks`. | OK: returned by backend, parsed by client, delivered to content, stored for popup. | OK: strict Valibot schema rejects extra/invalid/non-finite block values. | PASS |
| Server Analysis Response | OK: `processing` and `ready` union members. | OK: consumed by `ServerAnalysisClient` and runtime handler. | OK: `serverAnalysisResponseSchema` tests cover both branches. | PASS |
| Promo Block | OK: `startSec`, optional `endSec`, optional confidence enum. | OK: consumed by popup summary and content skip evaluator. | OK: finite, non-negative, and `endSec > startSec` enforced before delivery. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/health` | GET | PASS | `BackendAnalysisApi.health` and HTTP routing return the documented service metadata. |
| `/v1/analysis` ready cache hit | POST | PASS | Seeded `e2eFixture1` returns HTTP `200` with `ReadyResponse`. |
| `/v1/analysis` uncached request | POST | PASS | Valid uncached videos continue returning HTTP `202` `ProcessingResponse`. |
| `/v1/analysis` invalid request | POST | PASS | Malformed JSON and invalid bodies return typed HTTP `400` errors. |
| `/v1/analysis` oversized body | POST | PASS | HTTP layer returns typed HTTP `413` error. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Use TypeScript source files only for new source/test code. | COMPLIANT | New implementation and tests are `.ts` / `.tsx`; no runtime `.js` files were added. |
| Keep shared modules pure and put I/O beside the owning bundle. | COMPLIANT | Shared contract module is pure schema/types; backend HTTP/cache code is under `src/backend`; background fetch remains in `src/background`. |
| Use `browser.*` through `src/shared/browser.ts`, not global `chrome`. | COMPLIANT | Runtime delivery uses shared `browser`; tests mock the shared module. |
| Keep storage access in the background and communicate via runtime messages. | COMPLIANT | Content requests server analysis by message; background loads prefs and performs delivery. |
| Reuse existing promo-block delivery and content skip path. | COMPLIANT | Server cache hits send `PROMO_BLOCKS_DETECTED`; content uses the existing `evaluatePromoBlocksSkip` path. |
| Validate untrusted API/storage boundaries. | COMPLIANT | Backend requests/responses use Valibot; client parses backend JSON as `unknown` before schema validation. |
| Reject invalid promo timelines before seek logic. | COMPLIANT | `finiteTimelineSecSchema` rejects `Infinity`, `-Infinity`, and `NaN`; `promoBlockSchema` enforces `endSec > startSec`. |
| Localize new user-visible popup text. | COMPLIANT | New server-cache popup strings are in every `_locales/*/messages.json` file. |
| Run focused tests/build/e2e for changed behavior. | COMPLIANT | Direct local binaries passed focused Vitest, Rspack build, targeted e2e, and full e2e; canonical `pnpm` wrapper remains blocked by unrelated workspace config. |

## Issues Found

No issue-caused implementation defects were found.

External workspace blockers observed:

1. **Untracked pnpm build-approval placeholder blocks canonical commands**
   - Location: `pnpm-workspace.yaml` (untracked)
   - Description: `pnpm run test ...` fails before Vitest starts with `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`; `oxfmt --check .` also reports this untracked file as the only formatting failure.
   - Impact: Canonical `pnpm run ...` and Playwright `webServer.command` cannot be used directly until the workspace approval/config state is corrected, but local binaries verified the issue implementation.
   - Recommendation: Resolve or remove the untracked `pnpm-workspace.yaml` placeholder and approve the intended `esbuild` build-script policy separately from this issue.

## Verification Results

- `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/server-analysis-client.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/content/promo-skip-logic.test.ts tests/content/youtube-watch-skip-integration.test.ts tests/popup/popup-view-model.test.ts` - BLOCKED before Vitest by `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7` from the untracked workspace approval state.
- `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/server-analysis-client.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/content/promo-skip-logic.test.ts tests/content/youtube-watch-skip-integration.test.ts tests/popup/popup-view-model.test.ts` - PASS (`8` files, `66` tests).
- `./node_modules/.bin/rspack build --config rspack.config.ts` - PASS with existing Rspack asset-size warnings for popup/options bundles.
- `./node_modules/.bin/playwright test e2e/extension.spec.ts --grep "server cache hit applies promo blocks"` - PASS (`1` test).
- `./node_modules/.bin/playwright test e2e/extension.spec.ts` with fixture server pre-started via `./node_modules/.bin/serve e2e/fixtures -p 4173 -L` - PASS (`10` tests).
- `./node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin .` - PASS.
- `./node_modules/.bin/eslint .` - PASS.
- `./node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#coverage" "#.sdd" "#test-results" "#tmp"` - PASS.
- `./node_modules/.bin/tsc --noEmit` - PASS.
- `./node_modules/.bin/oxfmt --check .` - BLOCKED/UNRELATED: only reports untracked `pnpm-workspace.yaml`.

## Recommendations

- No implementation changes are required for `2-AFK`.
- Resolve the untracked `pnpm-workspace.yaml` / `esbuild` approval state so canonical `pnpm run lint`, `pnpm run test`, and Playwright webServer startup work without direct-binary workarounds.
