# PRD: Server-First Promo Detection

- **Created**: 2026-07-04
- **Status**: Validated
- **Model**: GPT-5 Codex
- **Input**: User wants TopSkip to work as a hybrid extension/server product: the extension should work with a backend that extracts subtitles, analyzes them, caches promo blocks, and returns timings to the extension faster on repeat/popular videos. The server is the default path; local/BYOK analysis is retained only as a privacy-oriented alternative for users who do not want watched video IDs sent to the TopSkip server.

## Problem Statement

TopSkip currently depends on browser-side caption capture and user-configured LLM providers. That makes the extension harder to configure, exposes provider details in the extension UI, repeats expensive analysis across users, and cannot benefit from shared results for popular videos. Cold analyses also compete with the user's current playback timeline: if detection finishes after a promo block has already started, the extension cannot skip that block without surprising the user.

The product needs a server-first detection path that can reuse cached promo timings, run stronger subtitle extraction and analysis outside the extension, protect backend capacity from abuse, and keep a privacy-preserving BYOK mode for users who do not want their watched video IDs sent to TopSkip infrastructure.

## Solution

TopSkip will use a backend service as the default promo-detection source. On a supported YouTube watch page, the extension identifies the current video and asks the backend for promo blocks. If the backend already has a valid result, it returns the blocks immediately and the extension applies them during playback. If the backend has no result, it starts or joins a server-side analysis job that extracts subtitles through multiple strategies, analyzes the transcript, stores all useful artifacts for future debugging and cache reuse, and returns the normalized promo blocks when ready.

The extension also keeps a local cache of server results to avoid unnecessary server calls for recently seen videos. There is no automatic local fallback when the server is slow or unavailable; playback continues without server-detected skips until the backend or extension cache has a valid result. A separate private BYOK mode bypasses TopSkip servers for video analysis and keeps analysis inside the existing extension-owned provider path for users who prefer not to disclose watched video IDs to TopSkip.

## Assumptions

- Server mode is the default detection mode for new users and for normal product UX.
- Existing provider-specific choices such as OpenRouter, OpenAI, and browser built-in models are removed from the main setup flow. Any retained direct-provider analysis is grouped under a private BYOK/advanced mode.
- In server mode, the extension sends video metadata only: YouTube video ID, duration when known, extension/app version, algorithm/cache version, and safe client capability metadata. It does not send raw captions by default.
- The server is responsible for subtitle acquisition. It may use transcript libraries, YouTube-derived caption sources, alternate extraction strategies, and audio transcription when subtitles are unavailable or unreliable.
- Server cache keys are based on video ID plus algorithm/version metadata, not subtitle language. The selected subtitle language/source is recorded as metadata, because promo block timings are video-timeline facts and should normally be reusable across languages.
- Server storage is intentionally rich for debugging and quality iteration: transcripts, extraction attempts, raw model responses, normalized blocks, prompt/model versions, latency/cost metadata, and failure reasons are stored with retention controls.
- Raw audio or media artifacts, if needed for audio-based transcription, are temporary working artifacts unless a later explicit debug-retention policy allows longer storage.
- The first implementation targets a local backend endpoint for development and testing. Public deployment through Cloudflare or an equivalent edge/WAF layer is deferred to a future hardening task.
- Extension ID/origin checks are defense in depth, not a true authentication boundary. For the local backend MVP, request validation and lightweight rate-limit hooks are enough; production abuse controls are deferred until the API is exposed beyond local development.
- The first server version does not require user accounts.
- The extension local cache obeys server-provided freshness metadata and is invalidated by algorithm/cache version changes.
- User correction/community feedback is a valuable future feature, but this PRD only reserves a future design path for it.
- The backend will live in the same repository as the extension, as a separate product area/package.

## User Stories

### User Story 1 - Get Cached Promo Blocks Quickly (Priority: P1)

As a `viewer`, I want TopSkip to reuse existing promo-block results for a video, so that skipping works quickly without waiting for a fresh LLM analysis.

**Why this priority**: Cache hits are the main reason to add a backend. They reduce latency, cost, and repeated analysis for popular videos.

