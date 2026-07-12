# Issue: Extension local result cache

**Issue ID**: 3-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 2-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Add an extension-owned local cache for ready server results. The cache should store server-confirmed promo blocks with video ID, algorithm/cache version, freshness metadata, and source result ID. Before calling the backend, server mode should consult this cache; fresh entries should be applied immediately, while stale or corrupt entries should miss and allow the normal server request path.

This slice should remain scoped to extension-side caching and should not require backend persistence.

## How to Verify

- **Manual**: Load a video once with the local backend returning ready blocks, reload or revisit the same video, stop the backend, and confirm the extension can still use the fresh local cache entry.
- **Automated**: Tests cover fresh hit, stale miss, version mismatch, corrupt stored data repair/miss, storage read/repair failure miss, non-fatal cache write failure, ready-response algorithm mismatch rejection, and the no-network path when a fresh entry exists.

## Acceptance Criteria

1. **Given** the extension has a fresh local cache entry for the current video and algorithm version, **When** server mode starts analysis, **Then** it applies cached promo blocks without making a backend request.
2. **Given** the extension has a stale local cache entry, **When** server mode starts analysis, **Then** it ignores the stale entry and requests a fresh result from the backend.
3. **Given** the server returns ready blocks with freshness metadata, **When** the extension accepts the result, **Then** it stores a validated local cache entry for future use.
4. **Given** a local cache entry is corrupt or for another algorithm/cache version, **When** the extension reads it, **Then** it does not apply the entry.

## User Stories Addressed

- User Story 1: Get Cached Promo Blocks Quickly
