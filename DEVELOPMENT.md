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
    - [5. Local server-mode backend (optional)](#5-local-server-mode-backend-optional)
    - [Server-owned Gemini analysis](#server-owned-gemini-analysis)
    - [Build profiles and public API](#build-profiles-and-public-api)
    - [Server-analysis dev logs](#server-analysis-dev-logs)
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
- [Debug logging (cross-context)](#debug-logging-cross-context)
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
| **Google Chrome** (or Chromium) | Required to load the **unpacked** extension from `extension/dist/` during development         |

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
pnpm run yt-dlp:install
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

After code changes, click **Reload** on the extension card, or run a fresh `make build` and reload again.

### 4. Watch mode (optional)

Rebuild on file changes:

```bash
make extension
```

Equivalent: `pnpm run build:watch`.

### 5. Local server-mode backend (optional)

Run the loopback backend when exercising server-mode development:

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env, then:
make server
```

The root `.env` is gitignored. An exported `OPENROUTER_API_KEY` takes precedence
over the file. `make server` validates required configuration before binding
the HTTP listener or starting extraction and exits with a safe configuration
error when the key is missing or blank.

`make server` uses the already installed pinned `yt-dlp` and never checks for
updates. Maintainers update the reviewed release and checksums with
`make yt-dlp-refresh-pin`, then reinstall through `make yt-dlp-install`.

It listens on `http://127.0.0.1:8787`. The matching host permission is injected
only into development builds, so extension-only work and Private BYOK testing
do not require this process. Beta and release builds instead contain only the
public `https://topskip.maximtop.dev/*` server permission. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for the production route and operations.

On a YouTube `/watch?v=…` page, server analysis becomes eligible as soon as the
content script has loaded preferences and found both the video id and the main
`<video>` element. It waits up to five seconds for finite duration metadata so
backend boundary validation and the popup timeline use the real video length;
playback does not need to start. If duration remains unavailable (for example,
for a live stream), analysis continues without it. The content script sends a
runtime message; only the background service worker checks the local cache and
performs HTTP requests to the backend. A fresh extension-side cache hit
intentionally produces no backend request.

The background lazily registers a random anonymous installation token when
Server mode first needs the backend. The token never crosses into popup or
content code. It refreshes `/v1/config` at most once per hour, accepts the
server-owned algorithm version, and removes local ready-cache entries from
other algorithms. If config is temporarily unreachable, an unexpired cached
result may still be used. Private BYOK returns before registration, config,
cache, analysis, and polling paths.

The backend always extracts YouTube subtitles through `yt-dlp`; there is no
network opt-in flag. It obtains bounded metadata first, selects one manual or
automatic track, then downloads only that track as JSON3. Video and audio are
never requested. To use an executable outside `.tools/`, set:

```bash
TOPSKIP_YT_DLP_PATH=/absolute/path/to/yt-dlp pnpm run backend:dev
```

Repository-managed bootstrap binaries support macOS universal and Linux x64.
CI and `make server` use the installed version without an update check.

### Server-owned Gemini analysis

Production server analysis uses OpenRouter with the fixed
`google/gemini-3.5-flash` model. It sends one non-streaming request containing
the selected transcript as `[startSec] text` lines plus the video ID and caption
language. The request uses `reasoning.effort=high`, excludes reasoning text from
the response, has a 45-second timeout, and caps both completion tokens and HTTP
response size.

The system prompt and prompt version live in `common` so server analysis,
Private BYOK, and the model-comparison script share the same promo definition.
Only tests select the deterministic fixture adapter; a non-test backend always
uses Gemini. Analysis failures map to stable terminal codes instead of exposing
provider response bodies or errors.

Ready and no-promo results expire 30 days after Gemini completes. Requests for
the same video and active server algorithm join an in-memory job or reuse an
unexpired artifact. Stored metadata includes provider, model, prompt version,
latency, token usage, and reported cost. Logs never include the API key,
installation token, raw IP, transcript, reasoning, subtitle contents, signed
URLs, or raw provider errors.

### Build profiles and public API

The extension origin is compiled per profile; it is not selected from runtime
storage:

| Profile | Command            | Server origin                  |
| ------- | ------------------ | ------------------------------ |
| Dev     | `make build`       | `http://127.0.0.1:8787`        |
| Beta    | `pnpm run beta`    | `https://topskip.maximtop.dev` |
| Release | `pnpm run release` | `https://topskip.maximtop.dev` |

The public compatibility boundary consists of `/v1/installations/register`,
`/v1/config`, `/v1/analysis`, `/v1/analysis/jobs/{jobId}`, and `/v1/health`.
Analysis and polling require the installation bearer token. The server ignores
the deprecated request-side `algorithmVersion`; all processing and terminal
responses carry the active server version. Wire-breaking changes require a new
API prefix rather than changing `/v1` in place.

### Server-analysis dev logs

Development builds emit structured stages prefixed with
`[TopSkip server-analysis]`. Content-script stages are forwarded to the
background, so open **`chrome://extensions` → TopSkip → Service worker** to see
the complete extension-side route, cache, HTTP, polling, and delivery flow.
The terminal running `make extension` only reports compilation; it does not
display extension runtime logs.

The terminal running `make server` shows the corresponding backend HTTP, job,
yt-dlp, extraction, and terminal-analysis stages. Logs include `videoId` and
`jobId`, but never transcript text, subtitle bodies, signed URLs, stderr,
cookies, or API keys.

After `make extension` rebuilds, click **Reload** on the extension card and
reload the YouTube tab. Programmatically registered content scripts are not
retroactively injected into an already loaded document.

---

## Project layout

| Path                          | Role                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/src/background/`   | MV3 **service worker** — sole **`local` storage** access for prefs; Valibot; **`runtime.onMessage`**; broadcasts updates via **`tabs.sendMessage`**                             |
| `extension/src/content/`      | **Content script** — `Content.init()` → `YoutubeWatch`; `skip-logic.ts` / `page-guards.ts` (pure); `youtube-watch.ts` (orchestration + runtime messaging, no storage for prefs) |
| `extension/src/popup/`        | **React + Mantine + MobX** toolbar popup; **`preferences-store.ts`** (messaging to background only)                                                                             |
| `extension/src/shared/`       | **`browser.ts`**, **Valibot** schema + constants, **`messages.ts`**, **`error.ts`** / **`valibot.ts`** (`getErrorMessage`, `extractMessageFromValiError`)                       |
| `extension/src/public/`       | Static files copied into `extension/dist/` (e.g. icons)                                                                                                                         |
| `backend/src/`                | Local server-first API, caption extraction, analysis jobs, and durable artifacts                                                                                                |
| `backend/tests/`              | Backend unit and integration tests                                                                                                                                              |
| `common/src/`                 | Pure API contracts, promo types, validation schemas, and caption parsing shared by backend and extension                                                                        |
| `common/tests/`               | Tests for shared contracts and pure helpers                                                                                                                                     |
| `extension/dist/`             | **Build output** — load this folder as unpacked extension (gitignored)                                                                                                          |
| `extension/e2e/`              | Playwright tests and `extension/e2e/fixtures` static HTML                                                                                                                       |
| `extension/src/manifest.json` | Source manifest; **emitted into `extension/dist/`** by the build                                                                                                                |
| `.sdd/`                       | SDD feature **spec.md** / **plan.md** (e.g. `.sdd/001-init-extension/` MVP baseline, dated folders per feature)                                                                 |

The repository is a pnpm workspace. `backend`, `common`, and `extension` each
declare their runtime dependencies while root tooling owns formatting, linting,
type checking, and test orchestration.

The extension bundler is **Rspack** (`extension/rspack.config.ts`): background, content, popup,
options, and caption-page-bridge entries, with HTML plugins for popup and
options pages.

### Preferences and `browser.storage.local`

Only **`PrefsSyncStorage`** in **`extension/src/background/storage/prefs-sync.ts`** reads or writes **`browser.storage.local`** for the `topskip:prefs` key (query: **`PrefsSyncStorage.load`**, command: **`PrefsSyncStorage.save`**). The service worker entry **`extension/src/background/index.ts`** calls **`Background.init()`** from **`extension/src/background/background.ts`**, which registers install + runtime messaging. Persisted objects are validated with **Valibot** (`userPreferencesSchema` in `extension/src/shared/constants.ts`) — no unchecked casts on storage payloads.

The **popup** and **content** scripts must not call **`storage.local`** for preferences. They use **`browser.runtime.sendMessage`** with **`TOPSKIP_*`** message types from **`extension/src/shared/messages.ts`**. After a successful update, the background notifies content scripts with **`TOPSKIP_PREFS_UPDATED`** via **`tabs.sendMessage`**, which requires the **`tabs`** permission in **`manifest.json`**.

---

## Commands reference

### Makefile targets

| Command                | What it runs                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `make setup`           | Install pnpm dependencies and the pinned `yt-dlp`              |
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
| `pnpm run setup`                             | Install dependencies and the pinned `yt-dlp`                                         |
| `pnpm run build`                             | Development build to `extension/dist/`                                               |
| `pnpm run build:watch`                       | Rspack watch mode                                                                    |
| `pnpm run format`                            | Apply **oxfmt** formatting (`.oxfmtrc.json`)                                         |
| `pnpm run format:check`                      | Check **oxfmt** formatting without writing                                           |
| `pnpm run lint`                              | **oxfmt** check + **oxlint** + ESLint parity + **markdownlint** + **`tsc --noEmit`** |
| `pnpm run lint:eslint`                       | ESLint parity checks that oxlint does not fully replace yet (`eslint.config.ts`)     |
| `pnpm run lint:md`                           | **markdownlint-cli2** on `**/*.md` (excludes `node_modules`, `dist`, `coverage`)     |
| `pnpm run lint:ox`                           | **oxlint** checks (`.oxlintrc.json`)                                                 |
| `pnpm run lint:types`                        | **TypeScript** — full project typecheck (`tsc --noEmit`, same as editor diagnostics) |
| `pnpm run test`                              | Vitest once (`vitest run`)                                                           |
| `pnpm run test:watch`                        | Vitest watch mode                                                                    |
| `pnpm run test:coverage`                     | Vitest with coverage (thresholds in `vitest.config.ts`)                              |
| `pnpm run test:e2e`                          | Playwright (headless extension; set `PW_EXTENSION_HEADED=1` for headed)              |
| `pnpm run test:deployment`                   | Deployment gateway, rollback-state, Compose, and server bundle checks                |
| `pnpm run test:container`                    | Production image constraints, pinned yt-dlp, startup failure, and SQLite persistence |
| `pnpm run test:e2e:ui`                       | Playwright UI mode                                                                   |
| `pnpm run openrouter:compare-presets`        | Maintainer-only: same transcript → every built-in OpenRouter preset (see below)      |
| `pnpm run openrouter:extract-log-transcript` | Rebuild `[sec] text` user message from an exported caption `.log` (see below)        |

`pnpm run format` is the repo-wide formatter. `pnpm run lint` includes `format:check`, so CI enforces the same formatting as local development.

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
4. **Specs** — Larger behavior changes should align with `.sdd/001-init-extension/spec.md` / `plan.md` and relevant `.sdd/yyyymmdd-…` specs (update those docs in the same change when appropriate).

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

### Manual server-mode check

1. Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`.
2. `make build`, load **`extension/dist/`** unpacked (see [Getting started](#3-load-the-extension-in-chrome)).
3. Run the local backend with `make server`; it is ready for a real-caption
   smoke test without another flag.
4. Open a `/watch` URL and verify the popup first reports server analysis and
   then a ready, unavailable, or no-promo terminal state.
5. For a ready result, confirm the popup intervals match the server response,
   then let playback reach a detected block start and verify the extension
   skips only that future block once.
6. Switch to Private BYOK and open a new video; verify no server request occurs.

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

- **`bridge-install-requested`** / **`bridge-installed`**: content and
  background installed the page bridge.
- **`page:bridge-installed`**: MAIN-world bridge ran inside the YouTube page.
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

**Default:** **`CAPTION_TRANSCRIPT_DEV_ENABLED`** is **`true`** in **`extension/src/shared/constants.ts`**. On supported YouTube watch pages, TopSkip installs a MAIN-world bridge, briefly asks the player to activate captions when needed, observes the player's own successful `/api/timedtext?fmt=json3` response, parses it in the content script, and sends **`TOPSKIP_CAPTIONS_FROM_CONTENT`** to the background.

The production path no longer uses direct timedtext probing, direct InnerTube fallback clients, or fresh watch-page HTML scraping. The bridge preserves the page's fetch/XHR behavior, forwards caption bodies only to the internal parser pipeline, and keeps diagnostics to bounded metadata such as failure stage, language, body length, segment count, and sanitized timedtext parameter names.

**Trigger:** When TopSkip is enabled and the watch **video id** changes, **`WatchCaptions`** schedules **`PlayerCaptionCapture`**. The capture flow installs the bridge, waits through bounded activation retries if the player appears unstable or an ad is visible, then cleans up temporary caption state after success or timeout.

1. `make build`, load **`extension/dist/`** unpacked.
2. Open **`chrome://extensions`**, find TopSkip, click **Service worker** (this DevTools window is where **chunked transcript** **`[TopSkip captions]`** logs from the background appear).
3. Navigate to a YouTube **`/watch?v=…`** video that has **captions** (CC), or click another video so the watch URL updates (SPA).
4. The **service worker** console shows parsed caption handling or a structured acquisition failure. The production runtime should not print raw timedtext bodies or full signed URLs.

#### Troubleshooting: no logs in the “background”

- TopSkip logs from `background.js` only appear in the **extension service worker** DevTools console (`chrome://extensions` → TopSkip → **Service worker**). That is the correct “background” console in MV3, even though there is no separate HTML page.
- **Manifest V3 has no HTML background page** — only a **service worker**. Those logs do **not** appear in the watch tab’s F12 console and **not** in the popup’s Inspect window.
- Open **`chrome://extensions` → TopSkip → “Service worker”** (link or button). That opens a **dedicated** DevTools instance for the worker. Keep it open; you should see **`[TopSkip] Service worker started`** whenever the worker starts (e.g. after **Reload** on the extension card).
- Run **`make build`**, **Reload** the extension, then **navigate** to a **`/watch?v=…`** URL (or change the video in-place). Within about half a second, the **service worker** console should show **`[TopSkip captions]`** lines.
- If you see random lines like “Content script initialized” with icons, those are **not** from TopSkip (this repo has no such strings).

**Toggle-off sanity check:** With the switch **off**, set playback to **4×** and let time pass 0:30 — there should be **no** jump (confirms `chrome.storage` + `onChanged` in the content script).

### End-to-end (Playwright)

```bash
make build
make test-e2e
```

Playwright starts a static server for **`extension/e2e/fixtures`** (see `extension/playwright.config.ts`, port **4173**). The extension manifest includes **`http://127.0.0.1:4173/*`** so the **content script** runs on the fixture page. Tests load the unpacked extension from **`extension/dist/`** using **headless** Chromium by default; set **`PW_EXTENSION_HEADED=1`** when debugging (visible browser).

The fixture uses a **small vendored** silent MP4 (`extension/e2e/fixtures/skip-test.mp4`, ~3 KiB, 120s) served from the same static root — **no network** required for e2e. The video is **muted** in HTML and tests (`muted` / `playsinline`) so playback does not emit sound. To regenerate the asset after changing duration/encoding, run:

```bash
bash scripts/generate-e2e-fixture-video.sh
```

---

## Debug logging (cross-context)

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

| Task                          | Steps                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| **Iterate on UI (popup)**     | Edit `extension/src/popup/*`, `make build`, reload extension on `chrome://extensions`        |
| **Iterate on content script** | Edit `extension/src/content/*`, `make build`, reload extension **and** the YouTube tab       |
| **Add a unit test**           | Add `extension/tests/.../*.test.ts` mirroring the `extension/src/` path; run `pnpm run test` |
| **Debug failing CI locally**  | Run `pnpm install --frozen-lockfile`, then the same commands as `.github/workflows/ci.yml`   |
| **Clean install**             | Remove `node_modules`, run `pnpm install --frozen-lockfile`                                  |

---

## Troubleshooting

| Issue                                                 | What to try                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`make build` fails**                                | Ensure Node **≥ 22**; run `pnpm install`; check Rspack/TypeScript errors in the terminal                                                                                   |
| **`make server` reports a missing OpenRouter key**    | Copy `.env.example` to the root `.env`, set `OPENROUTER_API_KEY`, or export it in the shell before starting the server                                                     |
| **Backend reports missing `yt-dlp`**                  | Run `make yt-dlp-install`, or set `TOPSKIP_YT_DLP_PATH` to a working executable                                                                                            |
| **Extension doesn’t update after edits**              | Run `make build` again; on `chrome://extensions`, click **Reload** on the extension; for content scripts, **reload the tab** (or close/reopen YouTube)                     |
| **Lint errors in IDE but not terminal**               | Run `pnpm run lint` from repo root (includes **`pnpm run lint:types`**). ESLint alone does not repeat every `tsc` error — the editor uses the TypeScript language service. |
| **`pnpm run test:e2e` fails (browser)**               | Run `pnpm exec playwright install chromium`                                                                                                                                |
| **`pnpm run test:e2e` times out / video never plays** | Confirm `extension/e2e/fixtures/skip-test.mp4` exists; re-run `bash scripts/generate-e2e-fixture-video.sh` if needed                                                       |
| **Port 4173 already in use**                          | Stop the other process using the port, or adjust `extension/playwright.config.ts` `webServer` + manifest host if you must (keep them in sync)                              |
| **Coverage fails after changes**                      | Run `pnpm run test:coverage` and add tests or adjust coverage scope in `vitest.config.ts` deliberately                                                                     |

---

## Additional resources

| Document                                             | Purpose                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| [README.md](./README.md)                             | Quick start and command table                                                 |
| [AGENTS.md](./AGENTS.md)                             | Architecture, conventions, what agents should not do                          |
| [extension/DEPLOYMENT.md](./extension/DEPLOYMENT.md) | Zipping `extension/dist/` and Chrome Web Store checklist (not day-to-day dev) |
| [.sdd/](./.sdd/)                                     | Dated feature specifications and implementation decisions                     |
