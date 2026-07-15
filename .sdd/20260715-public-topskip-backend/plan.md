# Implementation Plan: Public TopSkip Backend

**Created**: 2026-07-15
**Status**: In Progress
**Input**: `spec.md` and the user-approved deployment plan.

## Phase 1: Contracts and compatibility

- [x] **Task 1.1**: Add installation, config, typed-error, and capability
  contracts with bounded validation and backward-compatible v1 parsing.
- [x] **Task 1.2**: Make algorithm version server-owned, remove client equality
  gating, and preserve legacy request acceptance.
- [x] **Task 1.3**: Add contract and cache-version transition tests.

## Phase 2: Public backend protection and persistence

- [x] **Task 2.1**: Add SQLite migrations/repositories for installations,
  usage/budget buckets, artifacts, and failure events.
- [x] **Task 2.2**: Add bearer authentication and same-installation job
  ownership to HTTP routes.
- [x] **Task 2.3**: Add installation/IP quotas, global concurrency/queue limits,
  and atomic model-budget reservation/reconciliation.
- [x] **Task 2.4**: Enforce five-hour, segment, transcript, and subtitle-response
  limits before Gemini with stable safe errors.
- [x] **Task 2.5**: Add backend contract, persistence, quota, budget, ownership,
  and zero-Gemini-on-rejection tests.

## Phase 3: Extension integration and user feedback

- [x] **Task 3.1**: Select localhost for dev and the public hostname for
  beta/release, with exact manifest host permissions.
- [x] **Task 3.2**: Add lazy background-owned installation token lifecycle and
  `/v1/config` refresh/cache invalidation.
- [x] **Task 3.3**: Map typed failures to safe runtime state and localized popup
  categories without rendering backend messages.
- [x] **Task 3.4**: Add background-owned safe GitHub issue URL construction and
  popup report actions.
- [x] **Task 3.5**: Verify BYOK isolation, retries, compatibility, cache, locales,
  and report privacy with unit/e2e tests.

## Phase 4: Production packaging and deployment

- [x] **Task 4.1**: Add a pinned multi-stage production image and constrained
  loopback-only Compose service with SQLite persistence and healthcheck.
- [x] **Task 4.2**: Add root-owned deploy/rollback/forced-command scripts and a
  manual immutable-digest GitHub Actions workflow.
- [x] **Task 4.3**: Document one-time VPS, Cloudflare Tunnel/DNS/rate-rule,
  secrets, operations, rollback, pruning, and yt-dlp update procedures.
- [ ] **Task 4.4**: Provision using `kojakurtki-vps` without enabling root SSH or
  changing KojaKurtki/Caddy, then configure the tunnel and protected Actions
  environment.

## Phase 5: Verification and rollout

- [x] **Task 5.1**: Run format, lint, typecheck, unit/coverage, build, and
  Playwright suites.
- [ ] **Task 5.2**: Validate image security, persistence, health, loopback
  exposure, deploy, and rollback locally/on VPS.
- [ ] **Task 5.3**: Run real VPS yt-dlp and one paid Gemini smoke through the
  public hostname, then record beta rollout checks.

## Verification Commands

```bash
pnpm run format
pnpm run lint
pnpm run build
pnpm run test
pnpm run test:coverage
pnpm run test:deployment
pnpm run test:container
pnpm run test:e2e
docker compose -f deploy/compose.production.yml config
```

## Implementation Notes

- Existing workspace changes predate this feature and must be preserved.
- Infrastructure mutation follows local verification. External prerequisites
  that cannot be created non-interactively are reported as rollout blockers,
  not silently approximated.
