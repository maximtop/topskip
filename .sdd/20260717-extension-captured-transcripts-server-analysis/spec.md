# Feature Specification: Extension-Captured Transcripts for Server Analysis

**Created**: 2026-07-17
**Status**: In Progress
**Model**: GPT-5 Codex high reasoning
**Input**: Replace default backend-owned YouTube caption extraction with
extension-captured timed transcript upload, while preserving server-owned Gemini
analysis, exact caching, polling, public-backend protections, and Private BYOK.

## Assumptions

- The existing player-mediated caption capture is the supported source for
  Server mode. It supplies the current video ID, the player-selected caption
  language, and ordered timed segments without leaving the user's caption state
  changed.
- The extension has not been publicly released, so the existing `/v1/analysis`
  request may change incompatibly. No `/v2` endpoint or compatibility shim is
  required for old development builds.
- Captions must be captured before any exact local-cache lookup. The resulting
  capture delay on a cache hit is accepted in exchange for never reusing a
  result for a different language or transcript revision.
- The backend cannot independently prove that an uploaded transcript belongs to
  a real YouTube video when default caption extraction is disabled. It treats
  every transcript and all client metadata as untrusted input and relies on
  validation, authentication, quotas, queue limits, and model budgets.
- An optional client-reported video duration is useful for early validation but
  is not authoritative, is not part of cache identity, and does not alter the
  transcript sent for analysis.
- An 8 MiB raw request-body limit leaves bounded headroom for 500,000 Unicode
  transcript characters, 10,000 timed-segment envelopes, and JSON escaping.
  Transcript character, segment, timeline, and body-byte limits remain
  independent.
- Validated transcripts for completed cold jobs, bounded raw assistant content,
  normalized promo blocks, safe model metadata, and safe failure events
  continue to be retained for 30 days. Reasoning, provider envelopes, raw
  provider errors, and provider diagnostics are not retained. The existing
  10,000-artifact, age, and free-disk pruning protections continue to apply.
- Legacy yt-dlp extraction remains in the repository temporarily behind the
  startup-only `TOPSKIP_CAPTION_SOURCE=legacy_yt_dlp` operator mode. The only
  other valid value, and the default and public VPS value, is
  `extension_upload`. Requests cannot select the mode. Legacy mode is never an
  automatic per-video fallback and is not a public compatibility promise.
- Server analysis continues to use the existing configured Gemini/OpenRouter
  model, prompt, reasoning policy, timeout, single-attempt behavior, response
  validation, and budget accounting.
- The public hostname, Cloudflare Tunnel, one-replica VPS topology, installation
  tokens, typed errors, quotas, queue, SQLite state, and deployment rollback
  mechanism remain in place.
- Private BYOK remains a separate privacy-oriented mode. It may use the same
  browser-captured captions but does not register with or contact the TopSkip
  backend.
- This specification supersedes the metadata-only, video-only cache, and
  default server-owned caption extraction decisions in earlier server-first,
  yt-dlp, Gemini-server, and public-backend specifications. It preserves the
  player-state, privacy, and stale-navigation guarantees of the reliable
  browser caption-capture specification.
- The active algorithm changes from `server-v4` to `server-v5`, and uploaded
  artifacts use a distinct extension-caption source. Old video-only artifacts
  remain readable for pruning and rollback but can never satisfy a `server-v5`
  lookup.
- Rollout ends after automated validation, one paid real-video smoke, VPS
  deployment, and an end-to-end extension check. A new 48-hour beta-monitoring
  period is not required.
- Backend deployment precedes any distribution or manual reload of the new
  extension build. If backend rollout is rolled back, that new extension build
  is not distributed; transparent compatibility with the previous request
  shape is intentionally out of scope.

## User Scenarios & Testing

### User Story 1 - Analyze Captured Captions in Server Mode (Priority: P1)

A viewer opens a captioned YouTube video in Server mode. TopSkip obtains the
timed captions through the active player, sends them through the extension
background to the public backend, and eventually returns promo blocks without
requiring the viewer to configure a model key.