**Acceptance Scenarios**:

1. **Given** server mode is enabled and the extension opens a YouTube watch video with a valid server-side cache entry, **When** the extension requests analysis by video ID, **Then** the backend returns normalized promo blocks without starting a new extraction or LLM job.
2. **Given** the extension has a fresh local cache entry for the current video and algorithm version, **When** the user opens the video again, **Then** the extension applies cached promo blocks without making a server request.
3. **Given** the extension has a stale local cache entry, **When** the user opens the video, **Then** the extension asks the server for a fresh result instead of applying stale blocks.
4. **Given** cached blocks arrive before playback crosses a block start, **When** playback naturally reaches that block, **Then** TopSkip skips to that block's end exactly once.

---

### User Story 2 - Analyze Uncached Videos on the Server (Priority: P1)

As a `viewer`, I want TopSkip to analyze uncached videos on the server, so that I do not need to configure my own model or API key for normal use.

**Why this priority**: This is the default cold-path behavior. The extension must remain useful on videos the server has never seen.

**Acceptance Scenarios**:

1. **Given** the backend has no valid result for a video, **When** the extension requests analysis, **Then** the backend starts or joins a server-side analysis job and returns a processing state rather than failing as no-promo.
2. **Given** a server-side job is already running for the same video and algorithm version, **When** another extension client requests analysis, **Then** the backend attaches the request to the existing job instead of duplicating extraction and LLM work.
3. **Given** the job completes with valid promo blocks, **When** the extension polls or refreshes the analysis state, **Then** it receives the normalized blocks and can cache them locally.
4. **Given** the job completes after playback has already passed an early promo block, **When** the extension receives the result, **Then** it applies only future block crossings and does not jump backward.
5. **Given** the server cannot finish analysis before the user leaves the video, **When** the job later completes, **Then** the result remains cached for future viewers.

---

### User Story 3 - Extract Subtitles Through Server Strategies (Priority: P1)

As a `server operator`, I want subtitle extraction to run on the backend through multiple strategies, so that the extension is not limited to the browser's current caption-capture behavior.

**Why this priority**: Server-side extraction is the main architectural shift. It enables retries, libraries, audio transcription, and shared debugging without shipping every strategy inside the extension.

**Acceptance Scenarios**:

1. **Given** a video has directly available captions, **When** the backend analyzes it, **Then** it stores the selected transcript and records the extraction strategy that produced it.
2. **Given** a video has no usable caption transcript through the first strategy, **When** analysis continues, **Then** the backend tries additional configured extraction strategies before declaring captions unavailable.
3. **Given** caption extraction requires audio transcription, **When** the backend uses that path, **Then** it records the transcription source and transcript confidence metadata while avoiding permanent media retention by default.
4. **Given** all extraction strategies fail, **When** the job finishes, **Then** the backend stores a failure result with stage-specific reasons and the extension shows an unavailable/error state without skipping.

---

### User Story 4 - Store Analysis Artifacts for Debugging and Improvement (Priority: P1)

As a `maintainer`, I want the backend to retain enough analysis artifacts, so that wrong detections, extraction failures, and model regressions can be investigated later.

**Why this priority**: A shared server is only useful if results can be audited and improved. Without stored artifacts, every bug becomes hard to reproduce.

**Acceptance Scenarios**:

1. **Given** a server analysis succeeds, **When** maintainers inspect the record, **Then** they can see video metadata, transcript source, transcript text, prompt/model versions, raw model response, parsed blocks, normalized blocks, and timing/cost metadata.
2. **Given** a server analysis fails, **When** maintainers inspect the record, **Then** they can see extraction attempts, failure reasons, provider/model errors, retry metadata, and the final user-facing status.
3. **Given** a new algorithm version is released, **When** a video is analyzed again, **Then** the backend stores the new result alongside version metadata rather than overwriting history in a way that prevents comparison.
4. **Given** operational logs contain client or network metadata, **When** they are persisted, **Then** they avoid storing secrets, extension-local API keys, cookies, or YouTube account tokens.

