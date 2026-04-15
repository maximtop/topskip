# Validation Report: OpenRouter Multi-Block Promo Detection

**Validated**: 2026-04-15  
**Model**: Auto (Cursor Agent)  
**Spec**: `extension/.sdd/20260415-openrouter-multi-block-promo-detection/spec.md` (after archive rename)  
**Plan**: `extension/.sdd/20260415-openrouter-multi-block-promo-detection/plan.md` (after archive rename)

## Summary

| Category | Pass | Partial | Fail | Total |
|----------|------|---------|------|-------|
| Tasks | 21 | 0 | 0 | 21 |
| Requirements (FR-000–FR-021 + NFR) | 20 | 2 | 0 | 22 |
| Entities | 3 | 0 | 0 | 3 |
| Contracts | 2 | 0 | 0 | 2 |
| Guidelines (applicable subset) | 6 | 0 | 0 | 6 |
| Success Criteria | 4 | 2 | 0 | 6 |

**Overall Status**: **COMPLETE**

**Note**: This directory also contains `quick.md` (separate 2026-04-15 bugfix spec). It was not part of this validation scope; consider moving it to its own dated `.sdd/` folder for clarity.

## Task Status

### Phase: Shared / pure (Tasks 1–4)

- [x] **Task 1**: **PASS** — `src/shared/openrouter-llm-schema.ts`, `src/shared/promo-types.ts`, `tests/shared/openrouter-llm-schema.test.ts`; Vitest passes.
- [x] **Task 2**: **PASS** — `src/shared/captions/merge-transcript.ts`, `tests/shared/captions/merge-transcript.test.ts`.
- [x] **Task 3**: **PASS** — `src/shared/promo-dedupe.ts`, `tests/shared/promo-dedupe.test.ts`.
- [x] **Task 4**: **PASS** — `src/content/promo-skip-logic.ts`, `tests/content/promo-skip-logic.test.ts`.

### Phase: Background OpenRouter + storage (Tasks 5–7)

- [x] **Task 5**: **PASS** — `src/background/openrouter/openrouter-client.ts`, `tests/background/openrouter/openrouter-client.test.ts`; `Authorization` only in client.
- [x] **Task 6**: **PASS** — `src/background/openrouter/parse-llm-promo-response.ts`, `refinePromoBlocks`, tests under `tests/background/openrouter/`.
- [x] **Task 7**: **PASS** — `src/background/storage/openrouter-storage.ts`, `tests/background/storage/openrouter-storage.test.ts`.

### Phase: Messaging + analysis (Tasks 8–11, 17–18)

- [x] **Task 8**: **PASS** — `src/shared/messages.ts` includes OpenRouter + detection + custom model messages.
- [x] **Task 9**: **PASS** — `src/background/messaging/openrouter-runtime-messages.ts`, `tests/background/messaging/openrouter-runtime-messages.test.ts`.
- [x] **Task 10**: **PASS** — `src/background/messaging/promo-analysis.ts`, abort on `videoId` change, `LogPromoAnalysis`.
- [x] **Task 11**: **PASS** — `TOPSKIP_PROMO_BLOCKS_DETECTED` sent from `PromoAnalysis`.
- [x] **Task 17**: **PASS** — `caption-runtime-messages.ts` triggers analysis path.
- [x] **Task 18**: **PASS** — `src/background/openrouter/log-promo-analysis.ts`.

### Phase: Manifest + lifecycle + content (Tasks 12–14)

- [x] **Task 12**: **PASS** — `src/manifest.json`: `options_ui`, `https://openrouter.ai/*`, no static `content_scripts`.
- [x] **Task 13**: **PASS** — `src/background/lifecycle/content-scripts-registration.ts` register/unregister.
- [x] **Task 14**: **PASS** — `src/content/youtube-watch.ts` integrates promo skip + messages.

### Phase: UI + quality (Tasks 15–16, 19–21)

- [x] **Task 15**: **PASS** — `src/options/options.tsx`, `main.tsx`, `index.html`, Rspack options entry (plan cited `options-app.tsx`; actual name `options.tsx` — equivalent).
- [x] **Task 16**: **PASS** — `src/popup/PopupApp.tsx` options link + detection status path.
- [x] **Task 19**: **PASS** — `pnpm run test:coverage` meets thresholds.
- [x] **Task 20**: **PASS** — `pnpm run build && pnpm run test:e2e` — 3 tests passed (2026-04-15).
- [x] **Task 21**: **PASS** — `README.md`, `DEPLOYMENT.md`, `AGENTS.md` updated; `pnpm run lint` includes markdownlint.

## Requirement Status