**Why this priority**: This is the new primary product path. Without it, Server
mode cannot analyze a video after default backend caption extraction is
disabled.

**Independent Test**: Open a supported captioned watch video with an empty
cache, observe one caption submission and one server analysis job, and verify
that valid promo blocks reach the popup and playback logic.

**Acceptance Scenarios**:

1. **Given** Server mode is enabled on a supported captioned watch page,
   **When** the player supplies a valid timed caption track, **Then** TopSkip
   submits that transcript through the background and starts or joins analysis.
2. **Given** the submitted transcript is a cold cache miss, **When** validation
   and capacity checks succeed, **Then** the backend performs one model analysis
   and exposes its progress through the existing asynchronous job flow.
3. **Given** analysis returns safe promo blocks, **When** polling reaches a
   terminal ready result, **Then** the background delivers the unchanged blocks
   to the current content session and popup.
4. **Given** blocks arrive after playback has already entered or passed an
   earlier block, **When** playback continues, **Then** TopSkip skips only future
   block crossings and never jumps backward.

---

### User Story 2 - Reuse Only the Exact Transcript Result (Priority: P1)

A viewer revisits a video or another viewer submits the same timed transcript.
TopSkip reuses a result only when the video, caption language, transcript
content and timings, and active analysis algorithm all match.

**Why this priority**: Shared caching provides the server's main latency and
cost benefit, but a broader identity can silently apply promo timings inferred
from another language or a changed caption track.

**Independent Test**: Submit a matrix containing identical transcripts,
different JSON serialization, changed text, changed timing, changed language,
and a changed algorithm version; verify exactly which requests share local
cache, backend cache, and in-flight work.

**Acceptance Scenarios**:

1. **Given** a fresh local result for the exact canonical identity, **When** the
   same captions are captured again, **Then** the extension returns the cached
   blocks without an analysis HTTP request.
2. **Given** a stored backend artifact for the exact canonical identity,
   **When** another installation submits the same logical timed transcript,
   **Then** the backend returns the artifact without spending cold-job or model
   quota.
3. **Given** an in-flight job for the exact canonical identity, **When** another
   installation submits the same logical timed transcript, **Then** it joins
   that job rather than starting another model request.
4. **Given** the same video ID with a different normalized language, caption
   text, caption timing, or active algorithm version, **When** analysis is
   requested, **Then** TopSkip treats it as a separate identity.
5. **Given** a client attempts to add a false or stale transcript hash to the
   strict request, **When** the backend validates it, **Then** the unknown field
   is rejected and can never affect cache lookup, job joining, or artifact
   storage.

---

### User Story 3 - See Stable Acquisition and Analysis Status (Priority: P1)

A viewer can tell whether TopSkip is still obtaining captions or whether the
server is analyzing them. Status does not alternate between contradictory
states while asynchronous messages arrive.

**Why this priority**: Caption capture and server analysis now happen in
sequence and have different failure causes. Clear monotonic states prevent the
popup flicker and misleading server errors seen in earlier flows.

**Independent Test**: Delay caption delivery and then delay server completion
while repeatedly opening the popup; verify the visible state sequence and its
terminal outcome.

**Acceptance Scenarios**:

1. **Given** Server mode is waiting for the current player's captions, **When**
   the popup opens, **Then** it shows a stable localized “Getting captions”
   state.
2. **Given** valid captions have left the capture stage and no exact local
   result exists, **When** the backend request or polling is active, **Then** the
   popup shows a stable localized “Analyzing promo” state.
3. **Given** the exact local cache contains a ready result, **When** caption
   identity is computed, **Then** the popup may move directly from caption
   acquisition to ready without falsely claiming that remote analysis ran.
4. **Given** caption capture reports no usable captions, **When** the flow
   terminates, **Then** the popup reports `captions_unavailable` as a limitation
   of that video rather than a settings or TopSkip server failure.