---

### User Story 5 - Keep the Local Backend API Bounded (Priority: P2)

As a `server operator`, I want the local backend API to validate requests and keep expensive work bounded, so that the MVP is easy to test now and can later be hardened for public deployment.

**Why this priority**: The first server slice should stay local and testable. Expensive work still needs basic guardrails, but Cloudflare/WAF and origin-IP hiding should not block local iteration.

**Acceptance Scenarios**:

1. **Given** server mode is enabled in a development build, **When** the extension calls the backend, **Then** it targets a configured local backend endpoint.
2. **Given** a request has an invalid or missing video ID, **When** the backend evaluates it, **Then** it rejects the request without starting extraction, transcription, or LLM work.
3. **Given** repeated cold-analysis requests exceed the local rate-limit policy, **When** the backend evaluates another request, **Then** it returns a retryable status without starting expensive work.
4. **Given** a cache-hit request is cheap and a cold analysis request is expensive, **When** local limits are applied, **Then** the backend can distinguish cheap lookups from expensive job starts.
5. **Given** the API is prepared for future public deployment, **When** production hardening is planned, **Then** Cloudflare/WAF, origin-IP hiding, stronger quotas, and optional anonymous issued client tokens can be added without changing the core extension analysis flow.

---

### User Story 6 - Use Private BYOK Mode Without TopSkip Server Calls (Priority: P2)

As a `privacy-sensitive viewer`, I want a private BYOK mode, so that TopSkip does not send my watched video IDs to the TopSkip backend.

**Why this priority**: Server mode improves speed and usability, but some users will prefer not to disclose viewing activity to TopSkip infrastructure.

**Acceptance Scenarios**:

1. **Given** private BYOK mode is selected, **When** the user opens a YouTube watch video, **Then** the extension does not call the TopSkip backend for cache lookup, job creation, status polling, or result upload.
2. **Given** private BYOK mode is selected and configured, **When** captions are available through the extension path, **Then** analysis uses the user's configured provider path and never writes the result to the shared server cache.
3. **Given** private BYOK mode is selected but not configured, **When** the user opens a video, **Then** TopSkip shows a setup-required state and does not silently fall back to server mode.
4. **Given** the user switches from private BYOK to server mode, **When** a new video loads, **Then** server cache lookup resumes for that new video only.

---

### User Story 7 - Show Clear Analysis Status in the Extension (Priority: P2)

As a `viewer`, I want the popup/status UI to explain whether TopSkip is using server cache, server analysis, local cache, or private BYOK, so that I understand why skipping is or is not happening.

**Why this priority**: Server-side work may be asynchronous. Without clear status, users will interpret waiting as broken behavior.

**Acceptance Scenarios**:

1. **Given** a local extension cache hit is used, **When** the user opens the popup, **Then** it indicates that promo blocks came from local cache.
2. **Given** the server returns a cache hit, **When** the user opens the popup, **Then** it indicates that server-detected blocks are ready.
3. **Given** the server is analyzing an uncached video, **When** the user opens the popup, **Then** it shows an analyzing-on-server state instead of asking for a provider key.
4. **Given** the server returns a terminal failure, **When** the user opens the popup, **Then** it shows a concise unavailable/error state and playback is not altered for that reason.
5. **Given** private BYOK mode is active, **When** the user opens the popup, **Then** it identifies the mode clearly and does not imply shared server caching is being used.

---

### User Story 8 - Reserve a Path for User Corrections (Priority: P3)

As a `maintainer`, I want the design to leave room for future user feedback and corrections, so that wrong server-detected blocks can eventually be improved through product workflows.

**Why this priority**: Feedback is useful but not required for the first server-first release. Capturing it as a future path prevents the backend data model from blocking it later.

**Acceptance Scenarios**:

1. **Given** the first server-first release ships, **When** users encounter wrong blocks, **Then** there is no required in-product correction workflow in this PRD.
2. **Given** the backend stores analysis history, **When** a future correction feature is designed, **Then** the stored result model can associate corrections with a video and algorithm version.

