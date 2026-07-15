# Validation Report: Promo Detection Accuracy & Developer Observability

**Validated**: 2026-04-15
**Model**: GPT-5.4 medium
**Spec**: `spec.md`
**Plan**: `plan.md`

## Summary

| Category | Pass | Partial | Fail | Total |
|----------|------|---------|------|-------|
| Tasks | 25 | 0 | 0 | 25 |
| Requirements | 7 | 0 | 0 | 7 |
| Entities | 5 | 0 | 0 | 5 |
| Contracts | 0 | 0 | 0 | 0 |
| Guidelines | 6 | 0 | 0 | 6 |
| Success Criteria | 3 | 1 | 0 | 4 |

**Overall Status**: COMPLETE

## Task Status

### Phase 1: Shared Foundations

- [x] **Task 1**: PASS - `src/shared/openrouter-llm-schema.ts` and `tests/shared/openrouter-llm-schema.test.ts` exist; targeted Vitest run passed.
- [x] **Task 2**: PASS - `src/shared/captions/merge-transcript.ts` and `tests/shared/captions/merge-transcript.test.ts` exist; targeted Vitest run passed.
- [x] **Task 3**: PASS - `src/shared/promo-dedupe.ts` and `tests/shared/promo-dedupe.test.ts` exist; targeted Vitest run passed.
- [x] **Task 4**: PASS - `src/content/promo-skip-logic.ts` and `tests/content/promo-skip-logic.test.ts` exist; targeted Vitest run passed.
- [x] **Task 5**: PASS - `src/background/openrouter/openrouter-client.ts` and `tests/background/openrouter/openrouter-client.test.ts` exist; targeted Vitest run passed.
- [x] **Task 6**: PASS - `src/background/openrouter/parse-llm-promo-response.ts` and `tests/background/openrouter/parse-llm-promo-response.test.ts` exist; targeted Vitest run passed.
- [x] **Task 7**: PASS - `src/background/storage/openrouter-storage.ts` and `tests/background/storage/openrouter-storage.test.ts` exist; targeted Vitest run passed.
- [x] **Task 8**: PASS - `src/shared/messages.ts` includes OpenRouter, detection-status, and promo-block runtime message types; current workspace terminal context shows `pnpm run lint` passed.

### Phase 2: Background Messaging And Analysis

- [x] **Task 9**: PASS - `src/background/messaging/openrouter-runtime-messages.ts` handles GET/SET/add/remove config; `tests/background/messaging/openrouter-runtime-messages.test.ts` passed.
- [x] **Task 10**: PASS - `src/background/messaging/promo-analysis.ts` gates on prefs/config, merges transcript, calls OpenRouter once, parses JSON, records status, and replaces in-flight work per tab; `tests/background/messaging/promo-inflight-contract.test.ts` passed.
- [x] **Task 11**: PASS - `src/background/messaging/promo-analysis.ts` sends `TOPSKIP_PROMO_BLOCKS_DETECTED` to the active tab after successful detection.
- [x] **Task 17**: PASS - `src/background/messaging/caption-runtime-messages.ts` forwards successful captions into `PromoAnalysis.onCaptionsReady`; disabled/misconfigured states are handled in `promo-analysis.ts` without extra fetches.
- [x] **Task 18**: PASS - `src/background/openrouter/log-promo-analysis.ts` centralizes the plain-text bundle; `tests/background/openrouter/log-promo-analysis.test.ts` passed.

### Phase 3: Extension Platform And UI

- [x] **Task 12**: PASS - `src/manifest.json` declares `options_ui` and `https://openrouter.ai/*`; current workspace terminal context shows `pnpm run build` passed.
- [x] **Task 13**: PASS - `src/background/lifecycle/content-scripts-registration.ts` registers/unregisters `content.js` from prefs using programmatic matches.
- [x] **Task 14**: PASS - `src/content/youtube-watch.ts` consumes `TOPSKIP_PROMO_BLOCKS_DETECTED` and uses `evaluatePromoBlocksSkip`; `pnpm exec playwright test e2e/extension.spec.ts --reporter=list` passed with 3/3 tests, including the no-legacy-jump fixture scenario.
- [x] **Task 15**: PASS - `rspack.config.ts` adds the `options` entry and emits `options.html`; `src/options/index.html`, `src/options/main.tsx`, and `src/options/options.tsx` exist and build successfully.
- [x] **Task 16**: PASS - `src/popup/PopupApp.tsx` opens the options page and polls/broadcasts detection status; Playwright popup-load test passed.