5. **Given** caption capture fails because the player integration, timeout, or
   parser malfunctioned, **When** the flow terminates, **Then** the popup reports
   a safe TopSkip capture failure with a GitHub report action rather than
   claiming that the video has no captions.
6. **Given** YouTube navigates to another video or the user disables TopSkip or
   changes analysis mode, **When** an older capture, poll, or result completes,
   **Then** it cannot replace the status or promo blocks for the new session.

---

### User Story 4 - Reject Unsafe or Excessive Transcript Work (Priority: P1)

The service operator can accept anonymous transcript submissions without
allowing malformed, oversized, forged, or instruction-like caption content to
bypass validation, quotas, cache isolation, or model safeguards.

**Why this priority**: Moving captions into the public request enlarges the
untrusted input boundary and makes bounded validation a prerequisite for safe
model spending and data retention.

**Independent Test**: Submit valid boundary inputs and malformed, oversized,
out-of-order, forged-hash, and prompt-injection-like inputs; verify deterministic
classification and zero model calls for every rejected request.

**Acceptance Scenarios**:

1. **Given** an unauthenticated, malformed, or over-limit request, **When** it
   reaches the backend, **Then** it is rejected before cache joining, cold-job
   accounting, artifact creation, or model invocation as appropriate to the
   failed boundary.
2. **Given** captions contain text that resembles instructions, **When** the
   transcript is analyzed, **Then** the text remains untrusted transcript data
   and receives no authority over system instructions or output validation.
3. **Given** a valid cold request exceeds an installation, IP, queue, capacity,
   or model-budget limit, **When** scheduling is evaluated, **Then** expensive
   model work does not begin and the client receives an existing safe typed
   outcome.
4. **Given** transcripts and bounded raw assistant content are retained,
   **When** logs, public errors, popup state, or issue URLs are produced,
   **Then** none of that retained content is exposed.

---

### User Story 5 - Keep Private BYOK Isolated (Priority: P2)

A viewer who selects Private BYOK continues to analyze browser-captured
captions through the configured private provider path without disclosing the
video or transcript to TopSkip infrastructure.

**Why this priority**: The server request now contains substantially more
viewer data than video metadata, so the privacy distinction between modes must
remain explicit and reliable.

**Independent Test**: Run a full captioned-video analysis in Private BYOK and
verify that no installation registration, config, analysis, or polling request
targets the TopSkip backend.

**Acceptance Scenarios**:

1. **Given** Private BYOK is selected, **When** captions are captured, **Then**
   they are routed only through the configured private analysis path.
2. **Given** a Server-mode request or poll was in flight, **When** the user
   switches to Private BYOK, **Then** the old server result cannot update the
   active BYOK session.
3. **Given** release documentation describes both modes, **When** a user reviews
   the privacy disclosure, **Then** it clearly states that Server mode uploads
   timed captions and retains validated transcripts and bounded raw assistant
   output for up to 30 days, while Private BYOK does not send them to TopSkip.

---

### User Story 6 - Deploy With a Disabled Legacy Escape Hatch (Priority: P2)

The operator deploys extension-upload mode to the existing public service and
can still exercise the retained yt-dlp implementation explicitly for isolated
testing or emergency migration work.

**Why this priority**: Default runtime independence removes the current YouTube
server-extraction failure, while temporarily retained code lowers migration
risk until the new path is proven.

**Independent Test**: Start the production configuration without a yt-dlp
binary, run a successful transcript-upload analysis, then separately enable the
legacy mode and verify that its existing extraction path is reachable only
under that explicit configuration.

**Acceptance Scenarios**:

1. **Given** the default or VPS production configuration, **When** the backend
   starts and handles analysis, **Then** it neither checks, initializes, nor
   invokes yt-dlp and does not require its executable.
2. **Given** the operator restarts an isolated non-public server with
   `TOPSKIP_CAPTION_SOURCE=legacy_yt_dlp`, **When** its required executable is
   available, **Then** that server wholly selects the retained metadata-only
   `/v1/analysis` behavior without becoming an automatic fallback for
   extension-upload mode.
