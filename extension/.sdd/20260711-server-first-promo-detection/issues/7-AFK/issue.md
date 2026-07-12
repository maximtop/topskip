# Issue: LLM analysis worker and block normalization

**Issue ID**: 7-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 6-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Add the backend analysis worker that consumes a selected transcript artifact, runs a deterministic local model/LLM stub or configured provider adapter in development mode, parses the raw response, normalizes promo blocks, and publishes the ready/no-promo result through the existing job lifecycle. This slice proves the backend can turn a transcript into extension-usable promo blocks.

The analysis worker must store raw model output and reject invalid or degenerate block responses. Real model choice and production cost optimization can evolve later.

## How to Verify

- **Manual**: Run a cold job for a fixture transcript that produces known promo blocks and confirm the extension receives and applies the normalized blocks.
- **Automated**: Tests cover raw response parsing, no-promo output, invalid JSON, out-of-bounds timestamps, full-video degenerate block rejection, and normalized block delivery to the extension.

## Acceptance Criteria

1. **Given** extraction produces a valid transcript artifact, **When** backend analysis runs, **Then** it records the raw model response and parsed result for that transcript.
2. **Given** the model response contains valid promo blocks, **When** normalization completes, **Then** the backend stores sorted, non-overlapping blocks inside the known duration when available.
3. **Given** the model response is no-promo, invalid JSON, out of bounds, or degenerate, **When** analysis completes, **Then** the backend stores the correct terminal state and does not deliver unsafe blocks.
4. **Given** normalized blocks are ready, **When** the extension polls the job status, **Then** it receives ready blocks through the server-result path.

## User Stories Addressed

- User Story 2: Analyze Uncached Videos on the Server
- User Story 4: Store Analysis Artifacts for Debugging and Improvement
