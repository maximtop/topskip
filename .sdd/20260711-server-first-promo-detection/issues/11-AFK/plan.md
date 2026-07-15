# Implementation Plan: Future hardening and correction hooks

- **Created**: 2026-07-11
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/11-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=11-AFK`, `SPECS_DIR=.sdd/.current`; scope is limited to non-shipping documentation and inert seams

## Summary

Document the boundary between the loopback-only server-first MVP and any future public service. Add one discoverable future-work document that separates production hardening from corrections, identifies the existing analysis-history identity seam, and records the required rollout decisions. Update the existing developer, deployment, and project-documentation entry points so they no longer describe the current server-first work as a serverless product. Do not add endpoints, credentials, public host permissions, correction schemas, correction persistence, or correction UI.

## Technical Context

- **Language/Version**: TypeScript 5.x, strict ESM, Node.js 20+; this issue itself changes Markdown only.
- **Primary Dependencies**: Node `http`, Valibot, React/Mantine, Vitest, and Playwright are already in use; no dependency is required here.
- **Storage**: The backend MVP uses process-local `Map` storage behind `AnalysisArtifactStore`; extension preferences/cache remain background-owned `browser.storage.local` data.
- **Testing**: Vitest 4.x, Playwright E2E, markdownlint through `pnpm run lint:md`.
- **Target Platform**: Chrome MV3 extension and a local Node backend bound to `127.0.0.1:8787`; no public backend deployment is introduced.

## Research

### Current local-service boundary

`src/backend/server.ts:16-22` binds the backend to `127.0.0.1:8787`. `rspack.config.ts:17-18` injects that host permission only for the `dev` build. The server has no authentication boundary, while `src/backend/api-protection.ts:6-11` provides only a process-local fixed-window cold-job limit. These are deliberately suitable for local development, not a public API.

### Existing correction identity seam

`src/backend/analysis-artifact-store.ts:72-116` stores each completed record with `video.videoId`, `video.algorithmVersion`, `recordId`, and a terminal response that can contain `sourceResultId`. `findHistory` preserves history rather than overwriting earlier algorithm versions. `tests/backend/analysis-artifact-store.test.ts:47-75` already proves versioned history is preserved. This is sufficient to document a future correction target as `(videoId, algorithmVersion)` plus `recordId` or `sourceResultId` when a specific analysis result must be selected; no inert TypeScript schema is needed.

### Documentation drift

`DEPLOYMENT.md:3-15` still says the product has no server or backend infrastructure, although the current PRD and source now include the local server-first MVP. `DEVELOPMENT.md` documents extension development but not `pnpm run backend:dev`. `README.md:40-44` is the discoverable project-document index. The changes in this slice must correct those statements without presenting the loopback service as publicly deployable.

## Entities

### Future Correction Proposal (documentation-only)

- **Fields**:
    - `correctionId`: future durable identifier.
    - `videoId`: canonical YouTube video identifier.
    - `algorithmVersion`: version that produced the result being corrected.
    - `recordId` or `sourceResultId`: optional exact artifact/result reference when more than one result exists for the same video/version.
    - `proposedAction` and normalized promo-block payload: future proposed removal, addition, or timing adjustment.
    - `reason`, safe evidence metadata, submitter/trust metadata, moderation state, and timestamps: future workflow data, subject to a dedicated privacy and retention design.
- **Relationships**: A future proposal targets immutable analysis history through `(videoId, algorithmVersion)` and may identify one stored artifact/result; it never changes the extension request contract directly.
- **Validation**: A future implementation must validate canonical IDs, require one target identity, normalize proposed blocks, redact sensitive evidence, and apply abuse controls before accepting submissions.
- **States**: draft/submitted → queued → accepted, rejected, or superseded. These states are design notes only and are not added to MVP runtime code.

### Public Client Trust (documentation-only)

- **Fields**: future issuer, opaque anonymous token identifier, scope, expiration, rotation/revocation metadata, and quota bucket identity.
- **Relationships**: A future edge/API layer evaluates it before public expensive-work admission; it is not a replacement for normal request validation.
- **Validation**: Tokens must be short-lived, scoped, rotatable, and validated server-side. Extension ID/origin remains a defense-in-depth signal rather than user authentication.
- **States**: absent in MVP → issued → active → expired, rotated, revoked, or blocked after public deployment is explicitly approved.

## Contracts

N/A — this issue intentionally adds no HTTP endpoint, runtime message, storage schema, host permission, public URL, token, or correction UI. The existing metadata-only `/v1/analysis` flow and private BYOK no-server-I/O invariant must remain unchanged.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `SERVER_FIRST_FUTURE_WORK.md` | Create | Authoritative non-shipping backlog for public hardening, correction workflow design, rollout gates, and explicit MVP exclusions. |
| `README.md` | Modify | Link the new future-work document from the project-documents index. |
| `DEVELOPMENT.md` | Modify | Document loopback backend startup and link the deferred public-deployment/correction work without treating it as a local prerequisite. |
| `DEPLOYMENT.md` | Modify | Correct the stale serverless wording; distinguish Chrome Web Store packaging, the local-only server-first MVP, and deferred public infrastructure. |

## Tasks

### [x] Task 1: Confirm the existing correction identity seam

**Files:**

- Read: `src/backend/analysis-artifact-store.ts`
- Read: `tests/backend/analysis-artifact-store.test.ts`

- [x] **Step 1: Run the existing identity regression before documentation changes**

Run: `pnpm exec vitest run tests/backend/analysis-artifact-store.test.ts`

Expected: PASS, including the test that saves two records for one video under `server-v1` and `server-v2` and returns both from history.

- [x] **Step 2: Record the stable target identity in the future-work document**

Describe the future correction target as canonical `videoId` plus `algorithmVersion`; explain that `recordId` or `sourceResultId` selects a particular preserved result. State explicitly that this task does not add a correction record, endpoint, runtime message, persistence, or UI.

**Verification**: The documented correction design relies on the existing versioned artifact history and does not create a second or speculative runtime abstraction.

### [x] Task 2: Write the deferred hardening and correction backlog

**Files:**

- Create: `SERVER_FIRST_FUTURE_WORK.md`

- [x] **Step 1: State the MVP boundary and non-goals**

Document that the current backend is loopback-only at `127.0.0.1:8787`, has no public-authentication promise, and uses local request validation plus cost-class-aware in-memory cold-job limiting. List the deliberately absent production features: public edge hostname, Cloudflare/WAF, origin exposure controls, durable client quotas, anonymous issued tokens, correction submission endpoints, and correction UI.

- [x] **Step 2: Add an ordered public-hardening backlog**

Specify separate follow-up work for: edge proxy/WAF and bot/DDoS controls; a private origin reachable only from the edge; durable quota buckets that continue to distinguish cheap cache lookup/job join work from expensive cold-job starts; and optional short-lived, scoped, server-validated anonymous client tokens with issuance, rotation, revocation, and privacy review. Require a production decision before enabling a public backend host or changing release host permissions.

- [x] **Step 3: Add the correction workflow design boundary**

Define the future proposal identity, moderation lifecycle, validation/redaction expectations, and provenance requirements from the Entities section. Require a separate product/security/privacy design before accepting feedback. State that a correction feature must preserve historical algorithm-version context, must not silently mutate stored analyses, and must not affect private BYOK requests or introduce an in-product editor in this MVP.

- [x] **Step 4: Add rollout gates and compatibility constraints**

Require durable storage/queue/retention choices, threat modelling, privacy copy, observability, abuse testing, rollback strategy, and a separate API-contract migration plan before public exposure. Preserve the core extension flow: metadata-only server requests in server mode and zero TopSkip backend analysis/cache/status requests in private BYOK mode.

**Verification**: `SERVER_FIRST_FUTURE_WORK.md` names every deferred item in acceptance criterion 1, associates corrections with video ID plus algorithm version for criterion 2, and labels all future mechanisms as non-shipping for criteria 3 and 4.

### [x] Task 3: Make the boundary discoverable and correct stale deployment guidance

**Files:**

- Modify: `README.md`
- Modify: `DEVELOPMENT.md`
- Modify: `DEPLOYMENT.md`

- [x] **Step 1: Link the future-work document from README**

Add one project-documents list item for `SERVER_FIRST_FUTURE_WORK.md`, described as deferred server hardening and correction design.

- [x] **Step 2: Add local backend guidance to DEVELOPMENT.md**

Add a concise section that documents `pnpm run backend:dev`, the loopback URL `http://127.0.0.1:8787`, and that the host permission is dev-only. Link to `SERVER_FIRST_FUTURE_WORK.md` for public deployment/correction work and state local backend startup is only needed when exercising server-mode development.

