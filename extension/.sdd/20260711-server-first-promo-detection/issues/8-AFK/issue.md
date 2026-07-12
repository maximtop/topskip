# Issue: Artifact store for success and failure history

**Issue ID**: 8-AFK
**Type**: AFK
**Status**: Validated
**Blocked by**: 6-AFK, 7-AFK

## Parent PRD

`.sdd/.current/prd.md`

## What to Build

Add the backend artifact store needed for debugging and future quality iteration. Successful and failed analyses should persist enough structured history to inspect video metadata, extraction attempts, selected transcript, raw analysis output, normalized blocks, prompt/model versions, timing/cost metadata, and terminal failure reasons.

The store can be local-file or lightweight database backed for the MVP, but it must expose a stable repository/service interface so later storage choices do not change the extension contract.

## How to Verify

- **Manual**: Run one successful and one failed local analysis, then inspect the stored records and confirm all required artifacts are present without secrets.
- **Automated**: Tests assert success history, failure history, versioned reanalysis records, redaction expectations, and cache lookup using stored ready results.

## Acceptance Criteria

1. **Given** a server analysis succeeds, **When** the job completes, **Then** the artifact store records video metadata, transcript source, transcript text, prompt/model versions, raw model response, parsed blocks, normalized blocks, and timing/cost metadata.
2. **Given** a server analysis fails, **When** the job completes, **Then** the artifact store records extraction attempts, failure reasons, provider/model errors when applicable, retry metadata, and final user-facing status.
3. **Given** a new algorithm version analyzes the same video, **When** the result is stored, **Then** it is recorded alongside version metadata rather than destructively overwriting the previous version.
4. **Given** stored artifacts include operational metadata, **When** redaction rules are applied, **Then** secrets, cookies, extension-local API keys, and YouTube account tokens are not persisted.

## User Stories Addressed

- User Story 4: Store Analysis Artifacts for Debugging and Improvement
