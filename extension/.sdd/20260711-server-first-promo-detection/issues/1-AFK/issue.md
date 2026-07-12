# Issue: Local backend handshake and API contract

**Issue ID**: 1-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: None - can start immediately

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Create the first local backend tracer bullet and the extension-facing contract for server-mode analysis. This slice should prove that the extension can target a configured local backend endpoint, send validated current-video metadata, receive a typed non-blocking response, and surface the server-mode status in the existing detection status path without starting local provider analysis.

The backend response can be minimal in this slice: a health/handshake response and a deterministic `processing` response for an analysis request are enough. The important behavior is a stable request/response contract and integration between extension status, backend API, and tests.

## How to Verify

- **Manual**: Start the local backend, load the extension development build, open a supported watch page or fixture, and confirm the popup/status path can show that server analysis is pending for the current video.
- **Automated**: Tests validate the shared request/response schema, reject malformed video IDs, and assert that server mode sends the analysis request to the configured local backend endpoint.

## Acceptance Criteria

1. **Given** server mode is active and a current video ID exists, **When** the extension requests analysis, **Then** it sends a validated analysis request to the configured local backend endpoint.
2. **Given** the local backend receives a valid analysis request, **When** no cached result is available in this slice, **Then** it returns a typed `processing` response without performing extraction, transcription, or LLM work.
3. **Given** the backend response is `processing`, **When** the extension updates detection state, **Then** the popup/status path can report that server analysis is pending.
4. **Given** server mode is active, **When** the server request path runs, **Then** the existing direct provider analysis path is not invoked for that request.

## User Stories Addressed

- User Story 5: Keep the Local Backend API Bounded
- User Story 7: Show Clear Analysis Status in the Extension
