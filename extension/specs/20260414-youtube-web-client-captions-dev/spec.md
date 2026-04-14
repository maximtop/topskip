# Feature Specification: YouTube web-client captions (developer / analysis)

**Created**: 2026-04-12
**Status**: Validated
**Model**: Auto (agent-authored)
**Implemented by**: Auto (sdd-implement)
**Validated by**: Auto (sdd-validate)
**SDD Version**: v2.0.2-2-gdf44b20
**Input**: User description: "Primary: captions via web-client-style integration; **developers** get transcript from the **MV3 service worker** for inspection and **later analysis**. **Reliability disclaimer** for end users is **not** the main deliverable and **may be postponed**."

## Assumptions

- **Assumption — primary scope**: The **must-have** for this specification is **caption retrieval** using **web-client-style** integration and **developer-visible output from the background** (service worker). **User-facing reliability disclaimer** copy and **post-install onboarding** around that disclaimer are **secondary** and **may be implemented in a later milestone** without blocking caption work.
- **Assumption — placement (captions, developers)**: The **primary consumer** of fetched caption text in the current phase is **development and future analysis**. **“Print in the background”** means emitting transcript data from the **Manifest V3 service worker** via **developer-visible channels**—typically **service worker console** when inspecting the extension in `chrome://extensions`, and/or **structured data** for later pipelines—not rendering HTML in the service worker (which has no DOM).
- **Assumption — analysis (later)**: **Downstream analysis** (ML, batch jobs, exports) is **out of scope** beyond requiring caption data in **structured form** (segments with time and text) suitable to **pipe** into analysis later; storage format and tooling are **implementation details**.
- **Assumption — caption source**: **Caption/transcript text** is obtained using the same **non-documented, web-client-style** mechanisms the YouTube site uses internally to list and download caption tracks (conceptually similar to popular open-source tools such as youtube-transcript-api), **not** as the sole reliance on the official YouTube Data API “captions” resource for arbitrary third-party download.
- **Assumption — which video**: Caption fetch targets the **current video** on the **YouTube watch page**—the video the user is actually viewing in the active watch tab / player. The **video identity** is derived from that **watch context** (typically via the content script or equivalent page-bound logic messaging the background). Arbitrary video IDs, fixed sample IDs, or manual entry are **out of scope** for this specification unless explicitly added later.
- **Assumption — disclaimer (when implemented)**: If and when a **reliability disclaimer** ships, it applies to **any** behavior that depends on YouTube’s non-public web-client behavior, **including** caption retrieval; copy MUST stay **accurate** for that build.

## User Scenarios & Testing

### User Story 1 - Fetch captions and expose them from the background for developers (Priority: P1)

As a **developer** working on TopSkip, I want the extension to **retrieve** captions using **web-client-style** integration and **print or emit** that transcript from the **MV3 service worker** (background) so I can **inspect** it in the service worker console (or equivalent) and **reuse the same data later for analysis** without requiring a user-facing HTML page first.

**Why this priority**: Core deliverable for integration validation and analysis prep.

**Independent Test**: On a YouTube **watch** page for a video that has captions, trigger the caption fetch path; open the extension service worker logs; transcript content (or clear structured segments) appears there, or is otherwise available in a developer-inspectable way defined by implementation.

**Acceptance Scenarios**:

1. **Given** the user is on a watch page for a video that has captions, **When** the fetch runs for that **current** video, **Then** transcript data is obtained via the **web-client-style** caption track path for **that** video’s identity.
2. **Given** fetch succeeds, **When** a developer inspects the **service worker** / background context, **Then** caption content is **visible or recoverable** there (e.g. console output, structured log, or stored payload)—not only inside a content script with no background handoff.
3. **Given** fetch fails, **When** the developer inspects the background context, **Then** a **clear failure indication** appears (not silent failure).

---

### User Story 2 - Optional: show transcript on an extension HTML page (Priority: P2)

As a **non-developer** or reviewer, I might later want to **read** captions in a normal extension page without opening service worker logs.

**Why this priority**: Demos and accessibility; not required for the developer milestone.

**Independent Test**: If implemented, open the extension page; transcript text is readable when fetch succeeds.

**Acceptance Scenarios**:

1. **Given** this surface is implemented and fetch succeeds, **When** the user opens the page, **Then** caption text is visible or a clear empty/error state is shown.

---

### User Story 3 - Reliability disclaimer on first-run (Priority: P3 — deferred)

As someone who installs TopSkip, I might later want a **reliability disclaimer** on the post-install page explaining that YouTube integration may break if YouTube changes their site.

**Why this priority**: Good for end-user expectations, but **not** required to ship caption retrieval; **may be postponed**.

