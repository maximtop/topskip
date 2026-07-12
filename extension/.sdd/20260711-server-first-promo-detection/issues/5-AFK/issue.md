# Issue: Job dedupe, validation, and local rate limits

**Issue ID**: 5-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 4-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Harden the local backend job-start path enough for development use. The backend should validate incoming analysis requests, reject invalid video IDs before expensive work, deduplicate active jobs by video ID and algorithm version, and apply a basic local rate-limit hook that distinguishes cheap cache lookups from expensive cold job starts.

This slice keeps protection local and testable. Cloudflare/WAF, origin-IP hiding, and public deployment controls remain future hardening items per the PRD.

## How to Verify

- **Manual**: Send repeated local requests for the same uncached video and confirm only one active job is created; send invalid video IDs and confirm no job starts.
- **Automated**: Backend tests cover request validation, duplicate job joins, cache-hit versus cold-start cost classification, and rate-limited cold requests not enqueueing work.

## Acceptance Criteria

1. **Given** a request has an invalid or missing video ID, **When** the backend receives it, **Then** it rejects the request without starting extraction, transcription, or LLM work.
2. **Given** an active job already exists for the same video ID and algorithm version, **When** another request arrives, **Then** the backend joins or returns the existing job rather than creating a duplicate.
3. **Given** repeated cold-analysis requests exceed the local rate-limit policy, **When** another cold request arrives, **Then** the backend returns a retryable rate-limit response and does not enqueue expensive work.
4. **Given** a request is a cheap cache lookup, **When** local limits are evaluated, **Then** it is accounted separately from an expensive cold job start.

## User Stories Addressed

- User Story 2: Analyze Uncached Videos on the Server
- User Story 5: Keep the Local Backend API Bounded
