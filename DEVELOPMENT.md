# Development guide

This document explains how to set up the TopSkip workspace, run the local
backend and extension, and debug their integration. For **shipping to the
Chrome Web Store**, see
[extension/DEPLOYMENT.md](./extension/DEPLOYMENT.md). For **code conventions
and architecture**, see [AGENTS.md](./AGENTS.md). For a short **overview**, see
[README.md](./README.md).

## Table of contents

- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
    - [1. Clone and install dependencies](#1-clone-and-install-dependencies)
    - [2. Build the extension](#2-build-the-extension)
    - [3. Load the extension in Chrome](#3-load-the-extension-in-chrome)
    - [4. Watch mode (optional)](#4-watch-mode-optional)
    - [5. Local backend process (optional)](#5-local-backend-process-optional)
    - [Server-owned DeepSeek analysis](#server-owned-deepseek-analysis)
    - [Build profiles and public API](#build-profiles-and-public-api)
    - [Permissions and static content lifecycle](#permissions-and-static-content-lifecycle)
    - [Server-analysis dev logs](#server-analysis-dev-logs)
    - [MV3 worker suspension and recovery](#mv3-worker-suspension-and-recovery)
- [Project layout](#project-layout)
    - [Preferences and `browser.storage.local`](#preferences-and-browserstoragelocal)
- [Commands reference](#commands-reference)
    - [Makefile targets](#makefile-targets)
    - [pnpm scripts](#pnpm-scripts)
    - [Maintainer: compare preset models on one transcript](#maintainer-compare-preset-models-on-one-transcript)
    - [First-time Playwright browsers](#first-time-playwright-browsers)
- [Development workflow](#development-workflow)
- [Testing](#testing)
    - [Unit tests (Vitest)](#unit-tests-vitest)
    - [Manual server-mode check](#manual-server-mode-check)
    - [Manual caption-capture smoke test](#manual-caption-capture-smoke-test)
    - [Developer: player-mediated caption capture](#developer-player-mediated-caption-capture)
    - [End-to-end (Playwright)](#end-to-end-playwright)
- [Debug logging (user-facing)](#debug-logging-user-facing)
    - [Four-step script](#four-step-script)
    - [Manual checks](#manual-checks)
- [Dev log server (cross-context console)](#dev-log-server-cross-context-console)
    - [Files](#files)
    - [Usage](#usage)
    - [Why not `console.log`?](#why-not-consolelog)
- [Common tasks](#common-tasks)
- [Troubleshooting](#troubleshooting)
- [Additional resources](#additional-resources)

---

## Prerequisites

| Tool                            | Version / notes                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| **Node.js**                     | **22.x or newer** (`package.json` → `"engines": { "node": ">=22" }`)                          |
| **pnpm**                        | Package manager (`packageManager` in `package.json`; [install](https://pnpm.io/installation)) |
| **Git**                         | For cloning and version control                                                               |
| **Google Chrome 111+** (or Chromium) | Required for static MAIN-world content scripts and loading `extension/dist/` unpacked |

Optional:

| Tool         | When                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **GNU Make** | Optional convenience; all `make` targets call `pnpm run` (see [Makefile](./Makefile)) |

Extension-only and Private BYOK development do not require a root `.env`.
Running the development backend requires `OPENROUTER_API_KEY` in the root
`.env` or process environment. Preferences use `browser.storage.local`. The
backend retains installations, quotas, budgets, artifacts, and safe failure
events in `.topskip-data/topskip.sqlite` for local development. Production uses
the persistent SQLite volume documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Getting started

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd topskip
make setup
```

Equivalent:

```bash
pnpm install
```

Use **`pnpm install --frozen-lockfile`** when you need a clean, lockfile-only install (e.g. matching CI).

### 2. Build the extension

```bash
make build
```

Equivalent:

```bash
pnpm run build
```

Output goes to **`extension/dist/`** (Rspack: `background.js`, `content.js`, `popup.js`,
`options.js`, the caption-page bridge, HTML entry files, `manifest.json`, and
source maps).

### 3. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Choose **`extension/dist/`** (not the repository root)

After code changes, run a fresh `make build` and click **Reload** on the
extension card. Installing, updating, or manually reloading the extension
invalidates content contexts in already-open documents, so reload those
YouTube tabs as well, or simply open the TopSkip popup on them. The orphaned
scripts notice the severed runtime within about a second and neutralize
themselves (video listeners and timers released, the MAIN bridge's `fetch`/XHR
wrappers restored); opening the popup on such a tab then re-injects the current
bundles through `scripting` + `activeTab`, so skipping resumes without a page
reload. Service-worker sleep/restart alone does not require either while the
existing content context is still alive.

### 4. Watch mode (optional)

Rebuild on file changes:

```bash
make extension
```

Equivalent: `pnpm run build:watch`.

### 5. Local backend process (optional)

Run the loopback backend for direct backend development and API testing:

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env, then:
make server
```

The root `.env` is gitignored. An exported `OPENROUTER_API_KEY` takes precedence
over the file. `make server` validates required configuration before binding
the HTTP listener and exits with a safe configuration error when the key is
missing or blank. The default extension upload source (`extension_upload`)
neither installs nor requires `yt-dlp`.

It listens on `http://127.0.0.1:8787`. A development extension may target that
process only when `TOPSKIP_SERVER_ORIGIN` is exactly that bare origin. Beta and
release builds reject it and require a public-looking HTTPS DNS origin. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for the production route and operations.

On a YouTube `/watch?v=…` page, Server mode starts with **caption acquisition**
after the content script has loaded preferences and found both the video ID and
the main `<video>` element. Playback does not need to start. The content script
captures the player-selected timed captions, canonicalizes them, and sends a
validated runtime message to the background service worker. Only the background
computes the exact transcript identity, checks its local cache, authenticates,
submits captions to TopSkip, and polls the job. A fresh exact cache hit produces
no analysis HTTP request.

The background lazily registers a random anonymous installation token when
Server mode first needs the backend. The token never crosses into popup or
content code. It refreshes `/v1/config` at most once per hour, accepts the
server-owned algorithm version, and removes local ready-cache entries from
other algorithms. If config is temporarily unreachable, an unexpired cached
result may still be used. Private BYOK returns before registration, config,
cache, analysis, and polling paths.

The retained extractor can be exercised only through an explicit operator
startup mode. It is never an automatic fallback for a failed upload:

```bash
make yt-dlp-install
TOPSKIP_CAPTION_SOURCE=legacy_yt_dlp \
  TOPSKIP_YT_DLP_PATH="$PWD/.tools/yt-dlp" \
  pnpm run backend:dev
```

Legacy mode obtains bounded metadata and downloads one caption track as JSON3;
it never downloads video or audio. Repository-managed bootstrap binaries
support macOS universal and Linux x64. `make yt-dlp-refresh-pin` updates the
reviewed tag and checksums, but normal setup, CI, `make server`, and the
production image do not install the binary.

### Server-owned DeepSeek analysis

Production server analysis uses OpenRouter with the fixed
`deepseek/deepseek-v4-flash` model. It sends one non-streaming request containing
the validated uploaded transcript as `[startSec] text` lines plus the video ID
and caption language. It leaves reasoning at the model default and does not set
an output-token limit. The request has a five-minute timeout, while the HTTP
response remains size-bounded.

The system prompt and prompt version live in `common` so server analysis,
Private BYOK, and the model-comparison script share the same promo definition.
Only tests select the deterministic fixture adapter; a non-test backend always
uses DeepSeek V4 Flash. Analysis failures map to stable terminal codes instead of exposing
provider response bodies or errors.

Ready and no-promo results expire 30 days after DeepSeek completes. Only the same
algorithm, video, normalized language, and canonical transcript hash may join
an in-memory job or reuse an unexpired artifact. Validated transcripts and
bounded assistant output may also be retained for up to 30 days under access
control and pruning. They must not be pasted into issues, logs, or chat. Stored
metadata includes provider, model, prompt version, latency, token usage, and
reported cost. Logs never include the API key, installation token, raw IP,
transcript, assistant content, reasoning, caption bodies, signed URLs, or raw
provider errors.

### Build profiles and public API

The TopSkip backend origin is compiled in, not selected from runtime storage.
`TOPSKIP_SERVER_ORIGIN` comes from the root `.env` for local builds or the
process environment in CI. An absent `TOPSKIP_BUILD` defaults to `dev`; an
explicit blank, misspelled, or otherwise unknown profile fails closed.

| Profile | Command | Accepted backend origin | Content-script matches |
| --- | --- | --- | --- |
| Dev | `make build` | Public-looking HTTPS DNS origin, or exactly `http://127.0.0.1:8787` | YouTube + E2E fixture |
| Beta | `pnpm run beta` | Public-looking HTTPS DNS origin | YouTube only |
| Release | `pnpm run release` | Public-looking HTTPS DNS origin | YouTube only |

Dev, beta, and release names remain `TopSkip (Dev)`, `TopSkip (Beta)`, and
`TopSkip` respectively. The origin validator rejects paths, credentials,
wildcards, IP literals outside the exact dev exception, cleartext remote
origins, single-label names, and special-use DNS suffixes. It validates URL and
DNS *shape* only: the build does not resolve DNS and therefore cannot prove
that a public-looking name will not resolve to a private address at runtime.

Validate the emitted artifact, rather than relying on the source manifest:

```bash
pnpm run validate:extension-manifest -- \
  --build dev \
  --server-origin "${TOPSKIP_SERVER_ORIGIN}" \
  --manifest extension/dist/manifest.json
```

Use `--build beta` or `--build release` for those artifacts. The validator
checks the exact API, required-host, optional-host, minimum-version, and paired
content-script policy. CI runs it for every profile.

The public compatibility boundary consists of `/v1/installations/register`,
`/v1/config`, `/v1/analysis`, `/v1/analysis/jobs/{jobId}`, and `/v1/health`.
Analysis and polling require the installation bearer token. The strict public
contract lives in the Valibot schemas and inferred types in
`common/src/server-analysis-contract.ts`. The server computes transcript hashes
and owns the algorithm version; clients cannot submit either field.

### Permissions and static content lifecycle

The emitted permission boundary is deliberately small:

| Capability | Manifest field | Access |
| --- | --- | --- |
| Extension state | `permissions` | Required `storage` |
| Popup re-attach | `permissions` | Required `scripting` + `activeTab`; injection only into the tab the popup was opened on |
| Debug log | `permissions` | Required `unlimitedStorage`; lifts the 10 MB `storage.local` quota so the 5 MiB debug-log ring buffer never starves prefs/cache writes; no install warning, granted silently on update |
| TopSkip Server | `host_permissions` | Configured backend only |
| Private BYOK | `optional_host_permissions` | OpenRouter and OpenAI, granted independently |
| Watch integration | `content_scripts.matches` | YouTube; dev also includes the E2E fixture |

Methods such as `tabs.query()`, `tabs.sendMessage()`, and `tabs.create()` do not
by themselves require the sensitive `tabs` permission. Route ownership uses
trusted runtime-sender metadata plus a content-owned status probe instead of
reading `Tab.url`.

OpenRouter and OpenAI host access is requested only from a direct user gesture
in Private BYOK settings. **Allow access** is the primary path, while **Test
connection** may make the same provider-specific request from its click. A
saved API key and a Chrome host grant are independent: revoking access leaves
the key and model saved but changes provider availability to setup-required.
Every background provider entry point rechecks the grant immediately before
network I/O. Server mode never requests these optional grants and never falls
back to Private BYOK.

The extension service worker owns all TopSkip and provider HTTP. Content,
popup, options, and page contexts exchange validated messages and never call
those services directly.

Chrome 111 is the minimum supported version because both content bundles are
declarative: the MAIN caption bridge and the ISOLATED owner run at
`document_start`, with MAIN first. There is no persisted dynamic registration.
Installation, update, or manual extension **Reload** invalidates the existing
document's bundle; new documents receive the current static bundles
automatically, while an already-open YouTube tab is re-attached by the popup
(below) or by a page reload.

A normal MV3 worker sleep/restart is different. The live content context keeps
its analysis session, and a bounded readiness wake from the new worker only
resumes content-owned terminal delivery. It does not inject or replace code.
The bridge's document-lifetime fetch/XHR wrappers delegate unchanged while
dormant and clone/read timedtext bodies only during a bounded active capture.
Duplicate/replacement hooks remain a defensive guard if two static bundle
generations briefly coexist.

An orphaned context (runtime severed by install/update/reload) tears itself
down: the ISOLATED bundle polls `browser.runtime.id`, and once it is gone it
disposes the watch orchestration and sends the MAIN bridge a `teardown`
command, which restores native `fetch`/XHR and drops the bridge's command
listener and global hook. This keeps a stale bundle from lingering on the page
but does not by itself restore skipping.

Opening the popup does. It is the user gesture that grants `activeTab` for the
frontmost tab, which makes that tab's URL visible and programmatic injection
allowed there without a required YouTube host. The popup sends
`REATTACH_CONTENT_SCRIPT`; the background probes the tab with
`CONTENT_SCRIPT_READY` and, only when no current bundle answers and the URL is
a declarative content origin, injects `caption-page-bridge.js` (MAIN) and then
`content.js` (ISOLATED) with `scripting.executeScript` — the same files and
order as the manifest. It refuses to inject when the URL is hidden or
off-origin, waits briefly for an orphaned bridge to finish its self-teardown
(otherwise the orphan's `teardown` would retire the fresh bridge), coalesces
concurrent requests per tab, and is the only programmatic injection path.

Until valid enabled preferences have hydrated, and whenever TopSkip is
disabled, the static ISOLATED context is inert: no video binding, seek, caption
activation/read, analysis, or provider operation starts. Disable cancels the
current capture/session and makes late completions inapplicable.

### Server-analysis dev logs

Development builds emit structured stages prefixed with
`[TopSkip server-analysis]` as one line each — `<event> key=value …`, with
strings that contain spaces JSON-quoted and nested values as JSON — so the
fields read inline without expanding a console object. Content-script stages
are forwarded to the background, so open **`chrome://extensions` → TopSkip → Service worker** to see
the complete extension-side route, cache, HTTP, polling, and delivery flow.
The terminal running `make extension` only reports compilation; it does not
display extension runtime logs.

The same structured stages feed the user-facing **Debug logging** switch
(Options → Diagnostics, see [Debug logging (user-facing)](#debug-logging-user-facing)):
one diagnostics path emits each stage once and routes it to the console (dev
builds only, prefixed `[TopSkip debug]`) and to the local debug log (any
profile, only while the switch is on). Beta/release consoles are quiet by
default — only `[TopSkip] Service worker started <build>` and `warn`/`error`
lines with stable codes.

The terminal running `make server` shows the corresponding backend HTTP,
validation, cache/join, queue, model, and terminal-analysis stages. The retained
legacy mode additionally logs safe extraction stages. The allow-list includes
identifiers, stable codes, counts, latency, tokens, and cost, but never
transcript text, assistant content, caption bodies, signed URLs, stderr,
cookies, installation tokens, raw IP, or API keys.

After `make extension` rebuilds, click **Reload** on the extension card and
reload every already-open YouTube tab you want to test. Static content scripts
are installed only when a document loads; a readiness probe can wake a live
current bundle but cannot replace a bundle invalidated by extension reload.

### MV3 worker suspension and recovery

Server-mode polling is owned by the content script so an idle Manifest V3
service worker may stop between requests. The next scheduled poll wakes a new
worker and carries the complete `sessionId`, `jobId`, and exact server identity;
the background does not depend on memory from its previous lifetime.

If the worker stops while a runtime message is in flight, the content session
retries the same submit, poll, or one-time exact resubmission. It never captures
captions again merely because the message port closed. Explicit transport
retries use bounded backoff, each message has a watchdog, and the complete
analysis session has a 35-minute limit chosen to cover the bounded server queue
and five-minute model timeout. A session that exhausts recovery remains
terminal until navigation or a preference change, preventing the video-binding
loop from starting another analysis automatically.

Initial preference reads use their own timeout and retry loop, so a live content
bundle cannot remain permanently idle after losing its first worker reply. The
initial caption-bearing request also reasserts its session before cache or
network work, which repairs popup ordering if the advisory acquisition event was
lost. Local terminal failures remain queued without captions and are retried;
the next versioned readiness probe can redeliver them after a longer outage.

The retained transcript remains only in the live content context. Reloading the
YouTube document or replacing the content context intentionally starts a new
session; TopSkip does not persist an active transcript journal in IndexedDB or
extension storage. Completed results continue to use the exact
algorithm/video/language/transcript cache in `browser.storage.local`.

The popup's periodic status reads are extension-local runtime messages, not
TopSkip HTTP requests. An open popup normally follows tab-scoped background
push updates and performs a low-frequency reconciliation. During a worker
wake-up it keeps the last valid snapshot visible with a delayed-status warning
and retries; a transport failure is not presented as a TopSkip Server failure.

To smoke-test recovery after a fresh `pnpm run dev` build and extension reload:

1. Open a captioned YouTube watch page and wait for a processing job.
2. Stop the service worker from `chrome://extensions` between two polls.
3. Keep the watch document alive and reopen the popup if necessary.
4. Verify the content logs show one caption capture and retries of the same job
   identity, followed by one terminal result and no second initial submission.
5. Confirm the popup reaches ready/no-promo or a typed terminal outcome without
   a generic Server error caused solely by the worker restart.

The startup readiness wake is deliberately limited: the worker queries tab IDs
without reading URLs and sends two bounded versioned probes. A matching live
content script can acknowledge and resume a queued terminal event. A missing or
outdated receiver is recorded as unavailable; startup never dynamically
registers, injects, or repairs bundles.

---

## Project layout

| Path                          | Role                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/src/background/`   | MV3 **service worker** — sole **`local` storage** access for prefs; Valibot; **`runtime.onMessage`**; broadcasts updates via **`tabs.sendMessage`**                             |
| `extension/src/content/`      | **Content script** — `Content.init()` → `YoutubeWatch`; `skip-logic.ts` / `page-guards.ts` (pure); `youtube-watch.ts` (orchestration + runtime messaging, no storage for prefs) |
| `extension/src/popup/`        | **React + Mantine + MobX** toolbar popup; **`preferences-store.ts`** (messaging to background only)                                                                             |
| `extension/src/shared/`       | **`browser.ts`**, **Valibot** schema + constants, **`messages.ts`**, **`error.ts`** / **`valibot.ts`** (`getErrorMessage`, `extractMessageFromValiError`)                       |
| `extension/src/public/`       | Static files copied into `extension/dist/` (e.g. icons)                                                                                                                         |
| `backend/src/`                | Local server API, transcript validation, analysis jobs, durable artifacts, and an operator-only legacy extractor                                                                |
| `backend/tests/`              | Backend unit and integration tests                                                                                                                                              |
| `common/src/`                 | Pure API contracts, promo types, validation schemas, and caption parsing shared by backend and extension                                                                        |
| `common/tests/`               | Tests for shared contracts and pure helpers                                                                                                                                     |
| `extension/tests/`            | Extension unit, integration, and E2E tests; module tests mirror `extension/src/` paths                                                                                          |
| `scripts/tests/`              | Tests for root tooling, mirroring module paths under `scripts/`                                                                                                                  |
| `extension/dist/`             | **Build output** — load this folder as unpacked extension (gitignored)                                                                                                          |
| `extension/tests/e2e/`        | Playwright tests and `extension/tests/e2e/fixtures` static HTML                                                                                                                 |
| `extension/src/manifest.json` | Source manifest; **emitted into `extension/dist/`** by the build                                                                                                                |
| `.sdd/`                       | SDD feature **spec.md** / **plan.md** (e.g. `.sdd/001-init-extension/` MVP baseline, dated folders per feature). **Gitignored — local only, never pushed**                      |

The repository is a pnpm workspace. `backend`, `common`, and `extension` each
declare their runtime dependencies while root tooling owns formatting, linting,
type checking, and test orchestration.

The extension bundler is **Rspack** (`extension/rspack.config.ts`): background, content, popup,
options, and caption-page-bridge entries, with HTML plugins for popup and
options pages.

### Preferences and `browser.storage.local`

Only **`PrefsSyncStorage`** in **`extension/src/background/storage/prefs-sync.ts`** reads or writes **`browser.storage.local`** for the `topskip:prefs` key (query: **`PrefsSyncStorage.load`**, command: **`PrefsSyncStorage.save`**). The service worker entry **`extension/src/background/index.ts`** calls **`Background.init()`** from **`extension/src/background/background.ts`**, which registers install + runtime messaging. Persisted objects are validated with **Valibot** (`userPreferencesSchema` in `extension/src/shared/constants.ts`) — no unchecked casts on storage payloads.

The **popup** and **content** scripts must not call **`storage.local`** for
preferences. They use **`browser.runtime.sendMessage`** with **`TOPSKIP_*`**
message types from **`extension/src/shared/messages.ts`**. After a successful
update, the background notifies content scripts with
**`TOPSKIP_PREFS_UPDATED`** via **`tabs.sendMessage`**. Sending to a known tab
does not require the sensitive **`tabs`** permission; do not reintroduce it just
because the code uses the Tabs API.

---

## Commands reference

### Makefile targets

| Command                | What it runs                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `make setup`           | Install pnpm dependencies                                      |
| `make yt-dlp-install`  | Install pinned `yt-dlp` for explicit legacy mode only          |
| `make build`           | `pnpm run build`                                               |
| `make server`          | Load root `.env`, require the OpenRouter key, then run backend |
| `make extension`       | Watch and rebuild the development extension                    |
| `make lint`            | `pnpm run lint`                                                |
| `make test`            | Coverage, deployment asset tests, then Playwright E2E          |
| `make test-unit`       | `pnpm run test` (Vitest, no coverage)                          |
| `make test-coverage`   | `pnpm run test:coverage`                                       |
| `make test-deployment` | `pnpm run test:deployment`                                     |
| `make test-container`  | `pnpm run test:container`                                      |
| `make test-e2e`        | `pnpm run test:e2e`                                            |

### pnpm scripts

| Script                                       | Description                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm run setup`                             | Install pnpm dependencies                                                            |
| `pnpm run yt-dlp:install`                    | Install pinned `yt-dlp` for explicit legacy mode only                                |
| `pnpm run build`                             | Development build to `extension/dist/`                                               |
| `pnpm run build:watch`                       | Rspack watch mode                                                                    |
| `pnpm run validate:extension-manifest -- …` | Validate one emitted manifest against an exact build profile                        |
| `pnpm run format`                            | Apply formatting and safe autofixes (`eslint --fix .`)                               |
| `pnpm run format:check`                      | Report formatting without writing (alias of `lint:eslint`)                           |
| `pnpm run lint`                              | **ESLint** + **markdownlint** + **`tsc --noEmit`**                                    |
| `pnpm run lint:eslint`                       | **ESLint** — the project's only linter, type-aware (`eslint.config.ts`)              |
| `pnpm run lint:md`                           | **markdownlint-cli2** on `**/*.md` (excludes `node_modules`, `dist`, `coverage`)     |
| `pnpm run lint:types`                        | **TypeScript** — full project typecheck (`tsc --noEmit`, same as editor diagnostics) |
| `pnpm run test`                              | Vitest once (`vitest run`)                                                           |
| `pnpm run test:watch`                        | Vitest watch mode                                                                    |
| `pnpm run test:coverage`                     | Vitest with coverage (thresholds in `vitest.config.ts`)                              |
| `pnpm run test:e2e`                          | Playwright (headless extension; set `PW_EXTENSION_HEADED=1` for headed)              |
| `pnpm run test:deployment`                   | Deployment gateway, rollback-state, Compose, and server bundle checks                |
| `pnpm run test:container`                    | yt-dlp-free production image, startup failure, hardening, and SQLite persistence     |
| `pnpm run test:e2e:ui`                       | Playwright UI mode                                                                   |
| `pnpm run openrouter:compare-presets`        | Maintainer-only: same transcript → every built-in OpenRouter preset (see below)      |
| `pnpm run openrouter:extract-log-transcript` | Rebuild `[sec] text` user message from an exported caption `.log` (see below)        |

Formatting is owned by [ESLint Stylistic](https://eslint.style) rules inside `eslint.config.ts`, so `pnpm run lint` enforces the same style CI does; `pnpm run format` applies it.

Stylistic is a set of lint rules, not a formatter: it fixes indentation, quotes, semicolons, spacing, and trailing commas, but it never re-wraps a long line. Write to **80 columns** by hand; `max-len` only errors past **100**, because unbreakable spans (long member chains, deeply nested JSX) legitimately exceed 80. Markdown, JSON, and YAML are no longer auto-formatted — `pnpm run lint:md` still checks Markdown.

### Maintainer: compare preset models on one transcript

Use this **only** when you deliberately want **N** OpenRouter `chat/completions` calls (one per built-in preset in `extension/src/shared/openrouter-model-presets.ts`). It does **not** run during normal video playback.

1. **Fixture input** — UTF-8 file in one of two shapes:
    - **Timed lines only**: `[12] caption text` per line (synthetic sample: `scripts/fixtures/promo-compare-110-lines.txt`).
    - **Full user body** (what the worker sends to OpenRouter): starts with `videoId=…` then `language=…` then a blank line then `[sec] lines`. For a **real** video, export the service worker log (with expanded caption chunk objects, not only `{…}`), then rebuild:

        ```bash
        pnpm run openrouter:extract-log-transcript -- tmp/logs/your-export.log \
          -o scripts/fixtures/promo-v3eXTAqGkzg-ru-from-console.log.txt \
          --video-id v3eXTAqGkzg --language ru
        ```

        See `scripts/fixtures/README.txt` for how to compare model JSON against a human baseline and notes on segment counts.

2. Put **`OPENROUTER_API_KEY=sk-or-…`** in the root **`.env`** (gitignored), or export the variable in your shell. If both are set, the shell value wins.
3. From the repository root on macOS:

```bash
pnpm run openrouter:compare-presets -- \
  --fixture scripts/fixtures/promo-v3eXTAqGkzg-ru-from-console.log.txt \
  --reference scripts/fixtures/promo-v3eXTAqGkzg-reference-blocks.json
```

`--reference` is optional; when set, the JSON also includes `firstRunVsHuman` and per-model `rows[].vsHuman` (start/end deltas vs your `humanBlocks`, plus IoU). See `scripts/fixtures/README.txt`.

Stdout is JSON: each preset slug, latency in ms, parsed blocks or a per-model error. **Cost** is approximately **N × (input + output tokens) × model price** on [OpenRouter pricing](https://openrouter.ai/models); N is the number of preset entries (currently the length of `OPENROUTER_MODEL_PRESETS`).

### First-time Playwright browsers

If e2e fails with a missing browser error:

```bash
pnpm exec playwright install chromium
```

---

## Development workflow

1. **Branch** — Use a short-lived branch per change; open a **PR** into your main branch when ready.
2. **Before pushing**, run the same checks as CI (see below) locally:

    ```bash
    pnpm install --frozen-lockfile
    pnpm run lint
    pnpm run build
    pnpm run test
    pnpm run test:coverage
    pnpm exec playwright install chromium   # once per machine, if needed
    pnpm run test:e2e
    ```

3. **CI** (`.github/workflows/ci.yml`) on push/PR: **`pnpm install --frozen-lockfile`** → **lint** → **build** → **deployment assets** → **test** → **test:coverage** → **Playwright Chromium** → **`pnpm run test:e2e`** (e2e is **headless**; no Xvfb).
4. **Specs** — Larger behavior changes should align with `.sdd/001-init-extension/spec.md` / `plan.md` and relevant `.sdd/yyyymmdd-…` specs (update those docs in the same change when appropriate). `.sdd/` is gitignored, so those updates stay on your machine — anything a reviewer needs belongs in the commit message or the code.

Detailed contribution rules live in [AGENTS.md](./AGENTS.md).

---

## Testing

### Unit tests (Vitest)

```bash
make test-unit
make test-coverage
```

Unit tests live beside their owning package under **`backend/tests/`**,
**`common/tests/`**, and **`extension/tests/`**. Coverage thresholds apply to
selected extension logic such as **`skip-logic.ts`**, **`page-guards.ts`**, and
**`extension/src/popup/preferences-store.ts`** (see `vitest.config.ts`).
Module tests mirror their source path without adding a `src` directory below
`tests`: for example, `backend/src/analysis/promo-analysis-worker.ts` is tested
by `backend/tests/analysis/promo-analysis-worker.test.ts`. Root tooling follows
the same convention under **`scripts/tests/`**. Cross-module integration suites
stay under the owning package's `tests/`, and Playwright E2E lives under
**`extension/tests/e2e/`**.

### Manual server-mode check

1. Copy `.env.example` to `.env`, set `OPENROUTER_API_KEY`, and set
   `TOPSKIP_SERVER_ORIGIN=http://127.0.0.1:8787` for this dev-only loopback
   check.
2. `make build`, load **`extension/dist/`** unpacked (see [Getting started](#3-load-the-extension-in-chrome)).
3. Run the local backend with `make server`; the default extension-upload mode
   needs no extractor or source flag.
4. Open a `/watch` URL and verify the popup moves monotonically from caption
   acquisition to server analysis and then a ready, unavailable, or no-promo
   terminal state.
5. For a ready result, confirm the popup intervals match the server response,
   then let playback reach a detected block start and verify the extension
   skips only that future block once.
6. Switch to Private BYOK and open a new video; verify zero TopSkip analysis or
   registration requests occur.

### Manual caption-capture smoke test

This flow depends on YouTube's live player and is not part of CI.

1. Run `pnpm run build`.
2. Reload `extension/dist/` at `chrome://extensions`.
3. Open a YouTube watch page with known captions and turn YouTube captions off.
4. Confirm TopSkip is enabled.
5. In the extension service worker console, verify a captions payload arrives
   without visible subtitles flashing on the page.
6. Repeat with captions already on and verify TopSkip leaves them on.

Verbose manual-smoke logs are enabled by **`CAPTION_CAPTURE_VERBOSE_LOGS`** in
**`extension/src/shared/constants.ts`**. In the service worker console, look for
**`[TopSkip content ...] caption-capture`** entries with these safe stages:

- **`bridge-readiness-requested`** / **`bridge-ready`**: ISOLATED content
  confirmed that the declarative MAIN bridge responds to local document
  commands.
- **`page:bridge-installed`**: the static MAIN-world bridge started at
  `document_start`; this does not mean capture is active.
- **`activation-attempt`** / **`activation-accepted`**: TopSkip asked the player
  to load captions.
- **`page:activation-finished`**: page bridge recorded caption state, hide style,
  track count, and activation actions. When captions were off, expect
  **`setOption:track`** if YouTube exposes a tracklist; otherwise expect
  **`setOption:reload`**. When captions were already on, expect
  **`skipped:already-on`**.
- **`page:timedtext-observed`**: the player made a `fmt=json3` timedtext
  request; metadata includes transport, status, body length, language, and
  sanitized URL shape only.
- **`page:timedtext-empty-body`** or **`page:timedtext-non-json`**: YouTube
  returned a response that the parser should not use.
- **`page:timedtext-forwarded`** / **`capture-event-received`** /
  **`capture-parsed`**: non-empty caption JSON reached content and parsed.
- **`cleanup-start`** / **`page:cleanup-finished`** /
  **`cleanup-finished`**: temporary caption state was restored.

These logs intentionally do not include raw caption bodies, full timedtext URLs,
or signed parameter values.

### Developer: player-mediated caption capture

**Default:** **`CAPTION_TRANSCRIPT_DEV_ENABLED`** is **`true`** in
**`extension/src/shared/constants.ts`**. On supported YouTube watch pages, the
statically declared MAIN-world bridge remains dormant until ISOLATED content
briefly asks the player to activate captions. It then observes the player's own
successful `/api/timedtext?fmt=json3` response, returns it through a validated
document-local event contract, and content sends
**`TOPSKIP_CAPTIONS_FROM_CONTENT`** to the background.

The production path no longer uses direct timedtext probing, direct InnerTube fallback clients, or fresh watch-page HTML scraping. The bridge preserves the page's fetch/XHR behavior, forwards caption bodies only to the internal parser pipeline, and keeps diagnostics to bounded metadata such as failure stage, language, body length, segment count, and sanitized timedtext parameter names.

**Trigger:** When valid preferences say TopSkip is enabled and the watch
**video id** changes, **`WatchCaptions`** schedules
**`PlayerCaptionCapture`**. The capture flow probes the static bridge, waits
through bounded activation retries if the player appears unstable or an ad is
visible, then cleans up temporary caption state after success or timeout.

1. `make build`, load **`extension/dist/`** unpacked.
2. Open **`chrome://extensions`**, find TopSkip, click **Service worker** (this DevTools window is where **chunked transcript** **`[TopSkip captions]`** logs from the background appear).
3. Navigate to a YouTube **`/watch?v=…`** video that has **captions** (CC), or click another video so the watch URL updates (SPA).
4. The **service worker** console shows parsed caption handling or a structured acquisition failure. The production runtime should not print raw timedtext bodies or full signed URLs.

#### Troubleshooting: no logs in the “background”

- TopSkip logs from `background.js` only appear in the **extension service worker** DevTools console (`chrome://extensions` → TopSkip → **Service worker**). That is the correct “background” console in MV3, even though there is no separate HTML page.
- **Manifest V3 has no HTML background page** — only a **service worker**. Those logs do **not** appear in the watch tab’s F12 console and **not** in the popup’s Inspect window.
- Open **`chrome://extensions` → TopSkip → “Service worker”** (link or button). That opens a **dedicated** DevTools instance for the worker. Keep it open; you should see **`[TopSkip] Service worker started`** whenever the worker starts (e.g. after **Reload** on the extension card). The line carries the build label (`version_name`: the base version plus the `dev`/`beta` build timestamp, also shown as the version on the extension card) — compare it with your last `make build` to tell a stale load from the current artifact.
- Run **`make build`**, **Reload** the extension, then **navigate** to a **`/watch?v=…`** URL (or change the video in-place). Within about half a second, the **service worker** console should show **`[TopSkip captions]`** lines.
- If you see random lines like “Content script initialized” with icons, those are **not** from TopSkip (this repo has no such strings).

**Toggle-off sanity check:** With the switch **off**, set playback to **4×**
and let time pass 0:30 — there should be **no** jump, caption activation, or
analysis request. This confirms the background-owned preference message made
the statically loaded content context inert.

### End-to-end (Playwright)

```bash
make build
make test-e2e
```

Playwright starts a static server for **`extension/tests/e2e/fixtures`** (see
`extension/playwright.config.ts`, port **4173**). Only the development manifest
includes **`http://127.0.0.1:4173/*`** in both declarative content-script
entries, so MAIN and ISOLATED run together on the fixture. Beta and release
artifacts reject that match. Tests load the unpacked extension from
**`extension/dist/`** using **headless** Chromium by default; set
**`PW_EXTENSION_HEADED=1`** when debugging (visible browser).

The fixture uses a **small vendored** silent MP4 (`extension/tests/e2e/fixtures/skip-test.mp4`, ~3 KiB, 120s) served from the same static root — **no network** required for e2e. The video is **muted** in HTML and tests (`muted` / `playsinline`) so playback does not emit sound. To regenerate the asset after changing duration/encoding, run:

```bash
bash scripts/generate-e2e-fixture-video.sh
```

---

## Debug logging (user-facing)

TopSkip ships an optional **Debug logging** switch in **Options → Diagnostics**
(deep link `options.html#diagnostics`). It is off by default in beta/release and
on by default in dev builds; a persisted choice always wins over the profile
default. While it is on, the background keeps allow-listed diagnostics (route
decisions, caption-capture stages, HTTP status/latency, one polling summary per
job, skip decisions, BYOK metadata, worker lifecycle) in a `storage.local` ring
buffer up to 5 MiB (oldest entries replaced). The log is user-initiated and
local-only: it includes YouTube video IDs and says so in the UI and export
header; it excludes transcripts and secrets (no captions, prompts, model
output, API keys, installation tokens, cookies, URLs, or raw responses);
incognito windows are not logged. Turning the switch off keeps the log; it is
kept until Debug logging is turned on again (turning it on discards the stored
log and starts a new one). Nothing is uploaded — the user copies or downloads
the bundle and attaches it to a GitHub issue themselves. The required
`unlimitedStorage` permission backs the ring buffer; it adds no install
warning, so an update that introduces it is granted silently.

Dev builds mirror the same events to the service-worker console
(`[TopSkip debug] <event> key=value …`); beta/release consoles stay quiet
except the startup line and stable-coded `warn`/`error`.

### Four-step script

1. **Enable** — open Options → Diagnostics, read the notice, switch **Debug
   logging** on. The status line shows "Debug logging on since …" with live
   event, size, evicted and dropped counters.
2. **Reproduce** — go to the YouTube video that misbehaves and reproduce the
   problem (the worker may sleep and wake meanwhile; events keep appending).
3. **Copy** — return to Options → Diagnostics, glance at the **Recent log**
   preview, press **Copy log** (or **Download log** for a
   `topskip-debug-log-<YYYYMMDDTHHMMSSZ>.txt` file whose name equals the
   `exportedAt` header of that bundle).
4. **Attach** — paste or attach the text to the GitHub issue or support
   message. Review it first: it lists the video IDs watched while logging.

### Manual checks

Playwright cannot restart the worker, reload the extension, or open incognito
with the extension loaded (`chrome.runtime.reload()` kills the unpacked
extension in a persistent context), so these stay manual — tick them in the PR
body:

- **Quit/reopen Chrome** with the switch on → the next lifetime logs
  `worker-started` followed by exactly one `browser-restarted` marker (plus
  `extension-restarted` only if an update was staged meanwhile).
- **Same-version reload under release flags** — `pnpm run release`, load
  `extension/dist/` unpacked, switch on, click **Reload** on the extension card
  → one `extension-restarted previousBuild=<label> newBuild=<label>` marker
  even though both labels are equal; no `browser-restarted`.
- **Disable/re-enable** on `chrome://extensions` → one
  `runtime-restarted cause=session-state-lost` marker before the first
  non-lifecycle event; no browser/extension marker.
- **Update/reload → popup re-attach** — reload the extension with a YouTube tab
  open, then open the popup on that tab → the log shows the `reattach` outcome
  and the `wakeup-probe` `readyTabs`/`unavailableTabs` counts that explain the
  gap.
- **Update from a build without `unlimitedStorage`** — install a build from
  before this change, then update to the current build (Extension Update
  Testing Tool or a packed `.crx`) → no permission warning, the extension stays
  enabled, enabling Debug logging works; `extension-restarted` carries
  `previousBuild=unknown` unless a label was persisted.
- **Policy-blocked downloads** — with the enterprise `DownloadRestrictions`
  policy set (or by cancelling the "Save as" dialog), press **Download log** →
  the UI reports only "Download started"; **Copy log** remains the primary
  path.
- **Incognito** — allow the extension in incognito, run a Server-mode analysis
  and a skip in an incognito YouTube tab → the bundle contains no event with
  that tab's id or video ID, the Diagnostics counters show a non-zero incognito
  dropped count, the export header does not name incognito, and a concurrent
  normal tab is logged unaffected.
- **Worker sleep** — with the switch on, wait for the service worker to show
  "Inactive" on `chrome://extensions`, then interact with YouTube → events from
  the new lifetime append after a `worker-started` marker and nothing persisted
  earlier is lost.
- **Live caption capture** — on a real `/watch?v=…` page with captions, the
  bundle shows `capture-scheduled`, `capture-activation`, `capture-stage`
  (ISOLATED and MAIN stages) and `capture-succeeded`; the E2E fixture host
  disables capture (`extension/src/content/watch-captions.ts`), so this is
  manual only.
- **Capture failure (SC-003)** — open a watch page without captions (or block
  the timedtext request) → the bundle shows the `capture-*` stages, exactly one
  `capture-failed reason=<stable reason>` and the session's terminal event
  (`analysis-interrupted` / `terminal-event`) for that video.
- **Server failure (SC-003)** — with Server mode and a failing or unreachable
  backend → the bundle shows `http-response status=<code> elapsedMs= attempt=`
  (or the final `poll-summary terminal=true`), `terminal-event failureCode=…`
  with `sup=support-…` in the line head when the backend issued one, and the
  delivery outcome (`blocks-delivered` or `delivery-skipped reason=…`).
- **Missed skip (SC-003)** — scrub across a known promo block without it being
  skipped → the bundle shows `blocks-received blocks=…` timings, `seek-summary`
  lines and one
  `skip-suppressed reason=<already-fired|not-crossed|seek-guard|seeking|no-duration>`
  for the crossed block.

After any Playwright run, `pnpm run build` repoints `extension/dist/` at the
configured origin before reloading the unpacked extension in Chrome.

---

## Dev log server (cross-context console)

Chrome extension contexts (service worker, content scripts, popup, options)
each have their own DevTools console, making it hard to follow a
message flow across contexts. The repo includes a lightweight
**local log server** that collects `POST`ed log lines from any
context into a single `debug.log` file and echoes them to the
terminal.

### Files

| File                                | Purpose                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/log-server.ts`             | Node.js HTTP server on `127.0.0.1:9222`; writes timestamped lines to `debug.log` and stdout                                                                      |
| `extension/src/shared/debug-log.ts` | `debugLog(source, message)` — fire-and-forget `fetch POST` to the log server; safe to call in any context (silently ignores failures when the server is offline) |
| `debug.log`                         | Output file created by the server (gitignored)                                                                                                                   |

### Usage

1. **Start the log server** in a separate terminal:

    ```bash
    pnpm tsx scripts/log-server.ts
    ```

    The server clears `debug.log` on startup, listens on
    `http://127.0.0.1:9222/log`, and prints every incoming line.

2. **Add temporary `debugLog` calls** in the code you are
   investigating:

    ```ts
    import { debugLog } from '@/shared/debug-log';
    debugLog('bg', 'SET_PREFS handler entered');
    debugLog('popup', `port message: ${JSON.stringify(msg)}`);
    ```

3. **Rebuild** (`make build`), reload the extension, and reproduce
   the scenario. All log lines appear in the terminal running
   the server and in `debug.log`, tagged with ISO timestamp and
   source label:

    ```text
    [2026-04-15T22:30:01.123Z] [bg] SET_PREFS handler entered
    [2026-04-15T22:30:01.200Z] [popup] port message: {"type":"..."}
    ```

4. **Remove the `debugLog` calls** before committing — the helper
   is dev-only infrastructure and must not ship in production
   bundles. `extension/src/shared/debug-log.ts` itself stays in the repo so
   it is available for the next debugging session.

5. **Stop the server** with `Ctrl-C` or `kill <pid>`.

### Why not `console.log`?

`console.log` goes to whichever DevTools instance owns that
context. During cross-context debugging (e.g. popup sends a
message → background handles it → broadcasts to content) you would
need three DevTools windows open and mentally interleave their
timestamps. The log server merges everything into one ordered
stream.

---

## Common tasks

| Task                          | Steps                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| **Iterate on UI (popup)**     | Edit `extension/src/popup/*`, `make build`, reload extension on `chrome://extensions`            |
| **Iterate on content script** | Edit `extension/src/content/*`, `make build`, then reload the extension on `chrome://extensions` |
| **Add a unit test**           | Add `<package>/tests/.../*.test.ts` mirroring its `<package>/src/` path; run `pnpm run test`     |
| **Debug failing CI locally**  | Run `pnpm install --frozen-lockfile`, then the same commands as `.github/workflows/ci.yml`       |
| **Clean install**             | Remove `node_modules`, run `pnpm install --frozen-lockfile`                                      |

---

## Troubleshooting

| Issue                                                 | What to try                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`make build` fails**                                | Ensure Node **≥ 22**; run `pnpm install`; check Rspack/TypeScript errors in the terminal                                                                                                                                            |
| **`make server` reports a missing OpenRouter key**    | Copy `.env.example` to the root `.env`, set `OPENROUTER_API_KEY`, or export it in the shell before starting the server                                                                                                              |
| **Explicit legacy mode reports missing `yt-dlp`**     | Run `make yt-dlp-install`, or set `TOPSKIP_YT_DLP_PATH` to a working executable; default `extension_upload` mode never requires it                                                                                                  |
| **Extension doesn’t update after edits**              | Run `make build`, click **Reload** on `chrome://extensions`, then reload already-open YouTube tabs; static scripts cannot replace an invalidated document context |
| **Lint errors in IDE but not terminal**               | Run `pnpm run lint` from repo root (includes **`pnpm run lint:types`**). ESLint alone does not repeat every `tsc` error — the editor uses the TypeScript language service.                                                          |
| **`pnpm run test:e2e` fails (browser)**               | Run `pnpm exec playwright install chromium`                                                                                                                                                                                         |
| **`pnpm run test:e2e` times out / video never plays** | Confirm `extension/tests/e2e/fixtures/skip-test.mp4` exists; re-run `bash scripts/generate-e2e-fixture-video.sh` if needed                                                                                                          |
| **Port 4173 already in use**                          | Stop the other process using the port, or adjust `extension/playwright.config.ts` `webServer` + manifest host if you must (keep them in sync)                                                                                       |
| **Coverage fails after changes**                      | Run `pnpm run test:coverage` and add tests or adjust coverage scope in `vitest.config.ts` deliberately                                                                                                                              |

---

## Additional resources

| Document                                             | Purpose                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| [README.md](./README.md)                             | Quick start and command table                                                 |
| [AGENTS.md](./AGENTS.md)                             | Architecture, conventions, what agents should not do                          |
| [extension/DEPLOYMENT.md](./extension/DEPLOYMENT.md) | Zipping `extension/dist/` and Chrome Web Store checklist (not day-to-day dev) |
| `.sdd/` (local only)                                 | Dated feature specifications and implementation decisions; not published      |
