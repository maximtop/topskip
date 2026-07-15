# PRD Validation Report: Server-First Promo Detection

- **Validated**: 2026-07-11
- **Model**: GPT-5 Codex
- **PRD**: `.sdd/.current/prd.md`
- **Cross-cutting attempt**: 2

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Issues | 11 | 0 | 0 | 11 |
| User Stories | 8 | 0 | 0 | 8 |
| Success Criteria | 11 | 0 | 0 | 11 |
| Guidelines | 8 | 0 | 0 | 8 |
| Cross-Cutting Audit | 5 | 0 | 0 | 5 |

**Overall Status**: COMPLETE

## Issue Status

| Issue ID | Title | Type | Status |
| --- | --- | --- | --- |
| 1-AFK | Local backend tracer bullet and server-mode contract | AFK | Validated |
| 2-AFK | Server cache hit applies promo blocks | AFK | Validated |
| 3-AFK | Extension local result cache | AFK | Validated |
| 4-AFK | Cold analysis job lifecycle and polling | AFK | Validated |
| 5-AFK | Job dedupe, validation, and local rate limits | AFK | Validated |
| 6-AFK | Subtitle extraction pipeline with first local strategy | AFK | Validated |
| 7-AFK | LLM analysis worker and block normalization | AFK | Validated |
| 8-AFK | Artifact store for success and failure history | AFK | Validated |
| 9-AFK | Failure and no-promo states end-to-end | AFK | Validated |
| 10-HITL | Private BYOK mode and server bypass | HITL | Validated |
| 11-AFK | Future hardening and correction hooks | AFK | Validated |

## User Story Coverage

| Story | Title | Priority | Covered By | Status |
| --- | --- | --- | --- | --- |
| 1 | Get Cached Promo Blocks Quickly | P1 | 1-AFK, 2-AFK, 3-AFK | MET |
| 2 | Analyze Uncached Videos on the Server | P1 | 1-AFK, 4-AFK, 5-AFK, 7-AFK, 9-AFK | MET |
| 3 | Extract Subtitles Through Server Strategies | P1 | 6-AFK, 9-AFK | MET |
| 4 | Store Analysis Artifacts for Debugging and Improvement | P1 | 6-AFK, 7-AFK, 8-AFK | MET |
| 5 | Keep the Local Backend API Bounded | P2 | 1-AFK, 5-AFK, 11-AFK | MET |
| 6 | Use Private BYOK Mode Without TopSkip Server Calls | P2 | 10-HITL | MET |
| 7 | Show Clear Analysis Status in the Extension | P2 | 2-AFK, 4-AFK, 9-AFK, 10-HITL | MET |
| 8 | Reserve a Path for User Corrections | P3 | 8-AFK, 11-AFK | MET |

## Success Criteria Status

| ID | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| SC-001 | Fresh local cache hits avoid a network request. | MET | `ServerResultCache` is checked before the server client, with unit and local-cache E2E coverage. |
| SC-002 | Server cache hits arrive in time for typical early promo starts. | MET | The ready-cache E2E route applies blocks before the fixture crosses the block start; no production latency SLO exists for the local-only MVP. |
| SC-003 | Cold misses return processing without long-running HTTP blocking. | MET | `BackendAnalysisApi` creates or joins a job and returns `processing`; API, worker, and E2E tests cover polling. |
| SC-004 | Duplicate cold requests join one active job. | MET | `BackendAnalysisJobs.findExisting` keys active jobs by video ID and algorithm version; backend tests cover joins. |
| SC-005 | Server requests do not include raw caption text by default. | MET | The shared Valibot request contract accepts metadata only; client and contract tests reject unsupported payloads. |
| SC-006 | Private BYOK makes no TopSkip backend analysis/cache/status requests. | MET | E2E verifies no backend calls until a new Server-mode watch lifecycle begins. |
| SC-007 | Rate-limited cold requests do not enqueue expensive work. | MET | API protection classifies cold starts separately and tests assert no job is created for a 429 response. |
| SC-008 | Successful analyses persist the required debug artifacts. | MET | `AnalysisArtifactStore` atomically persists validated, redacted records; restart and 30-day retention tests verify durable lifecycle behavior. |
| SC-009 | Failed analyses retain stage reasons and surface a non-skipping state. | MET | Terminal unavailable, error, no-promo, and rate-limit paths are mapped through the extension and covered by unit and E2E tests. |
| SC-010 | Cache invalidates on algorithm/cache-version changes. | MET | Cache keys require an exact algorithm version, with stale and version-mismatch coverage. |
| SC-011 | MVP is local and public hardening is future work. | MET | The backend remains loopback-only and `SERVER_FIRST_FUTURE_WORK.md` documents edge, quota, token, and correction work. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Strict TypeScript and boundary validation | COMPLIANT | Backend and extension contracts are Valibot-validated and typed. |
| Shared modules contain only pure cross-bundle contracts/helpers | COMPLIANT | Backend I/O stays under `src/backend`; shared code contains serializable contracts only. |
| Preferences are storage-owned by the background | COMPLIANT | Mode preferences use runtime messages and the existing background storage path. |
| Explicit Server/BYOK mode selection | COMPLIANT | One source is selected per watch lifecycle with no silent server fallback. |
| User-visible text uses i18n | COMPLIANT | New text is present across locale files and read through translation helpers. |
| Pure logic and behavior coverage | COMPLIANT | Unit, coverage, contract, and deterministic extension E2E suites pass. |
| Local-only MVP deployment boundary | COMPLIANT | The backend binds to loopback and docs prohibit public hosts before hardening. |
| Formatting, lint, build, tests, coverage, E2E | COMPLIANT | All project quality gates passed on 2026-07-11. |

## Cross-Cutting Findings

### Critical Findings

None.

### High Findings

None. The preceding default-extraction finding is resolved by the registered direct and automatic timedtext strategies, ordered after the fixture source and covered without live network access. The preceding durable-history finding is resolved by atomic local-file persistence, validated reload, expiry pruning, and restart/expiry tests.

### Medium Findings

None.

### Low Findings

None.

## Overall Assessment

The server-first flow satisfies every PRD user story and success criterion for the loopback MVP. The prior P1 gaps are closed: subtitle extraction has ordered non-fixture sources with a safe opt-in network boundary, and analysis artifacts/results persist with retention and redaction. The implementation is ready to finalize as a local MVP; public deployment remains explicitly deferred.

## Recommendations

- Treat Cloudflare/WAF deployment, durable public quotas, anonymous token issuance, and correction submission as separately reviewed future work.