3. **Given** legacy extraction is enabled without its required executable,
   **When** the backend starts, **Then** startup fails with a safe actionable
   configuration error.
4. **Given** an unknown caption-source value is configured, **When** the backend
   starts, **Then** startup fails closed before serving analysis.
5. **Given** the validated image is deployed to the VPS, **When** loopback and
   public health checks and a paid real-video smoke succeed, **Then** the rollout
   is complete without starting a new 48-hour monitor.

### Edge Cases

- Caption capture succeeds after the user has navigated to another video; the
  stale payload is ignored and must not populate local cache or start analysis.
- Duplicate player caption events for one capture session produce at most one
  submission.
- Captions are empty after text normalization, contain only formatting, have
  non-finite or negative times, are not ordered by start time, or extend beyond
  the five-hour timeline; the request is rejected before model work.
- Equal caption start times and overlapping cues may be valid if the canonical
  ordering is deterministic and every individual timing remains in bounds.
- Exactly 18,000 seconds, 10,000 segments, 500,000 normalized Unicode
  characters, and an 8 MiB body are boundary cases; any value over its respective
  limit is rejected.
- A client-reported duration is absent, temporarily zero, shorter than the final
  caption cue, or different across equivalent submissions. It does not change
  transcript identity or model input; invalid positive values and values over
  five hours are rejected.
- The same logical transcript arrives with different object-property order,
  JSON numeric spelling, Unicode composition, language-code case, or line
  endings. Canonicalization produces the same identity without erasing
  meaningful caption text or timing differences.
- Server configuration is temporarily unavailable. A local result is used only
  when its stored server algorithm and canonical transcript identity are known
  to match; otherwise the client waits or requests analysis rather than guessing.
- An installation token expires during submission or polling. A newly
  registered installation is not silently granted access to the old poll
  handle; the current content session resubmits its retained exact transcript
  once so the new installation can join or receive the durable result safely.
- A deployment removes an in-memory job while its artifact is not yet durable.
  The current content session follows the existing one-time `job_not_found`
  recovery and resubmits its in-memory exact transcript. If the session no
  longer has it, TopSkip starts a new bounded caption-capture session rather
  than sending a metadata-only request.
- The backend returns a terminal result for the right video but a different
  language, transcript hash, or algorithm. The background rejects it as stale
  or invalid and does not cache or apply its blocks.
- A server cache hit still requires the browser to capture captions first; the
  popup remains in caption acquisition until exact identity is known.
- Default extraction cannot determine that a YouTube video is deleted,
  private, age-restricted, or otherwise unavailable. It reports only facts it
  can establish from the uploaded request and does not manufacture a
  `video_unavailable` result.
- The model provider times out or returns malformed, oversized, unsafe, or
  no-promo output. Existing terminal error/no-promo behavior applies, no
  automatic retry runs, and retained raw data is not exposed publicly.
- The public backend is rolled back after the new extension was built but
  before it was distributed. The previous extension artifact remains the only
  compatible build until the new backend succeeds again.

## Requirements

### Functional Requirements

- **FR-001**: In Server mode, the system MUST acquire a timed caption payload
  for the current supported watch-page video before looking up a server-analysis
  result or submitting analysis.
- **FR-002**: Page and content contexts MUST limit their role to player
  interaction, caption parsing, and validated runtime messages; only the
  background context may access TopSkip HTTP, authentication state, local
  server-result storage, timeouts, or response mapping.
- **FR-003**: A successful caption payload MUST identify the current video and
  caption language and contain ordered segments with a finite nonnegative
  `startSec`, finite nonnegative `durationSec`, and meaningful text.
- **FR-004**: Confirmed absence of usable captions MUST terminate Server mode
  locally with `captions_unavailable`. A player-integration, timeout, transport,
  or parse malfunction MUST instead produce the safe local
  `caption_extraction_failed` code with a background-owned GitHub report action
  containing only the code, safe versions, and UTC timestamp. Both outcomes
  MUST make zero TopSkip analysis requests and zero model requests and MUST NOT
  trigger yt-dlp, direct video-URL analysis, audio transcription, or another
  fallback.
