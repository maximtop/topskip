# Validation Report: Public TopSkip Backend

**Validated**: 2026-07-16
**Status**: Partial — implementation and production runtime pass; rollout gates
remain open.

## Verdict

The `/v1` implementation, public container, persistence, Tunnel route, paid
analysis path, immutable deployment, and automatic rollback satisfy the feature
specification. The feature remains **In Progress** until the Cloudflare edge
rate rule is created and the 48-hour beta window completes.

## Automated evidence

- GitHub Actions CI run
  [29484353312](https://github.com/maximtop/topskip/actions/runs/29484353312)
  passed on commit `1061797`: format/lint/typecheck, build, deployment assets,
  constrained container smoke, 739 unit tests, coverage, 14 Playwright E2E
  tests, and the release packaging boundary.
- Contract coverage includes ignored legacy `algorithmVersion`, server-owned
  versions, bounded Chrome SemVer, unknown capability tolerance, typed-error
  negotiation, installation ownership, token renewal, cache invalidation, and
  v1 compatibility.
- Pipeline coverage proves no Gemini call for malformed requests, unavailable
  videos/captions, and every duration/segment/transcript/subtitle limit,
  including the `18_000`/`18_000.001` boundary.
- Deployment regression tests prove malformed `production.env` and Compose
  parser failures cannot expose a fake secret marker through SSH/Actions.

## Production evidence

- Protected production deployment run
  [29485063450](https://github.com/maximtop/topskip/actions/runs/29485063450)
  completed successfully after manual environment approval.
- Public and loopback health return exactly `{ "ok": true }`; `/v1/config`
  reports API 1, algorithm `server-v4`, typed server errors, and the validated
  GitHub support URL.
- DNS uses the proxied Tunnel CNAME, Docker publishes only
  `127.0.0.1:18787`, the external port is closed, and direct-IP requests do not
  serve the TopSkip origin.
- The runtime is non-root and read-only with 1 CPU, 1 GiB memory, 128 pids,
  bounded `/tmp`, dropped capabilities, persistent SQLite, Node.js 24, and the
  verified pinned yt-dlp release. SQLite survived container restarts and the
  additive failure-version migration preserved existing records.
- `cloudflared-topskip` runs separately from Caddy with no unexpected restarts;
  the hardened unit receives an `OK` result from `systemd-analyze security`.
  Existing KojaKurtki/Caddy services and root SSH policy were not changed.
- A public cold analysis completed through yt-dlp and one Gemini request using
  `google/gemini-3.5-flash`; it reached `no_promo` without downloading media.
  The run used 1,835 input tokens, 65 output tokens, and USD 0.0033375.
- A deliberately unhealthy candidate emitted Docker
  `health_status: unhealthy`; the deploy script automatically restored the
  current digest. Compose checksum, image state, other containers, loopback
  health, and public health all remained correct after the drill.

## Open rollout gates

1. Create and verify the single Cloudflare Free-plan rule for
   `/v1/analysis*`: 30 requests per 10 seconds per IP, blocked for 10 seconds.
   The dashboard currently requires an operator sign-in and 2FA.
2. Complete the beta window ending after `2026-07-18T08:58:07Z`. Automation
   `[TopSkip] 48-hour beta monitor` performs 48 hourly safe checks of health,
   failure-code aggregates, queue pressure, yt-dlp failures, Gemini spend, and
   budget headroom.
3. Reload the beta extension in Chrome and perform the final public-endpoint
   popup/polling/seek smoke. Automated extension E2E coverage is already green.

Do not change the feature status to **Validated** or check Tasks 4.4/5.3 until
all three rollout gates are recorded as successful.