### Phase 4: Quality And Documentation

- [x] **Task 19**: PASS - `pnpm run test:coverage` passed with 23 files / 101 tests and reported thresholds satisfied.
- [x] **Task 20**: PASS - `pnpm exec playwright test e2e/extension.spec.ts --reporter=list` passed (3 tests).
- [x] **Task 21**: PASS - `README.md`, `DEPLOYMENT.md`, and `AGENTS.md` reflect the OpenRouter/options workflow; current workspace terminal context shows `pnpm run lint` passed.

### Phase 5: Accuracy And Observability Supplement

- [x] **Task S.1**: PASS - `src/background/openrouter/promo-detection-system-prompt.ts` defines the shared prompt and `promo-analysis.ts` plus `scripts/compare-openrouter-presets.ts` both use it.
- [x] **Task S.2**: PASS - `buildPromoAnalysisLogBundle()` emits one plain-text artifact with metadata, timed transcript, and promo start/end markers; `tests/background/openrouter/log-promo-analysis.test.ts` passed.
- [x] **Task S.3**: PASS - `promo-analysis.ts` short-circuits empty merged transcripts, logs success/error/no-promo bundles, and preserves raw assistant text when available.
- [x] **Task S.4**: PASS - `package.json` exposes `openrouter:compare-presets`; `scripts/fixtures/README.txt` documents the fixture workflow; `DEVELOPMENT.md` documents the maintainer comparison command.

## Requirement Status

| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| FR-001 | Extend detection instructions with inclusions and exclusions for promo blocks without a second production round-trip | IMPLEMENTED | `src/background/openrouter/promo-detection-system-prompt.ts`; `src/background/messaging/promo-analysis.ts` |
| FR-002 | Emit one developer log bundle with video metadata, transcript size/truncation, and parsed blocks | IMPLEMENTED | `src/background/openrouter/log-promo-analysis.ts`; `tests/background/openrouter/log-promo-analysis.test.ts` |
| FR-003 | Provide human-readable `[seconds] text` logging with enough context near promo starts | IMPLEMENTED | `buildPromoAnalysisLogBundle()` and marker excerpts in `src/background/openrouter/log-promo-analysis.ts`; tests passed |
| FR-004 | Provide an opt-in local/dev workflow to run all preset models on the same merged transcript | IMPLEMENTED | `scripts/compare-openrouter-presets.ts`; `package.json` script `openrouter:compare-presets`; saved report `tmp/logs/openrouter-compare-presets-v3eXTAqGkzg-20260415-132406.json` |
| FR-005 | Use user/CI API key only and document approximate cost | IMPLEMENTED | `scripts/compare-openrouter-presets.ts` reads `OPENROUTER_API_KEY`; `scripts/lib/openrouter-compare-summary.ts` calculates cost; `DEVELOPMENT.md` and `scripts/fixtures/README.txt` document cost and `.env` usage |
| FR-006 | Keep normal watch-page behavior on one selected model only | IMPLEMENTED | `src/background/messaging/promo-analysis.ts` uses exactly one stored `model`; preset comparison remains a standalone script |
| FR-007 | Show merged transcript and explicit promo start/end markers in the plain-text log bundle | IMPLEMENTED | `formatBlockMarkersSection()` in `src/background/openrouter/log-promo-analysis.ts`; `tests/background/openrouter/log-promo-analysis.test.ts` |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
|--------|--------|---------------|------------|--------|
| Merged transcript view | `text`, `truncated` | Produced from caption segments before analysis | `src/shared/captions/merge-transcript.ts`; `tests/shared/captions/merge-transcript.test.ts` | PASS |
| Analysis log bundle | `videoId`, `languageCode`, transcript budget, transcript lines, raw assistant, outcome | Built from `PromoAnalysis` inputs and outcomes | `src/background/openrouter/log-promo-analysis.ts`; `tests/background/openrouter/log-promo-analysis.test.ts` | PASS |
| Model comparison row | `model`, `ms`, `usage`, `pricing`, `costAnalysis`, `blocks`, `vsHuman` | One row per preset model in comparison output | `scripts/compare-openrouter-presets.ts`; `scripts/lib/openrouter-compare-summary.ts`; saved JSON report | PASS |
| OpenRouterConfig | `enabled`, `apiKey`, `model`, `customModels` | Stored in `browser.storage.local`; exposed to options via runtime messages | `src/background/storage/openrouter-storage.ts`; `tests/background/storage/openrouter-storage.test.ts`; `tests/background/messaging/openrouter-runtime-messages.test.ts` | PASS |
| PromoBlock | `startSec`, `endSec?`, `confidence?` | Used across parsing, dedupe, logging, popup summary, and content skipping | `src/shared/promo-types.ts`; `src/background/openrouter/parse-llm-promo-response.ts`; `src/shared/promo-dedupe.ts`; `src/content/promo-skip-logic.ts` | PASS |