- **FR-005**: The authenticated `/v1/analysis` request MUST carry the current
  video ID, manifest extension version, normalized caption language, complete
  validated timed segments, and optional client duration. It MUST carry neither
  a client transcript hash nor a client-owned algorithm version.
- **FR-006**: The `/v1/analysis` request body MUST be limited to an inclusive
  8 MiB of raw received bytes for the complete JSON envelope. The backend MUST
  reject unsupported content encodings, stop reading when the limit is
  exceeded, and reject unknown or malformed fields before cache, cold quota,
  job, persistence, or model processing.
- **FR-007**: The backend MUST accept no more than 10,000 segments and 500,000
  Unicode scalar values across text after canonical normalization, and MUST
  reject a positive client duration or transcript timeline above 18,000
  seconds.
- **FR-008**: Backend validation MUST reject non-finite or negative timings,
  non-meaningful transcript text, invalid identifiers, non-deterministic segment
  ordering, and any segment whose end exceeds the allowed transcript timeline.
- **FR-009**: Client duration MUST be treated as an untrusted validation hint;
  it MUST NOT alter canonical transcript identity or the transcript supplied to
  the model.
- **FR-010**: The system MUST define one deterministic canonical segment
  representation shared by browser and server runtimes: compact UTF-8 JSON of
  an ordered array of `[startSec, durationSec, text]` tuples; no insignificant
  JSON whitespace; text normalized to Unicode NFC with CRLF and CR mapped to LF
  and leading/trailing whitespace removed; all remaining internal whitespace
  preserved; finite numbers encoded in their shortest round-trip decimal form
  with `-0` encoded as `0`; and equal-start segments kept in input order. Input
  start times MUST be nondecreasing and the canonicalizer MUST NOT sort them.
  After validation, the backend MUST use these normalized segment values as the
  sole source for fingerprinting, model-prompt construction, and retained
  transcript data, and MUST discard noncanonical request strings.
- **FR-011**: The background MAY compute a transcript fingerprint from the
  canonical segment bytes solely for exact local-cache lookup. The request MUST
  NOT send that fingerprint. The backend MUST independently compute the
  authoritative SHA-256 fingerprint after validation.
- **FR-012**: Local results, persistent artifacts, and in-flight jobs MUST be
  identified by the active server algorithm version, video ID, normalized
  language, and authoritative canonical segment fingerprint. Language MUST be
  trimmed and ASCII-lowercased without alias folding and is not included in the
  segment fingerprint.
- **FR-013**: Equivalent canonical transcripts MUST reuse exact local/server
  results and join exact in-flight jobs; a changed language, meaningful text,
  timing, segment structure, video ID, or algorithm version MUST produce a
  distinct identity.
- **FR-014**: Exact cache hits and joined jobs MUST NOT consume cold-job quota,
  queue capacity, or model budget. A cold miss MUST continue to obey all
  existing installation/IP quotas, global queue limits, and atomic model-budget
  reservation rules. Every authenticated HTTP request, including a hit or join,
  MUST still consume the existing request-rate quota.
- **FR-015**: Every analysis response MUST report the active server-owned
  `algorithmVersion`. Every response bound to an accepted transcript, including
  an immediate hit, processing state, or terminal result, MUST additionally
  report the exact `videoId`, normalized `languageCode`, and server-computed
  `transcriptHash`. Authentication, body-size, schema, and other pre-identity
  failures MAY omit only the transcript-specific identity fields.
- **FR-016**: The extension MUST NOT compare the returned algorithm version with
  a bundled compile-time value. It MUST invalidate or bypass local results that
  do not match the active server configuration and exact transcript identity.
