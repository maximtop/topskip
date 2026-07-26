# PRD Validation Report: LLM Provider Abstraction & Chrome Built-in AI Integration

**Validated**: 2026-04-18
**Model**: GPT-5.3-Codex (copilot) high
**PRD**: `.sdd/20260418-llm-provider-abstraction-chrome-built-in-ai-integration/prd.md`

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Issues | 9 | 0 | 0 | 9 |
| User Stories | 9 | 0 | 0 | 9 |
| Success Criteria | 8 | 0 | 0 | 8 |
| Guidelines | 8 | 0 | 0 | 8 |
| Cross-Cutting Audit | 3 | 1 | 0 | 4 |

**Overall Status**: COMPLETE

## Issue Status

| Issue ID | Title | Type | Status |
| --- | --- | --- | --- |
| 1 | Adapter interface + registry + OpenRouter adapter wrap | Architecture / Foundation | Validated |
| 2 | Unify `enabled` flags into `providerId` + migration | Architecture / Storage | Validated |
| 3 | Wire `PromoAnalysis` pipeline to registry | Architecture / Pipeline | Validated |
| 4 | Provider messaging + options provider selector UI | Feature / UI | Validated |
| 5 | Popup: display active provider & model label | Feature / UI | Validated |
| 6 | Chrome Prompt API adapter | Feature / Backend | Validated |
| 7 | Options: Chrome Built-in onboarding widget | Feature / UI | Validated |
| 8 | Popup: Chrome Built-in model readiness status | Feature / UI | Validated |
| 9 | OpenRouter model slug validation | Feature / UX | Validated |

## User Story Coverage

| Story | Title | Priority | Covered By | Status |
| --- | --- | --- | --- | --- |
| US-1 | Use Chrome Built-in AI for free promo detection | P1 | 6, 7 | MET |
| US-2 | See active provider and model in UI | P1 | 4, 5, 8 | MET |
| US-3 | Switch back to OpenRouter | P1 | 2, 3, 4 | MET |
| US-4 | Onboard through model download lifecycle | P1 | 7 | MET |
| US-5 | Add providers via adapter interface | P2 | 1, 3 | MET |
| US-6 | Automated tests verify provider switching | P2 | 1, 3, 6 | MET |
| US-7 | Validate custom OpenRouter model slugs | P2 | 9 | MET |
| US-8 | Abort in-flight analysis on provider switch | P2 | 2, 3, 4 | MET |
| US-9 | Popup shows model readiness status | P2 | 5, 8 | MET |

## Success Criteria Status

| ID | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| SC-001 | Free promo detection works with Chrome Built-in | MET | Chrome adapter and onboarding validated in issues 6 and 7; full test pipeline passes |
| SC-002 | Provider switching UX within 3 clicks | MET | Provider selector messaging/options validated in issue 4 and covered by e2e options panel switching |
| SC-003 | Popup shows provider/model quickly and readiness states | MET | Popup provider label and readiness status validated in issues 5 and 8 |
| SC-004 | New unit tests pass for routing/switching/availability/store | MET | `pnpm run test` passed with 267 tests including provider routing and slug validation suites |
| SC-005 | Third provider can be added without pipeline/storage/message rewrites | MET | Adapter interface + registry + pipeline indirection validated in issues 1/2/3 |
| SC-006 | Unavailable Chrome Built-in state is clearly communicated and safe | MET | Onboarding and options provider availability validated in issues 4 and 7; e2e and unit tests pass |
| SC-007 | Existing OpenRouter path remains intact | MET | Full lint/build/unit/e2e pipeline green; OpenRouter adapter and flow tests passing |
| SC-008 | Onboarding widget covers all availability states | MET | `tests/options/provider-panels.test.ts` includes unavailable/downloadable/downloading/available coverage |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| TypeScript strict and typed boundaries | COMPLIANT | All affected feature files are TS/TSX and pass `tsc --noEmit` |
| Shared contracts in `src/shared/messages.ts` only | COMPLIANT | Provider/message payload contracts centralized and reused |
| Runtime/storage responsibilities correctly separated | COMPLIANT | Storage in background; popup/options/content communicate via runtime messages |
| Static class namespaces for non-trivial background modules | COMPLIANT | Messaging and pipeline modules follow static namespace pattern |
| JSDoc requirements for `src/**` functions/methods | COMPLIANT | Issue validations show required JSDoc coverage and style compliance |
| No forbidden global `chrome` API use in feature paths | COMPLIANT | Feature code paths use `@/shared/browser` wrapper |
| Tests mirror source and verify behavior | COMPLIANT | Unit suites added under mirrored `tests/**` paths; behavior-focused assertions |
| Full verification before completion | COMPLIANT | Fresh run: `pnpm run lint && pnpm run build && pnpm run test && pnpm run test:e2e` all passed |

