# Feature Specification: Reliable YouTube Caption Capture

**Created**: 2026-05-10
**Status**: Validated
**Model**: GPT-5.5
**Implemented by**: GitHub Copilot (model/version not exposed)
**Input**: `/sdd-spec let's write the spec for the main extension, remove everything that's outdated and no longer works, and handle all the potential edge cases we missed in the mvp`

## Assumptions

- **Probe evidence is the starting point**: The MVP probe showed that direct caption URL fetches and direct InnerTube client requests no longer provide reliable captions for the tested logged-in browser session, while a player-driven caption activation produced a valid timedtext `json3` response.
- **Production must use each watch page's current video**: Caption acquisition is scoped per injected YouTube watch tab. If several watch tabs are open and TopSkip is enabled, each tab may capture captions for its own current video, while popup/status views may focus on the browser's active tab. Arbitrary server-side URL scraping, background-only video ID fetching, and fixed sample IDs are out of scope for the main extension.
- **Player-mediated capture is the primary path**: The production extension should obtain captions by letting the YouTube player make its own caption request and by capturing the resulting timedtext response, rather than trying to forge YouTube request tokens.
- **User caption state must be respected**: If the user already has captions enabled, TopSkip should not disable them. If TopSkip temporarily enables captions for analysis, it should hide rendered captions during the capture window and restore the pre-existing state after capture or timeout.
- **Outdated caption strategies should be removed from runtime control flow**: Direct timedtext fetch attempts without player-generated request parameters, direct InnerTube fallback clients that return bot/sign-in walls, fresh watch-page HTML scraping as a primary path, and development-only network debug branches should not remain as production caption acquisition dependencies.
- **Developer diagnostics remain useful but must be bounded**: Production diagnostics may report safe structural facts and failure reasons, but must not log raw caption bodies, cookies, API keys, visitor tokens, PoToken-like values, or full timedtext URLs by default.
- **No new external service is introduced**: The extension continues to run in the user's browser, uses existing provider configuration for promo detection, and does not depend on a local or remote caption proxy server.
- **User-visible consent follows existing enablement**: When the user has enabled TopSkip on a supported watch page, the extension may briefly manipulate the page player only to acquire captions needed for promo detection. A later product decision may add a separate preference, but this spec treats it as part of the enabled feature.
- **MVP research artifacts are not shipping behavior**: Files under `tmp/caption-probe-extension/` and local NDJSON logging are research tools only and should not be copied into production as-is.

## User Scenarios & Testing

### User Story 1 - Capture Captions Without Manual User Action (Priority: P1)

A user enables TopSkip and opens a YouTube watch page with available captions. TopSkip obtains caption segments automatically, without requiring the user to manually press the YouTube captions button, so promo detection can start from the transcript.

**Why this priority**: Caption acquisition is the first step in the product's core flow: captions to promo detection to skip. If users must manually enable captions, the extension does not deliver the promised automatic experience.

**Independent Test**: Start with captions off on a supported YouTube watch page that has captions. Enable TopSkip, wait for the caption capture flow, and verify the background receives parsed caption segments for the current video.

**Acceptance Scenarios**:

1. **Given** TopSkip is enabled and the user opens a supported watch page with captions available, **When** the player becomes ready, **Then** TopSkip captures caption data for the current video without requiring the user to press the YouTube captions control.
2. **Given** caption data is captured successfully, **When** the content script parses the response, **Then** it forwards structured timed caption segments to the background for promo detection.
3. **Given** the current video changes through YouTube single-page navigation, **When** the new watch video becomes active, **Then** TopSkip resets per-video caption state and captures captions for the new video rather than reusing the previous transcript.
4. **Given** a successful caption payload was already sent for a video, **When** duplicate player requests or duplicate capture events occur, **Then** TopSkip does not send duplicate caption payloads for that same video.

---

### User Story 2 - Preserve User Caption Preferences and Avoid Visible Caption Flicker (Priority: P1)

A user who keeps captions off should not see subtitles flash on screen while TopSkip acquires captions. A user who already has captions on should keep them on after TopSkip finishes.

**Why this priority**: The working caption path briefly uses the page player. Without state preservation and overlay hiding, TopSkip would visibly change the user's viewing experience, which is surprising and undermines trust.

**Independent Test**: Run the capture flow once with YouTube captions off and once with captions already on. Verify captions are visually hidden during automated acquisition in the off case, and verify the final captions state matches the state before TopSkip acted.

**Acceptance Scenarios**:

1. **Given** YouTube captions are off before TopSkip starts capture, **When** TopSkip temporarily enables captions to trigger the player request, **Then** rendered caption text is hidden before activation and remains hidden until capture completes or times out.
2. **Given** YouTube captions are off before capture, **When** TopSkip captures the caption response or reaches the capture timeout, **Then** TopSkip turns captions back off and removes only the hiding style it added.
3. **Given** YouTube captions are on before capture, **When** TopSkip detects that state, **Then** it does not turn captions off after capture.
4. **Given** the user manually changes the captions button during TopSkip's capture window, **When** TopSkip is about to restore state, **Then** it detects the user action and does not undo the user's newer choice.
5. **Given** the player API lacks a preferred activation or deactivation method, **When** TopSkip attempts capture, **Then** it uses the next safe available method or exits with a bounded failure rather than throwing or leaving hidden captions behind.

---

### User Story 3 - Remove Outdated Caption Fetch Paths From Production (Priority: P1)

A developer maintaining TopSkip can reason about a single supported caption acquisition strategy. Code paths that are known to return empty bodies or bot/sign-in walls are removed from production runtime flow so errors are clearer and future debugging focuses on the path that works.

**Why this priority**: Keeping obsolete fallbacks makes failures noisy, slower, and harder to understand. The MVP logs showed several paths fail deterministically for the tested case, so production should not depend on them.

**Independent Test**: Inspect and run the production caption flow. Verify it no longer performs direct un-tokened timedtext attempts, direct InnerTube player fallbacks, get-transcript fallbacks, or fresh watch HTML scraping as normal runtime acquisition steps.

**Acceptance Scenarios**:

1. **Given** TopSkip needs captions, **When** production caption acquisition starts, **Then** it prioritizes player-mediated timedtext capture rather than direct timedtext URL probing.
2. **Given** the player-mediated path fails, **When** TopSkip reports the failure, **Then** the error identifies the stage that failed instead of surfacing misleading "blocked automated access" or generic empty transcript messages.
3. **Given** development-only probes or logs exist, **When** a production build runs, **Then** they are disabled or removed unless explicitly guarded behind a development flag.
4. **Given** tests reference old direct-fetch behavior, **When** tests are updated for this feature, **Then** they assert the new capture contract instead of preserving obsolete fallback behavior.

---

### User Story 4 - Handle Unavailable or Blocked Caption Capture Gracefully (Priority: P2)

A user may watch videos with no captions, age/sign-in restrictions, changed YouTube player internals, ads playing, or browser/runtime limitations. TopSkip should fail clearly and non-destructively.

**Why this priority**: YouTube integration is undocumented and can change. Failure must not break playback, hide captions permanently, spam retries, or trigger incorrect skips.

**Independent Test**: Simulate or exercise representative failure cases: no caption tracks, player not ready, capture timeout, invalid response body, unsupported page, extension reload during capture, and YouTube navigation during capture.

**Acceptance Scenarios**:

1. **Given** the current video has no available captions, **When** TopSkip attempts caption capture, **Then** it reports captions unavailable and does not start promo detection from empty input.
2. **Given** YouTube's player API is unavailable or renamed, **When** TopSkip cannot activate captions safely, **Then** it exits without changing the user's caption state and surfaces a clear acquisition failure.
3. **Given** an ad is currently shown or the player is in a transient loading state, **When** caption capture is scheduled, **Then** TopSkip waits for a stable watch-player state or retries within a bounded policy.
4. **Given** capture times out after temporary activation, **When** cleanup runs, **Then** TopSkip restores the pre-capture caption state and removes hide styling.
5. **Given** the extension context is invalidated during capture, **When** messages or cleanup fail, **Then** YouTube playback is not interrupted and no permanent page styling remains after reload/navigation.
6. **Given** the captured body is empty, non-JSON, malformed, or contains no cues, **When** parsing runs, **Then** TopSkip reports a parse/acquisition failure and does not send empty segments to promo detection.

---

### User Story 5 - Keep Caption Capture Private and Minimal (Priority: P2)

A user expects TopSkip to inspect captions only to detect promo blocks and not to collect unrelated page or token data. Developers need enough diagnostics to troubleshoot failures without leaking sensitive values.

**Why this priority**: The working path observes YouTube network responses inside the user's page. That power must be scoped narrowly to preserve trust and reduce review risk.

**Independent Test**: Run caption acquisition with diagnostics enabled and inspect logs/messages. Verify production logs contain only safe metadata by default and raw caption bodies are only passed through the internal parsing pipeline, not persisted or printed.