- **FR-017**: Cold analysis MUST preserve the existing asynchronous contract:
  initial submission returns a result or a job and retry interval, and the
  background performs owner-authorized HTTP polling until a terminal outcome.
  Joining an existing job MUST add that authenticated installation to the job's
  authorized pollers; an unrelated installation and possession of `jobId`
  alone MUST NOT authorize polling. The feature MUST NOT require a WebSocket.
- **FR-018**: Polling and retries MUST remain bounded and cancellable. Navigation,
  disablement, analysis-mode change, a superseding caption session, or a
  terminal result MUST prevent further updates from the obsolete session.
  The current content session MUST retain its validated caption payload in
  memory until terminal or cancellation so one token-expiry or `job_not_found`
  recovery can resubmit the exact transcript after background-worker suspension.
- **FR-019**: Valid terminal promo blocks MUST be delivered without semantic
  changes to popup and playback logic. Blocks received after their start MUST
  not be skipped retroactively, and future block crossings MUST be skipped at
  most once according to existing playback behavior.
- **FR-020**: The serialized detection state owned by background MUST carry an
  explicit typed phase for caption acquisition versus server analysis. Content
  MUST publish a bounded acquisition-start/reset event, and popup MUST render
  localized copy from that phase rather than infer it from timing. A watch
  session MUST NOT transition back to an earlier phase.
- **FR-021**: An exact local-cache hit MAY transition directly from caption
  acquisition to ready. Server processing, no-promo, video limitation,
  capacity, provider, invalid-response, and internal failures MUST retain their
  existing safe terminal categories.
- **FR-022**: `captions_unavailable` produced before submission MUST be presented
  as a limitation of the current video's captions, not as invalid user settings
  or a TopSkip server outage, and it MUST contain no fabricated support ID.
  `caption_extraction_failed` MUST instead identify a TopSkip capture
  malfunction, not a video limitation or user-settings problem.
- **FR-023**: Uploaded captions MUST be framed and processed exclusively as
  untrusted transcript data. Transcript text MUST NOT override model system
  instructions, tool behavior, response schema, normalization, or safety
  checks.
- **FR-024**: Invalid, malformed, over-limit, unauthenticated, over-budget, or
  unschedulable requests MUST reach zero model calls. Valid cold work MUST keep
  the existing single model attempt, timeout, response-size bound, cost
  accounting, and unsafe-output rejection.
- **FR-025**: The default server MUST not claim to have independently verified
  video existence, availability, caption provenance, or authoritative duration.
  Default-mode errors MUST describe only conditions established from the
  submitted data and service behavior.
- **FR-026**: Validated transcripts for completed cold jobs, bounded assistant
  content exactly as received, normalized promo blocks, safe usage/cost
  metadata, and safe failure records MUST be access-restricted, retained for no
  more than 30 days, and pruned by the existing age, maximum-artifact, and
  free-disk policies. Reasoning, provider envelopes, raw provider errors, and
  provider diagnostics MUST NOT be persisted.
- **FR-027**: Logs, metrics exposed to clients, HTTP errors, popup state, and
  support-report URLs MUST exclude transcript text, subtitle bodies, raw model
  output, provider bodies, request/response bodies, credentials, installation
  tokens, raw IPs, cookies, and signed URLs.
- **FR-028**: Safe internal diagnostics MAY include bounded identifiers,
  normalized language, segment and character counts, cache decision, queue
  depth, latency, token usage, cost, and stable outcome codes. A transcript hash
  or prefix MUST be omitted unless a privacy review explicitly approves it.
- **FR-029**: Existing anonymous installation ownership, token expiry/retry,
  installation/IP quotas, trusted edge-IP handling, CORS hygiene, job ownership,
  global capacity, model budgets, typed errors, support IDs, and minimal health
  and config responses MUST remain enforced.
- **FR-030**: Private BYOK MUST perform zero TopSkip registration, config,
  analysis, polling, or issue-diagnostic requests for video analysis and MUST
  not store its transcript in TopSkip server artifacts.
- **FR-031**: Extension-upload extraction MUST be the default server mode and
  the public VPS mode. In that mode, startup and request processing MUST NOT
  assert, initialize, spawn, download, update, or require yt-dlp.