## Cross-Cutting Findings

### Critical Findings

None.

### High Findings

None.

### Medium Findings

None.

### Low Findings

#### 1. Popup “Not configured” label nuance differs from one issue narrative

- **Location**: `src/popup/PopupApp.tsx` (as noted in issue 5 validation)
- **Category**: Consistency
- **Problem**: Issue 5 narrative references a specific “Not configured” badge/label treatment for OpenRouter without key, while implementation uses existing status card and setup CTA without that exact badge text.
- **Suggestion**: Either add the explicit badge copy in popup hero or update issue narrative text to match current UX behavior.

## Overall Assessment

The full PRD scope is implemented and validated with all nine issues in Validated status and a clean verification pipeline. The provider abstraction, Chrome Built-in onboarding/readiness, and OpenRouter slug validation all behave consistently through shared runtime contracts and tested flows. The feature is safe for production use; the only identified gap is a low-severity UX wording/consistency nuance.

## Recommendations

- Keep current implementation as release-ready.
- Optionally align popup “Not configured” wording with issue 5 narrative for documentation/UI consistency.
- Continue future provider additions through the established adapter + registry pattern without expanding cross-bundle contracts unnecessarily.

## Follow-up: Chrome built-in AI disabled on 2026-07-26

The Chrome Prompt API provider this spec delivered is now **compiled out** of
all builds via `INCLUDE_CHROME_BUILTIN_PROVIDER` in `extension/build-modes.ts`.
The adapter, runtime messages, and shared contracts stay in the tree so a future
Gemini Nano can be re-measured by flipping one constant.

### Why

Measured on Chrome 150 / Gemini Nano, in the extension service worker, against
the human-annotated fixture (`scripts/fixtures/promo-v3eXTAqGkzg-*`, a
30.7-minute Russian video, 40,116 chars) using the shipped system prompt, chunk
planner, parser, and merge:

| | mean IoU | promo predicted | windows hit |
| --- | --- | --- | --- |
| Gemini Nano (on-device) | **0.054** | 730s (3.1x actual) | 0 of 3 |
| gemini-3-flash (cloud, from the fixture) | **0.747** | 199s (0.9x) | 3 of 3 |

The failure mode is visible in the raw responses: the model tiles a chunk into
consecutive spans and labels them all promo instead of discriminating. One
merged block spanned 12 contiguous minutes of the 30-minute video. One chunk
generated so many blocks that Chrome truncated the response after 48s of
inference. End to end 72-85s per video, byte-identical across repeats.

### Caveat that could reverse this

Russian is not among the languages the Prompt API accepts (`de, en, es, fr,
ja`); declaring it raises `NotSupportedError`, and the transcript was therefore
sent undeclared. An English-language fixture, or translating first through the
Translator API (stable since Chrome 138), is the untested variable.

### Defects found in the shipped adapter, unfixed while it is disabled

1. `maxTranscriptChars()` calibrates chars-per-token on `'a'.repeat(500)`.
   Measured 7.35 chars/token for that probe versus 2.36 for the real Cyrillic
   transcript — a **3.11x** budget overestimate that makes every chunk exceed
   the context window and fail.
2. `RESPONSE_TOKEN_RESERVE = 512` is too small for the number of blocks the
   model emits; responses hit Chrome's output limit and are truncated.
3. Session creation costs ~560ms with the real 835-token system prompt and is
   paid once per chunk plus once for the budget probe; `session.clone()` exists
   and preserves the initial prompt.

### Also confirmed

- The Prompt API **is** available in an MV3 extension service worker, despite
  Chrome's docs stating it "isn't available in Web Workers".
- Chrome 150 exposes both the `context*` and `input*` spellings of the session
  quota API, so the adapter's `contextWindow`/`measureContextUsage` usage is
  correct.

Measurement harness: `extension/tmp/nano-bench/` (gitignored, throwaway).
