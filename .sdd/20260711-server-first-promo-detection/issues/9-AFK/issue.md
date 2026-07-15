# Issue: Failure and no-promo states end-to-end

**Issue ID**: 9-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 4-AFK, 6-AFK, 7-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Complete the end-to-end non-happy paths for server mode. The backend and extension should consistently represent `no_promo`, `unavailable`, `error`, network failure, and rate-limited states. The extension should show clear status and must not skip playback when no valid block list exists.

This slice is separate from the happy path so failure behavior has explicit regression coverage.

## How to Verify

- **Manual**: Run local backend fixtures for no-promo, captions unavailable, analysis error, and rate-limit responses; confirm the popup/status copy changes and playback is not altered.
- **Automated**: Contract and extension tests cover each terminal/error response shape, invalid backend responses, network failure, and the invariant that no valid blocks means no skip.

## Acceptance Criteria

1. **Given** the backend returns `no_promo`, **When** the extension receives the result, **Then** it shows a no-promo state and does not send promo blocks to the content script.
2. **Given** subtitle extraction is unavailable, **When** the job reaches a terminal state, **Then** the backend returns an unavailable state with a stage-specific reason and the extension does not skip.
3. **Given** backend analysis fails or returns invalid output, **When** the extension receives the terminal state, **Then** it shows an error/unavailable state and playback is not altered.
4. **Given** the backend request fails due to network or rate-limit conditions, **When** server mode handles the failure, **Then** playback continues without automatic local fallback and without server-detected skips.

## User Stories Addressed

- User Story 2: Analyze Uncached Videos on the Server
- User Story 3: Extract Subtitles Through Server Strategies
- User Story 7: Show Clear Analysis Status in the Extension
