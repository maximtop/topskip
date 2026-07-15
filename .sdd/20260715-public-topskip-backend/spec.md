# Feature Specification: Public TopSkip Backend

**Created**: 2026-07-15
**Status**: In Progress
**Model**: GPT-5 Codex high reasoning
**Input**: User-approved public backend plan for `topskip.maximtop.dev`.

## Assumptions

- The first public release is anonymous and uses one backend replica.
- `topskip.maximtop.dev` is routed through Cloudflare Tunnel to a loopback-only
  Docker port on the existing VPS.
- A short interruption during deployment and loss of in-memory jobs are
  acceptable; durable results, quotas, and budgets are not lost.
- Successful transcripts and model artifacts are retained for 30 days, with a
  maximum of 10,000 artifacts.
- Public GitHub support initially targets `maximtop/topskip`, but the server
  publishes the validated support URL so it can change without an extension
  release.

## User Scenarios & Testing

### User Story 1 - Analyze through the public server (Priority: P1)

A viewer in Server mode receives cached or newly analyzed promo blocks without
installing a local backend or configuring an LLM key.

**Acceptance Scenarios**:

1. **Given** a fresh server result, **When** a supported watch page loads,
   **Then** background-owned HTTP returns blocks that content applies and popup
   displays.
2. **Given** a cold miss, **When** analysis begins, **Then** duplicate requests
   join one job and clients poll until a terminal result.
3. **Given** Private BYOK mode, **When** a video loads, **Then** no TopSkip
   installation, config, analysis, or polling request is made.

### User Story 2 - Survive independent server and extension updates (Priority: P1)

The server owns the active analysis version while `/v1` remains wire-compatible
across additive releases.

**Acceptance Scenarios**:

1. **Given** a legacy request algorithm value, **When** the server handles it,
   **Then** it ignores the hint and returns its exact active algorithm version.
2. **Given** a new server algorithm, **When** background refreshes config,
   **Then** incompatible local cache entries are evicted without requiring an
   extension release.
3. **Given** an unknown client capability, **When** the server validates the
   request, **Then** it ignores that capability instead of rejecting the client.

### User Story 3 - Understand safe failures (Priority: P1)

A viewer sees whether TopSkip cannot analyze a particular video, is temporarily
busy, requires an update, or encountered an internal service failure.

**Acceptance Scenarios**:

1. **Given** a reportable failure, **When** popup renders it, **Then** localized
   copy says the problem is on the TopSkip side and offers a prefilled GitHub
   report containing only safe diagnostic metadata.
2. **Given** a video limitation, **When** popup renders it, **Then** it confirms
   the extension settings are valid and offers only a secondary report action.
3. **Given** a transient quota or capacity failure, **When** popup renders it,
   **Then** it presents retry guidance without exposing provider details.

### User Story 4 - Operate within bounded public capacity (Priority: P1)

The operator can expose the service without allowing malformed or abusive
traffic to cause unbounded YouTube or Gemini work.

**Acceptance Scenarios**:

1. **Given** malformed input, unavailable captions, a video over five hours, or
   any transcript limit violation, **When** processing terminates, **Then** no
   Gemini request is made.
2. **Given** installation, IP, queue, or model-budget exhaustion, **When** a cold
   request arrives, **Then** expensive work does not start and a stable retryable
   code is returned.
3. **Given** a cache hit or joined job, **When** it is served, **Then** it does not
   consume cold-job or model budget.

### User Story 5 - Deploy without exposing the origin (Priority: P2)

The operator deploys an immutable container through an approved GitHub Actions
run while the TopSkip origin remains loopback-only.

**Acceptance Scenarios**:

1. **Given** the public hostname, **When** DNS and ports are inspected, **Then**
   TopSkip DNS points to a tunnel and port 18787 is not reachable externally.
2. **Given** a failed release health check, **When** deployment completes,
   **Then** the previous image digest is restored automatically.
3. **Given** yt-dlp updates, **When** the service starts, **Then** it uses the
   verified pinned binary and never auto-updates.

### Edge Cases

- An expired installation token is re-registered and one safe request is retried.
- A deployment may erase an in-memory job; the client resubmits once after
  `job_not_found`.
- A config fetch may fail while an unexpired local result exists; playback may
  continue with that result until the server is reachable.
- Five-hour videos remain subject to the independent segment, transcript, and
  subtitle-response limits.

## Requirements

### Functional Requirements

- **FR-001**: Public analysis and polling MUST require a 90-day anonymous
  installation token stored only by extension background and hashed at rest.
- **FR-002**: `/v1/config` and all analysis responses MUST expose the backend's
  active algorithm version; clients MUST NOT equality-gate it against bundled
  code, and MUST ignore additive response fields within the stable v1 envelope.
- **FR-003**: `extensionVersion` MUST be a Chrome-compatible
  `MAJOR.MINOR.PATCH` value no longer than 32 characters and MUST be
  informational unless the server explicitly returns `client_upgrade_required`.
- **FR-004**: Client capabilities MUST be bounded and unique; clients MUST send
  known values while servers MUST ignore unknown values for forward
  compatibility.
- **FR-005**: Server errors MUST expose stable codes, optional `supportId`, and
  optional retry timing without raw provider or extraction details.
- **FR-006**: The backend MUST reject authoritative durations above 18,000
  seconds, more than 10,000 caption segments, more than 500,000 transcript
  characters, and subtitle responses above 1 MiB before Gemini.
- **FR-007**: Persistent installations, quotas, budgets, artifacts, and failures
  MUST use SQLite; in-flight jobs MAY remain in memory for the single replica.
- **FR-008**: Daily model spend MUST stop at USD 5 and monthly spend at USD 100,
  using a USD 0.35 reservation for each new model call.
- **FR-009**: The production backend MUST run as a constrained non-root
  container published only on VPS loopback and reached through Cloudflare
  Tunnel.
- **FR-010**: Production deployment MUST use a manually approved GitHub Actions
  workflow, immutable image digest, bounded deploy user, health check, and
  automatic rollback.
- **FR-011**: Private BYOK mode MUST perform zero TopSkip backend requests.
- **FR-012**: Logs and public diagnostics MUST exclude transcripts, subtitles,
  signed URLs, stderr, bodies, credentials, tokens, cookies, and raw IPs.

### Key Entities

- **Installation**: Token hash, creation/expiry time, and quota identity.
- **Server Config**: API version, active algorithm, optional minimum extension
  version, supported capabilities, and support issue URL.
- **Usage Bucket**: Installation/IP request counters and atomic model-budget
  reservations.
- **Failure Event**: Stable code, support ID, safe versions, and timestamps.
- **Analysis Artifact**: Versioned transcript, model run, normalized blocks, and
  30-day freshness/retention metadata.

## Success Criteria

- **SC-001**: Contract, quota, budget, failure UX, and limit tests pass without
  live YouTube or Gemini calls.
- **SC-002**: Boundary tests prove 18,000 seconds is accepted and any larger
  authoritative duration is rejected before Gemini.
- **SC-003**: DNS does not publish the VPS IP for the TopSkip hostname and the
  backend port is unreachable externally.
- **SC-004**: A paid VPS smoke reaches a terminal result through the public
  hostname without downloading media.
- **SC-005**: A deliberately unhealthy image automatically rolls back to the
  prior healthy digest.
