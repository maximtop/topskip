# Server Gemini Promo Analysis

**Created**: 2026-07-15
**Status**: Implemented
**Type**: Backend integration

## Problem

The backend promo-analysis worker used a deterministic local fixture in normal
development, so extracted YouTube subtitles did not produce real promo
boundaries. The extension could exercise polling and display paths, but Server
mode could not perform its primary analysis function.

## Decision

Use OpenRouter with the fixed `google/gemini-3.5-flash` model as the only
non-test backend analysis adapter. Send the selected transcript as timed lines
and request `reasoning.effort=high` while excluding reasoning text from the
response. Keep deterministic analysis fixtures available only under
`NODE_ENV=test`.

The existing backend HTTP and extension runtime contracts remain unchanged.
The background service worker owns backend HTTP, content receives validated
promo blocks and seeks to each future `endSec`, and the popup renders those same
intervals through the existing detection store.

## Requirements

- `make server` loads the root gitignored `.env` while preserving an exported
  shell value and exits before listening when `OPENROUTER_API_KEY` is missing or
  blank.
- The adapter makes one non-streaming request with the shared system prompt,
  `videoId`, caption language, and `[startSec] text` transcript lines. It does
  not retry automatically.
- Provider I/O is bounded by a 45-second timeout, an 8,192-token completion cap,
  and a 256,000-byte response cap.
- The worker validates the assistant JSON, normalizes block boundaries, and
  returns the existing `ready`, `no_promo`, or stable terminal error shapes.
- Successful ready and no-promo results are fresh for 30 days. The algorithm
  version is `server-v2`, preventing older fixture/cache records from replacing
  Gemini results.
- Analysis artifacts retain provider, model, prompt version, completion time,
  token usage, and reported cost. Existing artifact records remain readable.
- Diagnostics never log credentials, transcript or subtitle text, reasoning,
  signed URLs, provider response bodies, raw provider errors, or cookies.
- The extension does not expose the server model or API key and does not add a
  new network dependency to content scripts.

## Implementation map

| Area | Responsibility |
| --- | --- |
| `common/src/promo-detection-prompt.ts` | Shared prompt text and version used by server, BYOK, and benchmarks |
| `backend/src/analysis/openrouter-gemini-analysis-adapter.ts` | Bounded OpenRouter request and response/usage validation |
| `backend/src/analysis/promo-analysis-worker.ts` | Async adapter selection, block normalization, stable errors, and 30-day freshness |
| `backend/src/server-config.ts` | Root environment loading and fail-fast key validation |
| `common/src/server-analysis-contract.ts` | `server-v2` cache/algorithm boundary without a wire-shape change |

## Verification

- Adapter tests assert the exact model, high reasoning with excluded reasoning
  text, timed transcript input, timeout/abort behavior, non-2xx handling,
  malformed or oversized responses, missing assistant content, and safe
  usage/cost parsing.
- Worker and job tests cover async processing, one provider call for joined
  requests, ready/no-promo/error outcomes, normalization, 30-day freshness,
  test-only fixture selection, and backward-compatible artifacts.
- Extension tests verify that three returned promo blocks pass unchanged from
  background to content and popup, each future block skips once, and navigation,
  backward seek, and cache behavior remain intact.
- CI runs format, lint, TypeScript, unit/coverage, build, and Playwright without
  real OpenRouter traffic.
- A separate paid backend smoke uses the established test video and a fresh
  artifact store, waits for `ready`, and confirms three returned intervals
  without downloading video or audio. Deterministic Playwright coverage verifies
  the matching popup rendering and seek behavior.