| ID | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| FR-000 | Direct OpenRouter HTTP | IMPLEMENTED | `openrouter-client.ts` uses `fetch` |
| FR-001–FR-003 / 003b / 003c | Options UI, presets, custom models | IMPLEMENTED | `src/options/options.tsx`, `openrouter-model-presets.ts`, add/remove messages |
| FR-004–FR-008 | Local storage, background-only, Valibot gates | IMPLEMENTED | `OpenRouterStorage`, `PromoAnalysis` early returns |
| FR-009–FR-011 | Endpoint, merged transcript, JSON shape | IMPLEMENTED | `callOpenRouterChat`, `mergeCaptionSegmentsToTranscript`, `llmPromoDetectionSchema` |
| FR-012 | Parse, sort, dedupe | IMPLEMENTED | `parse-llm-promo-response.ts`, `promo-dedupe.ts` |
| FR-013 | Duration bounds for blocks | PARTIAL | `refinePromoBlocks` supports `durationSec`, but `PromoAnalysis` calls `parseLlmPromoResponse(..., undefined)` — no video duration wired from captions; seek-time clamp in content (`computePromoBlockTargetTime`) satisfies “at application time” |
| FR-014–FR-015 | Messaging + per-block skip | IMPLEMENTED | `messages.ts`, `promo-skip-logic.ts`, `youtube-watch.ts` |
| FR-016 | Stale `videoId` | IMPLEMENTED | `PromoAnalysis.inflight` + abort |
| FR-017–FR-018 | Popup status, sanitized errors | IMPLEMENTED | `PopupApp.tsx`, masked key on options |
| FR-019 | Docs | IMPLEMENTED | README / DEPLOYMENT / AGENTS |
| FR-020 | Developer logging | IMPLEMENTED | `log-promo-analysis.ts` |
| FR-021 | No inject when disabled | IMPLEMENTED | `content-scripts-registration.ts` |
| NFR-001–006 | Non-functional | IMPLEMENTED / PARTIAL | Async analysis; deterministic merge; one request per pass; tests per `vitest` — FR-013 gap affects NFR completeness marginally |

**Deviation (naming only)**: Spec “Runtime Messages” lists `TOPSKIP_ADD_CUSTOM_MODEL` / `TOPSKIP_REMOVE_CUSTOM_MODEL`; code uses `TOPSKIP_ADD_OPENROUTER_CUSTOM_MODEL` / `TOPSKIP_REMOVE_OPENROUTER_CUSTOM_MODEL` — same capabilities.

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
|--------|--------|---------------|------------|--------|
| OpenRouterConfig | OK (`customModels` in storage schema) | Background-owned | Valibot at storage | PASS |
| PromoBlock / detection status | OK | messages + store | Valibot + refine | PASS |
| Detection state by tab | OK | `PromoDetectionStore` | In-memory | PASS |

## Contract Status

| Artifact | Status | Notes |
|----------|--------|-------|
| `contracts/promo-detection-result.schema.json` | PASS | Aligns with `llmPromoDetectionSchema` |
| `contracts/openrouter-chat-completion.schema.json` | PASS | Documents response subset for implementers |

## Guidelines Compliance (AGENTS.md sample)

| Guideline | Status | Notes |
|-----------|--------|-------|
| MV3 + `browser.*` polyfill | COMPLIANT | `src/shared/browser.ts` |
| Storage / secrets in background | COMPLIANT | Options/popup use messages |
| No `@openrouter/sdk` | COMPLIANT | Direct `fetch` |
| `shared/` purity | COMPLIANT | I/O in background/content bundles |
| Lint + t strict | COMPLIANT | `pnpm run lint` clean |
| Tests for new logic | COMPLIANT | Vitest + E2E |

## Success Criteria Status

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| SC-001 | Caption → parsed status | MET | Pipeline + unit tests; manual smoke still valuable |
| SC-002–SC-003 | Manual video evaluation | CANNOT VERIFY | Per spec methodology — not CI gates |
| SC-004 | Multi-block seek behavior | MET | `promo-skip-logic.test.ts` + E2E fixture behavior |
| SC-005 / SC-005b | No spurious skip; console visibility | MET / PARTIAL | Unit tests + logs; full console audit manual |
| SC-006 | Key hygiene | MET | Grep: `Authorization` only in `openrouter-client.ts`; masked GET |
| SC-007 | CI commands | MET | `pnpm run lint`, `build`, `test`, `test:coverage`, `test:e2e` all pass (2026-04-15) |

## Issues Found

1. **FR-013 background duration**
   - **Location**: `src/background/messaging/promo-analysis.ts` (`parseLlmPromoResponse(..., undefined)`)
   - **Description**: Video duration is not passed into LLM block refinement; out-of-range blocks are not dropped in the background when duration could be known.
   - **Impact**: Rare false positives could reach the content script; seek clamp still mitigates bad end targets.
   - **Recommendation**: If player duration becomes available in the caption or a follow-up message, pass `durationSec` into `parseLlmPromoResponse`.

2. **Mixed SDD artifacts in `.current`**
   - **Location**: `.sdd/.current/quick.md` co-located with this feature’s spec/plan before archive.
   - **Recommendation**: After rename, move `quick.md` to a dedicated `.sdd/20260415-…` folder if you want one-spec-per-directory hygiene.

## Recommendations

- Wire **video duration** into `parseLlmPromoResponse` when the watch pipeline can supply it (closes FR-013 gap).
- Optionally align runtime message string names with the spec document for documentation parity only.