## Key Entities

### Video Analysis Request

- **Attributes**: video ID, duration when known, extension version, algorithm/cache version, mode, client capability metadata.
- **Relationships**: Creates or reads an Analysis Job and may return an Analysis Cache Entry.
- **Validation**: Video ID must be non-empty and match supported YouTube ID constraints; duration must be positive when present.
- **States**: accepted → cache-hit, processing, rate-limited, unavailable, or error.

### Analysis Cache Entry

- **Attributes**: video ID, algorithm version, result status, promo blocks, transcript source metadata, freshness/expiry metadata, created/updated timestamps.
- **Relationships**: Produced by an Analysis Job; consumed by the extension and extension local cache.
- **Validation**: Promo blocks must be sorted, non-overlapping after normalization, inside known duration when duration is available, and tagged with the algorithm version that produced them.
- **States**: processing → ready, no-promo, unavailable, error, superseded.

### Analysis Job

- **Attributes**: job ID, video ID, algorithm version, started/completed timestamps, current stage, retry count, joined request count, final status.
- **Relationships**: Owns extraction attempts, model analysis runs, and the resulting cache entry.
- **Validation**: Only one active job should exist for the same video ID and algorithm version unless a forced reanalysis mode is introduced later.
- **States**: queued → extracting → analyzing → normalizing → complete or failed.

### Transcript Artifact

- **Attributes**: transcript text, source type, language code when known, confidence/quality metadata, segment timing data, acquisition timestamp.
- **Relationships**: Created by subtitle extraction; consumed by LLM analysis; retained for debugging.
- **Validation**: Must contain ordered timed text segments before it can produce promo blocks.
- **States**: candidate → selected, rejected, or failed.

### Extraction Attempt

- **Attributes**: strategy name, started/completed timestamps, outcome, failure reason, safe diagnostic metadata, temporary artifact references when applicable.
- **Relationships**: Belongs to an Analysis Job and may produce a Transcript Artifact.
- **Validation**: Must not store cookies, account tokens, extension secrets, or unredacted credential material.
- **States**: pending → succeeded, failed, skipped, or timed out.

### Promo Block Result

- **Attributes**: start time, optional end time, confidence, source run, normalization notes.
- **Relationships**: Derived from model output and stored in an Analysis Cache Entry; sent to the extension.
- **Validation**: Start must be before end when end exists; invalid or full-video degenerate blocks are rejected or marked for review.
- **States**: raw → parsed → normalized → delivered.

### Extension Local Cache Entry

- **Attributes**: video ID, algorithm/cache version, promo blocks, source result ID, freshness/expiry metadata, stored timestamp.
- **Relationships**: Mirrors a server Analysis Cache Entry for fast local reuse.
- **Validation**: Must be invalidated when server-provided version or freshness metadata is stale.
- **States**: fresh → stale → evicted.

### Client Trust Signal

- **Attributes**: extension ID/origin signal when available, extension version, anonymous client token if introduced later, local rate-limit bucket metadata.
- **Relationships**: Evaluated by API protection before job creation.
- **Validation**: Must be treated as an abuse-control signal, not proof of user identity.
- **States**: accepted, challenged/future, rate-limited, blocked.

### Private BYOK Mode

- **Attributes**: enabled/disabled, provider setup status, selected private provider/model when retained.
- **Relationships**: Mutually exclusive with server mode for video analysis.
- **Validation**: When active, no TopSkip server analysis/cache/status requests are allowed for watch videos.
- **States**: off → setup-required → ready → error.

## Module Design

### Extension Analysis Source Selector

- **Responsibility**: Chooses server mode or private BYOK mode for the current video.
- **Interface**: Inputs are user mode preference, current video metadata, and cache state. Outputs are either a server request flow, a private BYOK flow, or a setup/unavailable status. Failure modes include missing setup, server unavailable, and rate-limited.
- **Tested**: yes

### Extension Server Client