**Independent Test** (when implemented): Install or simulate first-run; the disclaimer appears on the post-install page.

**Acceptance Scenarios** (when implemented):

1. **Given** first-run completes, **When** the post-install page is shown, **Then** the user sees a readable warning about undocumented web-client behavior and possible breakage.
2. **Given** the post-install page is visible, **Then** the user is invited to report issues via a valid channel.

---

### User Story 4 - Reduce clutter after disclaimer ships (Priority: P3 — deferred)

As a returning user, I want the full disclaimer not to dominate everyday use **after** first-run—**only relevant when User Story 3 exists**.

**Independent Test**: After first-run, frequent surfaces (e.g. popup) are not dominated by the long disclaimer unless intentional.

---

### Edge Cases

- **Not on a watch page** or **no video identity** (e.g. home, Shorts-only, or embedded player without watch URL): The system MUST **not** fetch random captions; it MUST **fail clearly** in the developer path or no-op per product rules.
- **Long transcripts**: Prefer **structured segments**, **chunked logs**, or **storage** over a single unusable dump.
- **Service worker lifetime**: MV3 workers **sleep**; later analysis may need **persistent storage** or **offload**—implementation detail.
- **YouTube blocks web-client caption flow**: Failure is **visible to the developer** in the background path; if a user-facing page exists, explain there too.
- **Deferred disclaimer**: If the disclaimer is **not** shipped, **no** requirement applies to post-install copy for this spec phase.

## Requirements

### Functional Requirements — Caption retrieval (P1)

- **FR-001**: The system MUST obtain transcript data using **web-client-style** access to YouTube caption tracks (the same **class** of undocumented integration as third-party transcript tools), and MUST **not** misrepresent that as a Google-supported public API.
- **FR-002**: The system MUST fetch captions for the **current** YouTube **watch**-page video only—the video the user is viewing—using **video identity** supplied from that watch context (e.g. content script → background). It MUST **not** substitute an unrelated video ID.
- **FR-003**: The system MUST make fetched caption data **available from the MV3 service worker (background)** in a **developer-inspectable** way (e.g. logging structured segments to the service worker console, or equivalent), so transcripts can be **seen during development** and **fed into later analysis** without requiring an HTML page as the only sink.
- **FR-004**: The system SHOULD represent captions as **structured segments** (at minimum **text** and **time alignment** sufficient for downstream analysis), not only as an opaque blob, when feasible.
- **FR-005**: When caption fetch fails, the **background** path MUST surface a **clear error** to developers (not fail silently).
- **FR-006**: **MAY**: Render transcript text on an **extension HTML page** for non-developer reading; if absent, **FR-003** still satisfies this spec phase.

### Functional Requirements — Reliability disclaimer (deferred — P3)

The following apply **only when** the team chooses to ship the disclaimer; they **do not** block caption work.

- **FR-D01**: **SHOULD** (when implemented): Show a **visible reliability disclaimer** on the **post-install (first-run) page** when the product depends on undocumented YouTube web-client behavior.
- **FR-D02**: **SHOULD** (when implemented): The disclaimer states that the **undocumented integration is not guaranteed** to keep working if YouTube changes behavior.
- **FR-D03**: **SHOULD** (when implemented): Invite users to report problems using a **valid** project channel.
- **FR-D04**: **SHOULD** (when implemented): Do **not** claim a **specific repair deadline** unless the project commits to one.
- **FR-D05**: **SHOULD** (when implemented): Keep the post-install page **usable** (primary actions reachable without excessive friction).
- **FR-D06**: **MAY** (when implemented): Offer a **compact** disclaimer on frequent surfaces (e.g. popup) after first-run.

### Key Entities

- **Caption segments**: Ordered pieces of transcript with timing (and optional metadata) suitable for logging, storage, and later analysis.
- **Developer transcript sink**: Where background output goes first (e.g. service worker console, `storage`, or messages)—chosen per implementation.
- **Target video**: The **current** video on the active YouTube **watch** page (the one the user is watching when the fetch runs).
- **Reliability disclaimer** (deferred): User-facing text on first-run and optionally elsewhere—**only when** that milestone is scheduled.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a **watch** page for a video **with known captions**, after a successful fetch for that **current** video, a developer can **confirm** transcript substance from the **background / service worker** path (spot-check: key phrases present in logs or structured output).
- **SC-002**: Failed fetches produce a **discernible error** in the background developer path (binary pass/fail).
- **SC-D01** (when disclaimer ships): First-run shows the full disclaimer without hiding the primary action on a standard viewport.
- **SC-D02** (when disclaimer ships): No **dead** support link in the disclaimer for that build.