**Acceptance Scenarios**:

1. **Given** caption capture succeeds, **When** production diagnostics are emitted, **Then** logs include high-level stage, status, body length, language, segment count, and sanitized URL shape only.
2. **Given** timedtext URLs include signed or attestation-related parameters, **When** TopSkip logs diagnostics, **Then** it does not log raw parameter values.
3. **Given** OpenRouter or another provider is configured, **When** captions flow to promo detection, **Then** only the transcript data required for the configured provider is sent according to existing provider behavior.
4. **Given** local research logging exists under `tmp/`, **When** building or packaging the main extension, **Then** that local server/logging code is not included in the shipped extension.

### Edge Cases

- **Unsupported page**: Home, search, channel pages, Shorts, embeds, and local e2e fixtures should not run production YouTube capture unless explicitly supported by page-guard rules.
- **Missing or changing video id**: Capture should abort when no stable current video id exists and should cancel stale work when navigation changes the id.
- **YouTube single-page navigation**: Per-video dedupe, observers, pending timers, temporary style elements, and player state snapshots must reset on navigation.
- **Captions already on**: Existing user-enabled captions should remain visible and enabled after capture.
- **Captions initially off**: Temporary activation should be visually hidden, bounded in time, and followed by cleanup.
- **Manual user toggle during capture**: A user action during the capture window should take precedence over TopSkip's earlier state snapshot.
- **Player API differences**: Missing `loadModule`, `setOption`, `toggleSubtitlesOn`, `toggleSubtitlesOff`, or `unloadModule` should be handled through safe capability checks and clear failure/cleanup.
- **Delayed player readiness**: Capture should wait for the watch player only within a bounded policy and should not use unbounded polling.
- **Ads and overlays**: Capture should avoid running while an ad is likely active or while the main watch player is not the current media context.
- **No captions available**: Videos with disabled captions, unavailable tracks, or language-only restrictions should produce a user/developer-visible unavailable state, not repeated empty retries.
- **Language selection**: If multiple languages are available, capture should accept the language YouTube's player selects for the current user session; language metadata must be included in the caption payload.
- **Duplicate timedtext requests**: Repeated player requests should not cause repeated promo detection runs for the same video unless a new video id or explicit recapture occurs.
- **Malformed timedtext**: Empty, HTML, XML when JSON was expected, malformed JSON, or JSON with no cues should fail clearly.
- **Caption response size**: Long transcripts should be parsed and forwarded as structured segments without console-dumping raw bodies by default.
- **Extension reload or service worker sleep**: Content-side cleanup must not rely on the background being alive at the exact cleanup moment.
- **Trusted Types and page CSP**: The approach must not rely on string evaluation or dynamic script text that YouTube's page policy rejects.
- **Wrapper side effects**: MAIN-world fetch/XHR observation must preserve original behavior, response semantics, method arguments, and errors for YouTube scripts.
- **Privacy and review**: Production must not request extra host permissions or capture broad network traffic beyond what is necessary for YouTube caption acquisition.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST acquire captions for the current supported YouTube watch-page video through the page player's own caption request flow.
- **FR-002**: The system MUST capture only successful timedtext responses that belong to the current video id and contain parseable caption data.
- **FR-003**: The system MUST parse captured timedtext `json3` responses into structured caption segments with timing and text before forwarding them to promo detection.
- **FR-004**: The system MUST send at most one successful caption payload per video id unless a new video id is detected or a future explicit recapture action is introduced.
- **FR-005**: The system MUST snapshot the user's caption enabled/disabled state before any automated activation.
- **FR-006**: If captions were off before capture, the system MUST hide rendered caption text before triggering automated activation.
- **FR-007**: If captions were off before capture, the system MUST restore captions to off after successful capture or timeout.
- **FR-008**: If captions were on before capture, the system MUST leave captions on after capture and MUST NOT hide captions from the user.
- **FR-009**: If the user changes the caption state during the capture window, the system MUST preserve the user's newer choice rather than restoring the stale snapshot.
- **FR-010**: The system MUST remove any temporary caption-hiding style it adds after capture completion, timeout, navigation away, or cleanup.
- **FR-011**: Caption activation, capture waiting, and cleanup MUST be bounded by explicit retry/timeout policies.
- **FR-012**: The system MUST avoid running automated capture while a YouTube ad is likely active or while no stable watch player is available.
- **FR-013**: The system MUST reset pending capture work, dedupe state, observers, and cleanup state when YouTube single-page navigation changes the current video id.
- **FR-014**: The system MUST fail gracefully when the YouTube player API does not expose the required safe methods.
- **FR-015**: The system MUST surface caption acquisition failures with stage-specific reasons such as player-not-ready, activation-unavailable, capture-timeout, parse-failed, captions-unavailable, or stale-video.
- **FR-016**: The system MUST NOT use direct un-tokened timedtext fetches as a production fallback for caption acquisition.
- **FR-017**: The system MUST NOT use direct InnerTube player client fallbacks or get-transcript fallbacks as production caption acquisition dependencies when they are known to hit bot/sign-in walls.
- **FR-018**: The system MUST NOT use fresh watch-page HTML scraping as a primary production caption acquisition path.
- **FR-019**: Development-only network probes and local logging infrastructure MUST be removed from production runtime flow or guarded so they cannot run in packaged builds.
- **FR-020**: Production diagnostics MUST avoid logging raw caption bodies, full signed timedtext URLs, cookies, API keys, identity tokens, visitor data values, or attestation token values by default.
- **FR-021**: Production diagnostics SHOULD include safe metadata such as stage, current video id, language code, body length, segment count, sanitized URL parameter names, and timeout/failure reason.
- **FR-022**: The content script MUST preserve YouTube page behavior when observing fetch/XHR, including original return values, exceptions, response bodies, request arguments, and event timing.
- **FR-023**: The capture mechanism MUST avoid string evaluation paths that conflict with YouTube Trusted Types or content security policies.
- **FR-024**: The system MUST preserve existing extension boundaries: content handles page/player interaction, background receives validated caption payloads and owns downstream promo detection, popup/options do not directly access caption internals.
- **FR-025**: The feature MUST NOT add a dependency on a local server, remote caption proxy, or additional non-YouTube host permission.
- **FR-026**: The system SHOULD maintain or improve the time from watch-page readiness to caption payload compared with manual caption enabling, with a target of capture completion within 3 seconds after player readiness on a healthy supported video.
- **FR-027**: Existing tests and documentation MUST be updated so obsolete caption-fetch expectations are removed and the player-mediated capture contract is covered.