- **Responsibility**: Talks to the backend analysis API and maps backend states into extension detection statuses.
- **Interface**: Inputs are video metadata and freshness/version metadata. Outputs are cache-hit blocks, processing state, terminal failure, or retryable rate-limit state. Failure modes include network timeout, invalid response, and stale result.
- **Tested**: yes

### Extension Result Cache

- **Responsibility**: Stores fresh server results locally and serves them before network lookup.
- **Interface**: Inputs are video ID, algorithm version, server freshness metadata, and promo blocks. Outputs are fresh cache hit, stale miss, or empty miss. Failure modes include corrupt local data and version mismatch.
- **Tested**: yes

### Backend Analysis API

- **Responsibility**: Public API surface for lookup, job creation/joining, and status/result retrieval.
- **Interface**: Inputs are validated video analysis requests. Outputs are ready result, processing state, rate-limit response, unavailable, or error. Failure modes include invalid video ID, blocked client, duplicate job conflict, and internal job failure.
- **Tested**: yes

### Backend API Protection

- **Responsibility**: Applies local request validation and basic rate-limit hooks before expensive work starts, while leaving room for future public API hardening.
- **Interface**: Inputs are request metadata, trust signals when available, current rate-limit counters, and endpoint cost class. Outputs are allow, rate-limit, or block decisions. Failure modes include invalid request shape and quota exhaustion.
- **Tested**: yes

### Backend Job Orchestrator

- **Responsibility**: Ensures one active analysis job per video/version, sequences extraction and analysis stages, and persists final states.
- **Interface**: Inputs are a video ID and algorithm version. Outputs are status transitions and cache entries. Failure modes include extraction failure, analysis failure, timeout, and cancellation by operator policy.
- **Tested**: yes

### Subtitle Extraction Pipeline

- **Responsibility**: Produces the best available timed transcript using multiple strategies.
- **Interface**: Inputs are video ID and extraction policy. Outputs are selected transcript artifact or structured unavailable state. Failure modes include captions unavailable, library failure, audio unavailable, transcription failure, and timeout.
- **Tested**: yes

### Server LLM Analysis Worker

- **Responsibility**: Runs model analysis over the selected transcript and converts raw model output into normalized promo blocks.
- **Interface**: Inputs are transcript artifact, video metadata, prompt/model version, and analysis policy. Outputs are raw response, parsed blocks, normalized blocks, no-promo, or model error. Failure modes include provider error, invalid JSON, too-large input, and degenerate blocks.
- **Tested**: yes

### Analysis Artifact Store

- **Responsibility**: Persists result history, transcripts, extraction attempts, raw model responses, and operational metadata with retention controls.
- **Interface**: Inputs are job events and artifacts. Outputs are queryable records for cache lookup and debugging. Failure modes include write failure, retention expiry, and redaction violations.
- **Tested**: yes

### Private BYOK Analysis Path

- **Responsibility**: Preserves a server-bypass mode for users who do not want TopSkip server analysis.
- **Interface**: Inputs are local extension caption data and user-owned provider configuration. Outputs are promo blocks or setup/error status. Failure modes include missing key, provider unavailable, invalid response, and caption capture failure.
- **Tested**: yes

## Implementation Decisions

- Server-first mode is the default. The normal user does not need to choose an LLM provider or provide an API key.
- There is no automatic local fallback from server mode. If the backend is unavailable, slow, or rate-limits the request, playback continues without server-detected skips until a valid cached or server result exists.
- Private BYOK is an explicit alternate mode, not a fallback. When active, it bypasses TopSkip backend analysis entirely for watch videos.
- The extension keeps a local cache of server results keyed by video ID and algorithm/cache version, honoring server-provided freshness metadata.
- The server cache is keyed by video ID and algorithm/cache version, not by subtitle language. Language/source is stored as metadata for debugging.
- The backend stores rich artifacts needed to debug quality and cost, with explicit redaction and retention controls.
- The first implementation uses a configured local backend endpoint for simpler development and testing.
- Cloudflare or equivalent edge/WAF protection, origin-IP hiding, and stronger public abuse controls are deferred to a future hardening task.
- Extension ID/origin checks remain useful filters for future production exposure, but local MVP protection is request validation plus basic rate-limit hooks.
- The repository should evolve into separate extension and backend product areas/packages in the same repository. Recommended product names are `extension` and `backend`; a future workspace layout can use app/package grouping if the repository root is reorganized.
- User correction/community feedback is intentionally deferred, but backend entities should not prevent adding corrections linked to video ID and algorithm version later.

