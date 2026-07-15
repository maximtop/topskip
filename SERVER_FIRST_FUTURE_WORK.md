# Server-first future work

This document records work that remains outside the public server-first
release. The production architecture and operating procedure now live in
[DEPLOYMENT.md](./DEPLOYMENT.md); this file is only a product backlog for the
future correction workflow.

## MVP boundary and exclusions

Server mode supports both a loopback development backend and the public
`topskip.maximtop.dev` backend. The public path uses anonymous installation
tokens, durable quotas and budgets, SQLite artifacts, a constrained container,
and a Cloudflare Tunnel. The Chrome extension still has no
correction-submission endpoint or in-product correction UI.

Private BYOK remains separate: it must make zero TopSkip backend analysis,
cache, or status requests. Server mode continues to send metadata-only
analysis requests; it does not send raw captions by default.

## Public-hardening milestone

The public-hardening design was approved on 2026-07-15 and is tracked by
`.sdd/20260715-public-topskip-backend/`. It covers:

1. An origin-hiding Cloudflare Tunnel with backend-enforced abuse controls.
2. Loopback-only container exposure, immutable deployments, health checks, and
   rollback.
3. Durable installation/IP quotas that exempt cache hits and joined jobs from
   cold-work limits.
4. Opaque 90-day anonymous installation tokens stored as SHA-256 hashes.
5. Explicit retention, privacy, observability, budget, and API-versioning
   policies.

## Future correction workflow

A future correction proposal targets immutable analysis history with canonical
`videoId` and `algorithmVersion`. When several results exist for that pair,
`recordId` or `sourceResultId` selects the specific artifact or delivered
result. A proposal must not silently mutate prior analyses or lose the
algorithm-version context needed to investigate a result.

The future proposal record should contain a durable `correctionId`, target
identity, proposed action and normalized promo-block payload, reason, safe
evidence metadata, submitter and trust metadata, moderation state, and
timestamps. Its expected lifecycle is draft or submitted, then queued, and
finally accepted, rejected, or superseded.

Before accepting corrections, design a separate product, security, and privacy
workflow that validates canonical IDs and requires a target identity,
normalizes proposed blocks, redacts sensitive evidence, applies abuse controls,
defines retention, and records provenance and moderation decisions. This MVP
does not add correction records, persistence, runtime messages, endpoints, or
an in-product editor. It also does not change private BYOK behavior.

## Compatibility constraints

Future work must preserve the core modes:

- Server mode uses metadata-only requests and may use shared backend caching.
- Private BYOK makes zero TopSkip backend analysis, cache, and status requests.
- Local development remains possible without the public edge or correction
  workflow.
