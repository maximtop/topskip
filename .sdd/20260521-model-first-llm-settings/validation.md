# Validation Report: Model-First LLM Settings

**Validated**: 2026-05-21
**Model**: GPT-5 Codex (medium)
**Spec**: `.sdd/20260521-model-first-llm-settings/spec.md`
**Plan**: `.sdd/20260521-model-first-llm-settings/plan.md`

## Summary

| Category | Pass | Partial | Fail | Cannot Verify | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tasks | 9 | 0 | 0 | 0 | 9 |
| Requirements | 31 | 0 | 0 | 0 | 31 |
| Entities | 6 | 0 | 0 | 0 | 6 |
| Contracts | 4 | 0 | 0 | 0 | 4 |
| Guidelines | 8 | 0 | 0 | 0 | 8 |
| Success Criteria | 12 | 0 | 0 | 0 | 12 |

**Overall Status**: VALIDATED

Implementation satisfies the model-first UX, OpenRouter/OpenAI connection
management, active-model migration, OpenAI routing, custom OpenRouter model
handling, popup labels, and regression coverage. During validation, one
custom-model removal gap was found and fixed: removing the active custom
OpenRouter model now repairs persisted `activeModelId` and broadcasts updated
prefs.

## Task Status

- [x] **Task 1: Shared Provider IDs and Detection Model Catalog**: PASS - `PROVIDER_ID.OpenAI` and `src/shared/detection-models.ts` define OpenRouter, OpenAI, Chrome built-in, and custom OpenRouter model IDs.
- [x] **Task 2: Model-First Preferences and Migration**: PASS - `activeModelId` is part of prefs, legacy provider-first rows migrate, and unknown IDs fall back to a valid default.
- [x] **Task 3: OpenAI Storage and Client**: PASS - `OpenAiStorage`, Responses API calls, and `/v1/models` key testing exist with unit coverage.
- [x] **Task 4: OpenAI Provider Adapter**: PASS - `OpenAiAdapter` implements availability and transcript analysis and is registered in the default registry.
- [x] **Task 5: Model Runtime Messages and Connection Tests**: PASS - model settings, active model, save key, and test key messages are implemented and dispatched.
- [x] **Task 6: Options Model-First Panels**: PASS - options page renders `ModelSelectionPanel`, `ConnectionsPanel`, and `AddModelPanel` instead of provider-first setup.
- [x] **Task 7: Popup Active Model Labels**: PASS - popup loads model-first settings and formats model before provider context.
- [x] **Task 8: Pipeline Routing and Regression Suite**: PASS - provider route is derived from selected model and provider adapter tests cover OpenAI routing.
- [x] **Task 9: Full Validation**: PASS - unit, lint, build, E2E, focused regression, and SDD markdown checks pass.

## Requirement Status

| ID | Status | Evidence |
| --- | --- | --- |
| FR-001 | IMPLEMENTED | `ModelSelectionPanel` exposes a primary "Detection model" control. |
| FR-002 | IMPLEMENTED | Rendered options page uses model selection; provider cards are not part of `OptionsApp` general settings. |
| FR-003 | IMPLEMENTED | `DetectionModel` includes stable `id`, label, provider metadata, model name, and setup requirement. |
| FR-004 | IMPLEMENTED | Model labels include provider context and setup copy for key/no-key behavior. |
| FR-005 | IMPLEMENTED | `SET_ACTIVE_MODEL` persists `activeModelId`, derived `providerId`, provider model config, and broadcasts prefs. |
| FR-006 | IMPLEMENTED | OpenRouter model IDs resolve to `PROVIDER_ID.OpenRouter` and update OpenRouter storage model. |
| FR-007 | IMPLEMENTED | OpenAI model IDs resolve to `PROVIDER_ID.OpenAI` and route through `OpenAiAdapter`. |
| FR-008 | IMPLEMENTED | Chrome built-in model ID resolves to `PROVIDER_ID.ChromePromptApi`. |
| FR-009 | IMPLEMENTED | `OPENAI_MODEL_PRESETS` ships GPT-5.2, GPT-5 mini, and GPT-5 nano presets. |
| FR-010 | IMPLEMENTED | API key controls live in `ConnectionsPanel`, separate from `ModelSelectionPanel`. |
| FR-011 | IMPLEMENTED | Missing active-model key shows "Connection required" and points to the connection entry. |
| FR-012 | IMPLEMENTED | Connection messages return masked keys only. |
| FR-013 | IMPLEMENTED | Chrome built-in model copy says no external API key is required. |
| FR-014 | IMPLEMENTED | Each connection row includes a `Test` action. |
| FR-015 | IMPLEMENTED | Key testing returns valid, invalid, or retryable error states without raw key exposure. |
| FR-016 | IMPLEMENTED | `TEST_CONNECTION_KEY` accepts a draft key and falls back to the saved key when omitted. |
| FR-017 | IMPLEMENTED | Connections include OpenRouter and OpenAI entries. |
| FR-018 | IMPLEMENTED | `AddModelPanel` adds OpenRouter custom model slugs. |
| FR-019 | IMPLEMENTED | Custom OpenRouter models are appended to the same model catalog. |
| FR-020 | IMPLEMENTED | OpenRouter slug validation checks format and verifies existence when a key is available. |
| FR-021 | IMPLEMENTED | Removing an active custom model repairs OpenRouter storage, persisted `activeModelId`, and prefs broadcasts. |
| FR-022 | IMPLEMENTED | Popup `providerLabel` formats as model first, provider second. |
| FR-023 | IMPLEMENTED | Popup still shows provider context after model label. |
| FR-024 | IMPLEMENTED | Not-configured states identify provider/model setup through model settings and popup labels. |
| FR-025 | IMPLEMENTED | `PrefsSyncStorage` migrates legacy provider prefs to equivalent active model IDs. |
| FR-026 | IMPLEMENTED | OpenRouter API keys/custom model lists remain in OpenRouter storage and OpenAI keys in OpenAI storage. |
| FR-027 | IMPLEMENTED | Provider registry/adapters remain internal; options and popup are model-first. |
| FR-028 | IMPLEMENTED | Popup/options use runtime messages; provider secrets remain background-owned. |
| FR-029 | IMPLEMENTED | `PrefsSyncStorage`, `OpenRouterStorage`, and `OpenAiStorage` remain sources of truth. |
| FR-030 | IMPLEMENTED | Adding providers now follows catalog/setup metadata and adapter registration. |
| FR-031 | IMPLEMENTED | Unit/render/E2E tests cover catalog, migration, connections, key testing, popup labels, routing, and options render. |

