# Issue: Private BYOK mode UX and enforcement

**Issue ID**: 10-HITL
**Type**: HITL
**Status**: Validated
**Blocked by**: 2-AFK, 4-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Introduce private BYOK mode as an explicit alternate analysis source for users who do not want TopSkip server analysis. This slice needs a human review of the settings UX because it changes the existing model-first provider UI: server mode should be the normal default, while BYOK should be clear, intentional, and impossible to confuse with an automatic fallback.

After UX approval, implement the mode selection, preserve existing provider setup where retained, enforce that BYOK mode makes no TopSkip backend analysis/cache/status requests for watch videos, and surface the active mode in popup/status UI.

## How to Verify

- **Manual**: Switch to private BYOK mode, open a watch video with the local backend running, and confirm no backend analysis/cache/status requests are made; switch back to server mode and confirm backend requests resume on a new video.
- **Automated**: Tests assert mode persistence, no server client calls in BYOK mode, no silent fallback to server when BYOK is unconfigured, and popup/options state identifying the active mode.

## Acceptance Criteria

1. **Given** private BYOK mode is selected, **When** the user opens a supported watch video, **Then** the extension does not call the TopSkip backend for cache lookup, job creation, status polling, or result upload.
2. **Given** private BYOK mode is selected and configured, **When** captions are available through the extension path, **Then** analysis uses the user's configured provider path and never writes the result to the shared server cache.
3. **Given** private BYOK mode is selected but not configured, **When** the user opens a video, **Then** TopSkip shows setup-required state and does not silently fall back to server mode.
4. **Given** the user switches from private BYOK to server mode, **When** a new video loads, **Then** local/server cache lookup resumes only for the new video.

## User Stories Addressed

- User Story 6: Use Private BYOK Mode Without TopSkip Server Calls
- User Story 7: Show Clear Analysis Status in the Extension
