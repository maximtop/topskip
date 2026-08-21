# TopSkip

Chrome extension that **skips detected sponsor/promo blocks** on YouTube watch
pages. **Server** mode is the default: every build profile talks to the same
public TopSkip backend, including development builds. The server
receives timed captions captured through the YouTube player, analyzes them with
DeepSeek V4 Flash through OpenRouter, and reuses cached results. **Private BYOK** is an
explicit opt-in for users who prefer their own provider and want zero TopSkip
analysis or registration requests. There is no fixed 30s→60s skip window.

## Requirements

- **Node.js** 22+
- **pnpm** (see `package.json` → `packageManager`; [install pnpm](https://pnpm.io/installation))
- **Chrome 111+** (or a compatible Chromium build) for loading the unpacked
  extension
- **OpenRouter API key** only when running the backend locally

## Quick start

```bash
make setup
cp .env.example .env
# Set TOPSKIP_SERVER_ORIGIN, then:
make build
```

Set `OPENROUTER_API_KEY` in the root `.env` before starting the development
backend in a separate terminal with `make server`. To connect the dev extension
to that local process, set
`TOPSKIP_SERVER_ORIGIN=http://127.0.0.1:8787` before building. The backend
command exits before listening if its key is missing or blank. Public
beta/release extension builds do not require a user-supplied provider key.

Load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist/` (after `make build`)

After installing, updating, or manually reloading TopSkip, reload YouTube tabs
that were already open. A normal Manifest V3 service-worker sleep/restart does
not require a tab reload while that tab's content context remains alive.

## Commands

| Command                | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `make setup`           | Install dependencies                                      |
| `make yt-dlp-install`  | Install pinned `yt-dlp` for explicit legacy mode only     |
| `make build`           | Development extension build into `extension/dist/`        |
| `make server`          | Run the local backend; requires `OPENROUTER_API_KEY`      |
| `make extension`       | Watch and rebuild the extension continuously              |
| `make lint`            | ESLint (lint + format) + markdownlint + TypeScript         |
| `make test`            | Coverage, deployment assets, then Playwright E2E          |
| `make test-unit`       | Vitest unit tests only (no coverage)                      |
| `make test-coverage`   | Vitest with coverage thresholds                           |
| `make test-deployment` | Deployment security, Compose, and server bundle checks    |
| `make test-container`  | Production image security and SQLite persistence smoke    |
| `make test-e2e`        | Playwright only (headless; extension + local fixture MP4) |
| `pnpm run validate:extension-manifest -- …` | Validate an emitted manifest against its build profile |
| `pnpm benchmark:promo` | Run or resume the tracked paid-promo model benchmark      |

## Server analysis

On an enabled YouTube watch page, the content script captures the player's
timed captions, then asks the background service worker to submit them to the
configured TopSkip backend. `TOPSKIP_SERVER_ORIGIN` is compiled in at build
time. Beta and release require a public-looking HTTPS DNS origin; development
also permits exactly `http://127.0.0.1:8787` for local integration.
This **extension upload** is the default local and production source; the new
image does not contain or invoke `yt-dlp`. The backend sends the validated
timed transcript to the fixed
`deepseek/deepseek-v4-flash` model through OpenRouter with model-default
reasoning, and returns validated promo intervals. The content script skips future blocks
at their returned end times, while the popup displays the same intervals.

All TopSkip HTTP, authentication, exact-result caching, polling, and support
URL handling belong to the background service worker. The content script only
sends validated runtime messages. The retained `legacy_yt_dlp` source is an
explicit rollback/debug mode and requires `make yt-dlp-install`; it is never an
automatic fallback.

## Extension permissions and Private BYOK

TopSkip installs with one required extension API permission: **`storage`**.
Its only required host permission is the configured TopSkip backend used by
Server mode. YouTube access appears as two declarative content-script matches,
not as a separate required host permission. Development builds add only the
`http://127.0.0.1:4173/*` E2E fixture match; beta and release builds do not.

OpenRouter (`https://openrouter.ai/*`) and OpenAI
(`https://api.openai.com/*`) are optional host permissions. TopSkip asks for
one only after an explicit Private BYOK action such as **Allow access** or
**Test connection** for that provider. Saving an API key and granting host
access are separate: revoking access leaves the saved key in extension storage
but prevents provider requests until access is granted again. Server mode
never requests either provider grant; its model traffic is sent by the TopSkip
backend, not by the extension.

All extension-originated TopSkip and Private BYOK network requests are owned by
the background service worker. Popup, options, content, and the page bridge do
not fetch those services directly.

Chrome 111 is the minimum supported version because TopSkip declares its
MAIN-world caption bridge statically at `document_start`. The bridge's
fetch/XHR wrappers remain dormant outside an active caption capture. The
ISOLATED content context also remains inert while preferences are missing or
TopSkip is disabled: it does not bind playback, seek, capture captions, or
start analysis.

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
- `.sdd/` — dated feature specifications and implementation decisions; kept
  locally and **not published**, so it is absent from a fresh clone
- [TODO.md](./TODO.md) — backlog, including the deferred correction workflow
- [Promo benchmark](./benchmarks/promo-detection/README.md) — corpus, harness,
  model matrix, and reproducible results
- [AGENTS.md](./AGENTS.md) — notes for AI-assisted changes

## License

Private / unlicensed unless you add a `LICENSE` file.