## Entity Status

| Entity | Status | Evidence |
| --- | --- | --- |
| Detection Model | PASS | `src/shared/detection-models.ts` defines model catalog and resolution. |
| Provider | PASS | Providers remain adapter-backed routes in the background registry. |
| Connection Entry | PASS | `ConnectionEntryMessage` and `ConnectionsPanel` represent OpenRouter/OpenAI key state. |
| Custom Model | PASS | OpenRouter custom slugs join the same model catalog and can be removed safely. |
| Active Model Choice | PASS | `activeModelId` persists active choice and derives provider route. |
| Model Availability | PASS | Runtime model messages expose `available` or `unavailable` based on connection state. |

## Contract Status

| Contract | Status | Evidence |
| --- | --- | --- |
| `TOPSKIP_GET_MODEL_SETTINGS` | PASS | Implemented in `ModelRuntimeMessages.handleGetSettings` and shared message types. |
| `TOPSKIP_SET_ACTIVE_MODEL` | PASS | Implemented in `ModelRuntimeMessages.handleSetActiveModel`. |
| `TOPSKIP_SAVE_CONNECTION_KEY` | PASS | Implemented for OpenRouter and OpenAI with masked response payloads. |
| `TOPSKIP_TEST_CONNECTION_KEY` | PASS | Implemented for OpenRouter and OpenAI draft/saved key validation. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Use `browser.*` through shared wrapper | COMPLIANT | Storage and runtime callers use `@/shared/browser`. |
| Preserve bundle ownership boundaries | COMPLIANT | Secrets and provider I/O stay in background; shared owns serializable contracts/catalog. |
| Background-owned storage for secrets | COMPLIANT | Options/popup receive masked status and send raw keys only through messages. |
| TypeScript strict and avoid unsafe `any` | COMPLIANT | `pnpm run lint` and `tsc --noEmit` pass. |
| Static class pattern for grouped behavior | COMPLIANT | Storage and messaging modules use static namespace classes. |
| Guard clauses/shallow flow | COMPLIANT | Lint passes max-depth/no-else-return checks. |
| JSDoc/comment style | COMPLIANT | JSDoc/comment lint passes. |
| Tests mirror risky behavior | COMPLIANT | Focused tests cover catalog, storage, messages, OpenAI, options, popup, and E2E. |

## Success Criteria Status

| ID | Status | Evidence |
| --- | --- | --- |
| SC-001 | MET | Options E2E verifies model-first settings; no provider selector interaction is required. |
| SC-002 | MET | Popup tests and E2E render the active model label in the compact popup UI. |
| SC-003 | MET | Chrome built-in model metadata has `requiresConnection: false` and no-key copy. |
| SC-004 | MET | OpenRouter missing key marks model unavailable and connection missing/required. |
| SC-005 | MET | OpenAI missing key marks model unavailable and connection missing/required. |
| SC-006 | MET | Keys live in provider storage and are not cleared by model switching. |
| SC-007 | MET | OpenRouter and OpenAI connection test actions are implemented and tested. |
| SC-008 | MET | Legacy provider-first prefs migrate to equivalent `activeModelId`. |
| SC-009 | MET | E2E checks no horizontal overflow at 360px, 768px, and 1024px. |
| SC-010 | MET | Model runtime and provider adapter tests verify routing through expected provider. |
| SC-011 | MET | Existing tests were updated and model-first tests were added. |
| SC-012 | MET | Runtime responses expose masked keys only; raw keys stay in background storage/messages. |

## Verification Commands

- `pnpm exec vitest run tests/background/messaging/openrouter-runtime-messages.test.ts tests/background/messaging/model-runtime-messages.test.ts` - PASS, 14 tests.
- `pnpm run test` - PASS, 57 test files, 357 tests.
- `pnpm run lint` - PASS.
- `pnpm run build` - PASS, with existing Rspack size warnings for popup/options assets.
- `pnpm run test:e2e` - PASS, 8 tests.
- `pnpm exec markdownlint-cli2 .sdd/20260521-model-first-llm-settings/spec.md .sdd/20260521-model-first-llm-settings/plan.md .sdd/20260521-model-first-llm-settings/contracts/runtime-messages.md .sdd/20260521-model-first-llm-settings/validation.md` - PASS.

## Issues Found

No remaining blocking issues.

Validation found and fixed one gap before final status: removing the active
custom OpenRouter model now repairs persisted model-first prefs and broadcasts
the valid default active model.

## Recommendations

- Remove obsolete provider-first options helpers and their old panel tests in a
  follow-up cleanup if they are no longer needed as compatibility exports.
