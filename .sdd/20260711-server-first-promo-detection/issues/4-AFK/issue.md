# Issue: Cold analysis job lifecycle and polling

**Issue ID**: 4-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 1-AFK, 2-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Implement the local backend cold-miss job lifecycle and extension polling/status flow. When no ready cache entry exists, the backend should create a job and return `processing`. The extension should show an analyzing-on-server state and poll or refresh status until the job reaches a terminal `ready`, `no_promo`, `unavailable`, or `error` state.

The job can complete from a deterministic test hook or fixture in this slice. Actual subtitle extraction and LLM analysis are introduced later.

## How to Verify

- **Manual**: Start the backend, request an uncached video, observe the extension show server analysis pending, trigger the backend fixture job completion, and confirm the extension receives the final result.
- **Automated**: Tests assert job creation on cache miss, status polling, terminal state handling, and no backward skip when a result arrives after playback has passed an early block.

## Acceptance Criteria

1. **Given** the backend has no valid result for a video, **When** the extension requests analysis, **Then** the backend creates or returns a job and responds with `processing`.
2. **Given** the extension receives `processing`, **When** the popup/status path renders, **Then** it shows an analyzing-on-server state.
3. **Given** a processing job later becomes ready, **When** the extension refreshes job status, **Then** it receives the normalized blocks and applies them through the server-result path.
4. **Given** ready blocks arrive after playback has already passed an early block start, **When** the content script receives them, **Then** it does not jump backward and only applies future block crossings.

## User Stories Addressed

- User Story 2: Analyze Uncached Videos on the Server
- User Story 7: Show Clear Analysis Status in the Extension
