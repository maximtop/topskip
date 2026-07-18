# TopSkip

Chrome extension that **skips detected sponsor/promo blocks** on YouTube watch
pages. **Server** mode is the default: beta and release builds use the public
TopSkip backend, while development builds use the loopback backend. The server
receives timed captions captured through the YouTube player, analyzes them with
Gemini through OpenRouter, and reuses cached results. **Private BYOK** is an
explicit opt-in for users who prefer their own provider and want zero TopSkip
analysis or registration requests. There is no fixed 30s→60s skip window.

## Requirements

- **Node.js** 22+
- **pnpm** (see `package.json` → `packageManager`; [install pnpm](https://pnpm.io/installation))
- **Chrome** (Chromium) for loading the unpacked extension
- **OpenRouter API key** only when running the backend locally

## Quick start

```bash
make setup    # installs pnpm dependencies
make build    # or: pnpm run build
cp .env.example .env
```

Set `OPENROUTER_API_KEY` in the root `.env`, then start the development backend
in a separate terminal with `make server`. The command exits before listening
if the key is missing or blank. Public beta/release builds do not require a
user-supplied server key.

Load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist/` (after `make build`)

## Commands

| Command                | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `make setup`           | Install dependencies                                      |
| `make yt-dlp-install`  | Install pinned `yt-dlp` for explicit legacy mode only     |
| `make build`           | Development extension build into `extension/dist/`        |
| `make server`          | Run the local backend; requires `OPENROUTER_API_KEY`      |
| `make extension`       | Watch and rebuild the extension continuously              |
| `make lint`            | Oxfmt + oxlint + ESLint + markdownlint + TypeScript       |
| `make test`            | Coverage, deployment assets, then Playwright E2E          |
| `make test-unit`       | Vitest unit tests only (no coverage)                      |
| `make test-coverage`   | Vitest with coverage thresholds                           |
| `make test-deployment` | Deployment security, Compose, and server bundle checks    |
| `make test-container`  | Production image security and SQLite persistence smoke    |
| `make test-e2e`        | Playwright only (headless; extension + local fixture MP4) |

## Server analysis

On an enabled YouTube watch page, the content script captures the player's
timed captions, then asks the background service worker to submit them to the
configured TopSkip backend. Development builds use
`http://127.0.0.1:8787`; beta/release builds use
`https://topskip.maximtop.dev`. This **extension upload** is the default local
and production source; the new image does not contain or invoke `yt-dlp`. The
backend sends the validated timed transcript to the fixed
`google/gemini-3.5-flash` model through OpenRouter with high reasoning effort,
and returns validated promo intervals. The content script skips future blocks
at their returned end times, while the popup displays the same intervals.

All TopSkip HTTP, authentication, exact-result caching, polling, and support
URL handling belong to the background service worker. The content script only
sends validated runtime messages. The retained `legacy_yt_dlp` source is an
explicit rollback/debug mode and requires `make yt-dlp-install`; it is never an
automatic fallback.

Server mode lazily registers an anonymous 90-day installation credential in
background-owned extension storage. `/v1/config` supplies the active
server-owned algorithm version and support URL, so backend releases do not
require matching extension releases. Successful promo and no-promo results
remain fresh for 30 days. The backend stores state in SQLite, and the extension
mirrors ready results in its own versioned cache. The server API key stays in
the backend process; it is not bundled with or returned to the extension.
OpenRouter does receive the timed transcript needed for model analysis.
Validated transcripts and bounded assistant output may be retained for up to
30 days under access control and pruning; do not paste them into GitHub issues.
The stable `/v1` wire contract is defined by Valibot schemas and their inferred
types in `common/src/server-analysis-contract.ts`.

## Documentation

The repository is a pnpm workspace with three explicit packages:

- `backend/` — local HTTP API, extraction, analysis, and artifact storage
- `extension/` — Chrome MV3 background/content/UI bundles and E2E tests
- `common/` — pure contracts, schemas, and types shared by both runtimes

- [DEVELOPMENT.md](./DEVELOPMENT.md) — architecture and local testing
- [extension/DEPLOYMENT.md](./extension/DEPLOYMENT.md) — packaging and Chrome Web Store notes
- [DEPLOYMENT.md](./DEPLOYMENT.md) — public backend provisioning, deploy, and rollback runbook
- [.sdd/](./.sdd/) — dated feature specifications and implementation decisions
- [SERVER_FIRST_FUTURE_WORK.md](./SERVER_FIRST_FUTURE_WORK.md) — deferred
  correction-workflow design
- [AGENTS.md](./AGENTS.md) — notes for AI-assisted changes

## License

Private / unlicensed unless you add a `LICENSE` file.
