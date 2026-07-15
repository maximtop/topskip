# Issue: Subtitle extraction pipeline with first local strategy

**Issue ID**: 6-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 4-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Add the backend subtitle extraction pipeline with one deterministic local strategy suitable for development and tests. A cold job should run through extraction, produce a timed transcript artifact for known fixture videos, and record structured extraction attempts and failure reasons. This slice establishes the pipeline shape before adding real YouTube libraries or audio transcription.

The first strategy may be fixture-backed or otherwise deterministic, but it must use the same success/failure contract intended for later real strategies.

## How to Verify

- **Manual**: Start a cold job for a known fixture video and confirm the backend records a selected transcript artifact with strategy metadata; start a job for an unknown fixture and confirm a structured unavailable result.
- **Automated**: Backend tests cover successful transcript artifact creation, multiple attempt records, unavailable captions, timeout/error mapping, and no empty transcript being passed onward.

## Acceptance Criteria

1. **Given** a video is supported by the first local extraction strategy, **When** a cold analysis job reaches extraction, **Then** the backend stores an ordered timed transcript artifact and marks that strategy as successful.
2. **Given** the first extraction strategy cannot produce a usable transcript, **When** the job runs, **Then** the backend records a stage-specific failure reason.
3. **Given** all configured extraction strategies fail in this slice, **When** the job completes, **Then** the backend stores an unavailable result and the extension does not skip for that reason.
4. **Given** extraction diagnostics are recorded, **When** maintainers inspect the job, **Then** no cookies, account tokens, extension secrets, or unredacted credential material are present.

## User Stories Addressed

- User Story 3: Extract Subtitles Through Server Strategies
- User Story 4: Store Analysis Artifacts for Debugging and Improvement