## Testing Decisions

- Good tests for this feature verify routing and state transitions rather than only successful detection: local cache hit, server cache hit, cold processing, polling/status refresh, rate limit, server error, and private BYOK bypass.
- Extension tests should mock the backend API and assert that server mode never calls direct provider analysis, while private BYOK mode never calls the TopSkip backend for video analysis.
- Backend tests should cover job deduplication, cache lookup, extraction strategy ordering, failed extraction, invalid model output, block normalization, artifact persistence, and rate-limit decisions.
- Contract tests should validate all backend response shapes consumed by the extension, including processing, ready, no-promo, unavailable, rate-limited, and error.
- E2E tests should use deterministic fixture videos/results rather than live YouTube or live LLM calls.
- Privacy tests should assert that private BYOK mode performs no backend analysis/cache/status calls and that server-mode request payloads do not include raw transcripts by default.
- Security/abuse tests should distinguish cheap cache lookups from expensive job starts and verify that rate-limited cold requests do not enqueue work.

## Out of Scope

- User accounts, paid subscriptions, or per-user billing.
- Community voting, public correction submission, or crowdsourced review workflows.
- Automatic local fallback when server mode fails.
- Sending extension-captured raw transcripts to the server by default.
- Caching separate promo results per subtitle language.
- Permanent storage of raw audio/video media artifacts by default.
- Manual block editing UI in the extension.
- Public Cloudflare/WAF deployment, origin-IP hiding, and production API hardening.
- Migrating the repository layout or implementing backend code in this PRD step.

## Open Questions

No blocking open questions remain for the PRD. The following follow-up items should be resolved during issue planning:

| Question | Owner | Resolution Path |
| --- | --- | --- |
| What exact retention periods apply to transcripts, raw model responses, and operational logs? | Product/maintainer | Choose default retention before implementation and document privacy copy. |
| Which backend runtime, queue, database, and object storage should be used? | Engineering | Decide during implementation planning based on deployment target and cost. |
| When should local backend testing graduate to Cloudflare/WAF-fronted public deployment? | Product/engineering | Keep MVP local, then create a hardening task once local server-mode behavior is validated. |
| Should anonymous issued client tokens be added for public deployment? | Engineering | Defer until production exposure planning or until local testing reveals a concrete need. |
| Which BYOK providers should remain after server-first UX is introduced? | Product/maintainer | Decide whether to keep only one provider, multiple provider adapters, or browser-local analysis. |

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a fresh local-cache hit, the extension has applicable promo blocks available without a network request.
- **SC-002**: On a server cache hit, the backend returns ready promo blocks fast enough for the extension to apply skips before typical early promo starts when the request is made at watch-page load.
- **SC-003**: On a cold server miss, the backend returns a processing state without blocking the extension on a long-running HTTP request.
- **SC-004**: Duplicate cold requests for the same video ID and algorithm version join one active server job instead of starting duplicate expensive work.
- **SC-005**: Server-mode extension requests do not include raw caption transcript text by default.
- **SC-006**: Private BYOK mode makes zero TopSkip backend analysis/cache/status requests for watch videos.
- **SC-007**: Rate-limited cold requests do not enqueue extraction, transcription, or LLM work.
- **SC-008**: Successful server analyses persist transcript artifact, extraction metadata, raw model response, normalized blocks, model/prompt version, and timing/cost metadata.
- **SC-009**: Failed server analyses persist stage-specific failure reasons and surface a non-skipping unavailable/error state to the extension.
- **SC-010**: Cached results are invalidated when algorithm/cache version changes.
- **SC-011**: The first implementation runs against a configured local backend endpoint; public edge/WAF deployment is tracked as future hardening rather than required for MVP completion.
