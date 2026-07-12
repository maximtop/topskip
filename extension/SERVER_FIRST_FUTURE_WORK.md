# Server-first future work

This document records work deliberately deferred from the loopback-only
server-first MVP. It is a design backlog, not a public-service deployment
plan. The current backend binds to `127.0.0.1:8787`, provides no
public-authentication promise, validates local requests, and applies an
in-memory, cost-class-aware limit to cold analysis starts.

## MVP boundary and exclusions

The MVP supports local server-mode development only. It has no public edge
hostname, Cloudflare or WAF deployment, origin-access controls, durable client
quotas, anonymous issued client tokens, correction-submission endpoint, or
in-product correction UI. Do not enable a public backend host or add production
host permissions until the public-hardening work below has been approved.

Private BYOK remains separate: it must make zero TopSkip backend analysis,
cache, or status requests. Server mode continues to send metadata-only
analysis requests; it does not send raw captions by default.

## Public-hardening backlog

Complete these items as separate, security-reviewed delivery work before any
public backend deployment:

1. Place a public API behind an edge proxy with Cloudflare or an equivalent WAF,
   including bot and DDoS controls appropriate for expensive analysis work.
2. Keep the application origin private and reachable only from the edge. Define
   network controls, deployment credentials, health checks, and incident
   response so origin IP addresses are not exposed to clients.
3. Replace in-memory local limits with durable quota buckets. Quotas must keep
   cheap cache lookups and job joins distinct from expensive cold-job starts,
   and must define operational limits, observability, and appeal handling.
4. Evaluate optional anonymous issued client tokens. If adopted, tokens must be
   opaque, short-lived, scoped, rotatable, revocable, and validated server-side.
   Token issuance, privacy effects, and abuse resistance require dedicated
   review. Extension ID and origin signals remain defense in depth, not user
   authentication.
5. Make an explicit production decision before exposing a public host or
   changing release host permissions. That decision needs threat modelling,
   durable storage and queue choices, retention rules, privacy copy,
   observability, abuse testing, a rollback strategy, and an API-contract
   migration plan.

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

Before accepting feedback, design a separate product, security, and privacy
workflow that validates canonical IDs and requires a target identity,
normalizes proposed blocks, redacts sensitive evidence, applies abuse controls,
defines retention, and records provenance and moderation decisions. This MVP
does not add correction records, persistence, runtime messages, endpoints, or
an in-product editor. It also does not change private BYOK behavior.

## Compatibility constraints

Future work must preserve the core modes:

- Server mode uses metadata-only requests and may use shared backend caching.
- Private BYOK makes zero TopSkip backend analysis, cache, and status requests.
- Local development remains possible without a public edge, token issuer, WAF,
  or correction workflow.