- [x] **Step 3: Correct DEPLOYMENT.md without declaring a public service**

Replace the stale no-server assertion with accurate wording: Chrome Web Store packaging remains an extension release concern; server-first development currently uses only a local loopback backend; public hosting is intentionally deferred. Link to the future-work document and retain a clear warning that no public backend origin, token, or edge infrastructure is configured by this MVP.

**Verification**: A maintainer can find the local command and the deferred production/correction plan from the normal documentation entry points, while no document claims that the MVP has a public backend.

### [x] Task 4: Validate documentation-only scope and quality gates

**Files:**

- Verify: `SERVER_FIRST_FUTURE_WORK.md`, `README.md`, `DEVELOPMENT.md`, `DEPLOYMENT.md`

- [x] **Step 1: Check the deferred requirements are documented**

Run: `rg -n "Cloudflare|WAF|origin|quota|anonymous|token|videoId|algorithmVersion|correction|no.*UI|BYOK" SERVER_FIRST_FUTURE_WORK.md`

Expected: Matches demonstrate both production-hardening and correction sections, their explicit MVP exclusions, and the server/BYOK compatibility boundary.

- [x] **Step 2: Check Markdown and repository quality gates**

Run: `pnpm run lint:md && pnpm run lint && pnpm run build && pnpm run test && pnpm run test:coverage && pnpm run test:e2e`

Expected: All commands pass. If a pre-existing unrelated worktree change fails a full-repository gate, record the exact file and failure in the issue validation rather than broadening this documentation-only issue to change unrelated runtime behavior.

**Verification**: The Markdown changes pass repository style checks and no code, contract, UI, or public-infrastructure behavior was introduced.

## Self-Review

| Issue acceptance criterion | Plan coverage |
| --- | --- |
| Future Cloudflare/WAF, private origin, stronger quotas, and optional anonymous client-token work is tracked. | Task 2, steps 1-2; Task 3, step 3. |
| A future correction can associate with video ID and algorithm version. | Task 1; Task 2, step 3. |
| Local MVP remains usable without public edge infrastructure. | Task 2, steps 1 and 4; Task 3, steps 2-3. |
| No correction workflow is exposed to extension users. | Task 1, step 2; Task 2, steps 1 and 3; Task 4. |

No placeholders or deferred implementation directives remain in the plan. Runtime behavior is intentionally unchanged, so this docs-only slice does not introduce a failing test or new code-level test; Task 1 runs the existing version-history regression and Task 4 runs the complete project gates.