## Contract Status

No `contracts/` directory exists under this spec directory, so contract verification was skipped.

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| — | — | SKIP | No `contracts/` directory or contract artifacts present under this spec |

## Guidelines Compliance

| Guideline | Status | Notes |
|-----------|--------|-------|
| OpenRouter settings remain background-owned storage with runtime messaging for UI/content | COMPLIANT | `OpenRouterStorage` writes `browser.storage.local`; popup/options/content use `runtime.sendMessage` |
| Extension APIs use the shared `browser.*` wrapper instead of the global `chrome` object | COMPLIANT | Verified across touched runtime files (`promo-analysis.ts`, `content-scripts-registration.ts`, `PopupApp.tsx`, `options.tsx`) |
| Shared modules stay pure while I/O lives in bundle-owned code | COMPLIANT | Merge/dedupe/schema helpers are in `src/shared/**`; fetch/logging/storage live under `src/background/**` and `scripts/**` |
| Static entry/init pattern is preserved for bundle entrypoints | COMPLIANT | `Background.init()`, `Options.init()`, and existing content/popup init patterns remain intact |
| Programmatic content script registration gates injection by prefs and build mode | COMPLIANT | `ContentScriptsRegistration` + `getWatchContentScriptMatches()` keep registration dynamic |
| Contribution checks were executed for relevant scopes | COMPLIANT | Observed successful `pnpm run lint` and `pnpm run build` in workspace context; ran `pnpm run test:coverage` and Playwright E2E successfully during validation |

## Success Criteria Status

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| SC-001 | On a reference transcript, at least one agreed sponsor window is detected with `startSec` within ±5 s of annotated start | MET | Saved comparison report shows multiple models within tolerance, including `google/gemini-3-flash-preview` max start delta 0.679 s and `openai/gpt-5.4` exact start alignment for all 3 human windows |
| SC-002 | A developer can answer what text the model saw near second T in under 2 minutes using only logs | CANNOT VERIFY | The implementation provides the required single log bundle with timed transcript and promo markers, but the human time-to-answer threshold was not timed during this validation |
| SC-003 | The multi-model comparison workflow produces a complete matrix for all preset slugs in one run on a fixture of at least 100 lines | MET | `tmp/logs/openrouter-compare-presets-v3eXTAqGkzg-20260415-132406.json` records `presetCount: 8`, `successfulCount: 8`; the real fixture documentation states 900 caption rows |
| SC-004 | From the plain-text log bundle alone, a developer can identify the intended promo start location without nested console objects or a second artifact | MET | `buildPromoAnalysisLogBundle()` includes explicit `>>> PROMO N START/END` markers and timed excerpts; `tests/background/openrouter/log-promo-analysis.test.ts` verifies marker presence |

## Issues Found

1. **Developer Documentation Still Contains MVP-Era Manual Checks**
   Location: `DEVELOPMENT.md`
   Description: The compare-presets workflow is documented, but the manual-check section still describes the old fixed `0:30 -> 1:00` skip flow and some earlier storage wording.
   Impact: Maintainers can be misled while validating or debugging the current LLM-driven behavior.
   Recommendation: Replace the stale fixed-window manual verification steps with current promo-block detection checks and clarify local storage vs. `.env` usage.

2. **Package Metadata Still Describes The Old Fixed Window MVP**
   Location: `package.json`
   Description: The package description still says “auto-skip 30s–1min on YouTube (MVP)”.
   Impact: Repo/package metadata no longer matches the implemented LLM-based promo detection feature set.
   Recommendation: Update the package description to match the current OpenRouter-driven behavior.

## Recommendations

- Update stale wording in `DEVELOPMENT.md` and `package.json` so maintainer-facing docs match the validated LLM promo-detection workflow.
- Add a short manual validation note for SC-002 if maintainers want to formally time the “find the text near second T” workflow in the future.