- **FR-032**: Retained yt-dlp source, tests, pinned-release metadata, install
  manager, and pin-refresh tooling MUST remain in the repository and be
  reachable only through the startup-only
  `TOPSKIP_CAPTION_SOURCE=legacy_yt_dlp` operator mode, which is disabled by
  default.
  Legacy mode MUST NOT activate automatically after a caption, request, or model
  failure and MUST NOT be exposed as an extension preference.
- **FR-033**: When legacy mode is explicitly enabled, its binary requirements
  and failures MUST remain bounded and actionable. It MUST wholly select the
  retained metadata-only `/v1/analysis` behavior for that isolated server;
  requests cannot select or mix caption sources. The public contract documents
  only `extension_upload`, and unknown mode values MUST fail startup closed.
- **FR-034**: The shared Valibot `/v1` contract in
  `common/src/server-analysis-contract.ts` MUST be the sole executable and
  documented source of truth, describe transcript upload as mandatory for
  default Server mode, remove obsolete request-version gating, document
  authoritative response identity, preserve owner-authorized polling, and
  reject the old default metadata-only shape. No parallel OpenAPI/YAML contract
  or parity dependency is required.
- **FR-035**: Product, development, deployment, operator, privacy, and
  contributor documentation MUST state that Server mode uploads timed captions,
  that validated transcripts and bounded assistant output are access-restricted
  and retained for up to 30 days, that background owns all HTTP, that default
  runtime does not use yt-dlp, that retained legacy mode is operator-only, and
  that Private BYOK remains isolated.
- **FR-036**: The production container and VPS configuration MUST select
  extension-upload mode and start successfully without a yt-dlp executable.
  Existing SQLite persistence, resource constraints, loopback binding,
  Cloudflare routing, secret handling, health checks, and rollback protections
  MUST remain intact.
- **FR-037**: Rollout MUST include contract, unit, coverage, build, browser E2E,
  container, and deployment validation; one paid real-video model smoke; public
  and loopback health checks; and manual verification of popup phases, polling,
  promo intervals, and future-block seeking on the deployed service.
- **FR-038**: Deployment MUST automatically restore the previous healthy image
  if the new image or public endpoint fails its release checks. A successful
  rollout MUST NOT create or restart a 48-hour beta-monitoring requirement. The
  new extension build MUST be distributed or manually reloaded only after the
  new public backend passes its checks.
- **FR-039**: The active algorithm version MUST change to `server-v5`, uploaded
  artifacts MUST use a distinct extension-caption source, and local/server
  lookups MUST exclude old video-only or null-fingerprint artifacts even when
  their video ID matches. The legacy yt-dlp source value MUST remain readable.
- **FR-040**: Persistent-state changes MUST be additive and readable by the
  previous production image so automatic backend rollback can start safely.
  New and old artifact rows MUST coexist until normal retention pruning.
- **FR-041**: If config refresh fails, background MAY use an unexpired exact
  local result only when it matches the last successfully observed server
  algorithm and current transcript identity. It MUST NOT infer the algorithm by
  selecting whichever cached row is newest.

### Key Entities

- **Caption Capture Session**: One bounded attempt for a specific watch
  navigation to obtain the player-selected language and timed segments while
  preserving the viewer's caption state and rejecting stale completion.
- **Transcript Submission**: The authenticated Server-mode request containing
  the video identifier, extension version, normalized language, optional
  duration hint, and complete timed segments.
- **Canonical Transcript**: The deterministic UTF-8 representation of validated
  ordered timed segments used to distinguish meaningful transcript revisions
  from harmless serialization differences; normalized language remains a
  separate identity component.
- **Transcript Identity**: The active server algorithm version, video ID,
  normalized language, and server-authoritative SHA-256 fingerprint of the
  canonical transcript.
- **Analysis Job**: Owner-authorized asynchronous work for one transcript
  identity, with an authorized-installation set extended on a valid join,
  processing, polling, cancellation-independent server completion, and a
  terminal outcome.