### Key Entities

- **Target Video**: The current supported YouTube watch-page video identified by the active page's video id.
- **Caption Capture Session**: A bounded per-video attempt to snapshot caption state, optionally activate captions, observe the player request, parse the response, and clean up.
- **Caption State Snapshot**: The user's caption on/off state at the moment TopSkip starts automated capture, plus later evidence of user changes during the capture window.
- **Temporary Caption Hiding Layer**: A page style or equivalent visual suppression mechanism added only when TopSkip temporarily enables captions for a user who had captions off.
- **Captured Timedtext Response**: A YouTube player-produced timedtext response associated with the target video and language, containing caption text in a parseable format.
- **Caption Segment Payload**: Ordered transcript segments containing at minimum start time, duration, and text, passed from content to background for promo detection.
- **Caption Acquisition Failure**: A stage-specific failure object or message that explains why captions were not acquired without implying promo detection completed.
- **Safe Diagnostic Event**: Sanitized metadata useful for debugging caption acquisition without exposing token values, credentials, raw transcript bodies, or unrelated page data.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a supported YouTube watch video with captions initially off, TopSkip captures and forwards non-empty structured caption segments without any required manual caption-button interaction.
- **SC-002**: On the same scenario, rendered captions are not visibly shown to the user during automated activation in a manual visual smoke test.
- **SC-003**: When captions are initially off, the YouTube captions control is restored to off after capture or timeout in 100% of test runs.
- **SC-004**: When captions are initially on, the YouTube captions control remains on after capture in 100% of test runs.
- **SC-005**: If the user manually changes caption state during capture, the final state matches the user's later action in 100% of targeted race-condition tests.
- **SC-006**: A successful capture for a healthy video completes within 3 seconds after player readiness in at least 90% of local manual/e2e runs.
- **SC-007**: Videos without captions, unsupported pages, player API failures, parse failures, and timeouts produce explicit acquisition failure states without sending empty caption segments to promo detection.
- **SC-008**: Production builds do not execute development-only caption probes, local NDJSON logging, or raw network-debug dumping.
- **SC-009**: Automated tests cover caption state snapshot/restoration, duplicate capture suppression, stale video navigation, capture timeout cleanup, parser success/failure, and sanitized diagnostics.
- **SC-010**: Existing lint, build, unit tests, coverage tests for touched modules, and e2e tests pass after obsolete caption fetch paths are removed.
