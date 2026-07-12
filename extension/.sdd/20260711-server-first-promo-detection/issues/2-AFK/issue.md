# Issue: Server cache hit applies promo blocks

**Issue ID**: 2-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 1-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Extend the local backend tracer bullet so a known video can return a ready server cache result, and wire the extension to apply that result through the existing promo-block delivery and skip path. This slice should prove the main fast path: video ID in, cached promo blocks out, content script receives blocks, playback skips when crossing a block start.

The backend cache can be in-memory and fixture-backed for this slice. Persistence, extraction, and model analysis are handled by later issues.

## How to Verify

- **Manual**: Start the local backend with a seeded promo-block fixture, open the matching fixture/watch video, and verify that TopSkip receives blocks and skips at the seeded block start.
- **Automated**: Unit/integration tests mock or run the local backend, assert a `ready` response maps to `PROMO_BLOCKS_DETECTED`, and verify the content skip logic uses the server-provided blocks.

## Acceptance Criteria

1. **Given** the local backend has a ready cache entry for the current video and algorithm version, **When** the extension requests analysis, **Then** the backend returns normalized promo blocks without starting a new job.
2. **Given** the extension receives ready promo blocks from the backend, **When** the current video ID matches, **Then** it forwards those blocks to the content script through the existing promo-block delivery path.
3. **Given** server-provided blocks are active, **When** playback naturally crosses a block start, **Then** TopSkip skips to that block's end exactly once.
4. **Given** the backend returns blocks for a different video ID, **When** the extension processes the response, **Then** it does not apply those blocks to the current video.

## User Stories Addressed

- User Story 1: Get Cached Promo Blocks Quickly
- User Story 7: Show Clear Analysis Status in the Extension