- **Analysis Artifact**: The retained transcript, bounded raw assistant content,
  normalized blocks, identity, prompt/model metadata, usage/cost, outcome, and
  30-day pruning metadata.
- **Local Server Result**: An extension-background cache entry containing promo
  blocks, exact transcript identity, active server algorithm version, and
  freshness metadata.
- **Detection Session Status**: The current watch session's monotonic state,
  including caption acquisition, server analysis, ready/no-promo, or safe
  terminal failure.
- **Legacy Extraction Mode**: An operator-only, default-disabled mode retaining
  the previous yt-dlp path for isolated testing or migration work without
  serving as an automatic product fallback.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a healthy supported video, the extension captures and forwards
  a non-empty timed transcript within the existing target of three seconds
  after player readiness, without requiring manual caption activation or
  leaving the viewer's caption setting changed.
- **SC-002**: In automated tests, caption absence, capture failure, stale
  navigation, disablement, and mode changes produce zero TopSkip analysis
  requests and zero model calls for the obsolete or failed session.
- **SC-003**: A canonicalization matrix produces identical browser and server
  identity for every logically equivalent transcript and a distinct identity
  for every changed video, normalized language, meaningful text, timing,
  segmentation, or algorithm case.
- **SC-004**: Two simultaneous submissions for one exact cold identity produce
  one model request, while changed-language and changed-transcript submissions
  never join or reuse that work.
- **SC-005**: Independent boundary tests accept exactly 18,000 seconds, 10,000
  segments, 500,000 normalized Unicode scalar values, and 8 MiB of raw request
  bytes, and reject every tested value above its corresponding limit before
  model invocation.
- **SC-006**: Malformed, unauthenticated, forged-hash, prompt-injection-like,
  over-quota, over-capacity, and over-budget cases expose only stable safe
  outcomes and produce no unauthorized model work or transcript disclosure.
- **SC-007**: Repeated popup observations during one watch session follow only
  valid forward transitions from caption acquisition to analysis or directly
  to a terminal state, with no contradictory status flicker.
- **SC-008**: Private BYOK end-to-end tests observe zero TopSkip backend traffic
  while still completing analysis from browser-captured captions.
- **SC-009**: The default production image starts and completes a
  transcript-upload cache miss without a yt-dlp executable or yt-dlp process;
  the isolated legacy-mode test remains operational only when explicitly
  configured.
- **SC-010**: Retention and pruning tests keep validated transcripts and bounded
  assistant content for no more than 30 days, never retain reasoning/provider
  envelopes/raw errors, and enforce the existing artifact count and free-disk
  limits without exposing retained contents in diagnostics.
- **SC-011**: Formatting, lint, type checking, unit, contract, coverage, build,
  browser E2E, container, deployment, and release-boundary checks all pass for
  the new `/v1` contract.
- **SC-012**: A paid real-video smoke through the deployed public hostname
  reaches a terminal result whose block count and intervals match the selected
  video's human-reviewed reference, displays stable popup phases, and skips a
  future promo block once; loopback and public health checks pass and no 48-hour
  monitor is started.

  **Validation status (2026-07-18): Pending one live-capture gate.** The paid
  public analysis, human-window comparison, exact cache reuse, public/loopback
  health checks, beta popup result, and one native future-block seek passed.
  The beta browser smoke used a saved real-video JSON3 response because clean
  automated YouTube profiles returned an empty timedtext body, so the cold paid
  analysis and browser capture/seek evidence came from two separate runs.
- **SC-013**: A joined installation can poll the shared job after a valid join,
  an unrelated token and a bare `jobId` cannot, and token-expiry recovery
  resubmits once without creating duplicate model work.
- **SC-014**: `server-v5` and extension-caption source tests prove that old
  video-only artifacts never satisfy new lookups, additive state remains
  readable by the rollback image, and exact offline local results are never
  chosen by cache recency alone.
