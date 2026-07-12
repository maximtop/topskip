# Development guide

This document explains how to set up a local environment, run builds and tests, and debug the TopSkip Chrome extension. For **shipping to the Chrome Web Store**, see [DEPLOYMENT.md](./DEPLOYMENT.md). For **code conventions and architecture**, see [AGENTS.md](./AGENTS.md). For a short **overview**, see [README.md](./README.md).

---

## Prerequisites

| Tool                            | Version / notes                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| **Node.js**                     | **20.x or newer** (`package.json` → `"engines": { "node": ">=20" }`)                          |
| **pnpm**                        | Package manager (`packageManager` in `package.json`; [install](https://pnpm.io/installation)) |
| **Git**                         | For cloning and version control                                                               |
| **Google Chrome** (or Chromium) | Required to load the **unpacked** extension from `dist/` during development                   |

Optional:

| Tool         | When                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| **GNU Make** | Optional convenience; all `make` targets call `pnpm run` (see [Makefile](./Makefile)) |

No `.env` file or database is required. Preferences use `browser.storage.local`.
The local backend retains analysis artifacts for 30 days in
`.topskip-data/analysis-artifacts.json` (ignored by Git and private to the
current user). Set `TOPSKIP_ARTIFACT_STORE_PATH` to store them elsewhere; remove
that file to clear local history.

---

## Getting started

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd extension
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

Output goes to **`dist/`** (Rspack: `background.js`, `content.js`, `popup.js`,
`options.js`, the caption-page bridge, HTML entry files, `manifest.json`, and
source maps).

### 3. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Choose the repository’s **`dist/`** directory (not the repo root)

After code changes, click **Reload** on the extension card, or run a fresh `make build` and reload again.

### 4. Watch mode (optional)

Rebuild on file changes:

```bash
pnpm run build:watch
```

### 5. Local server-mode backend (optional)

Run the loopback backend when exercising server-mode development:

```bash
pnpm run backend:dev
```

It listens on `http://127.0.0.1:8787`. The matching host permission is injected
only into development builds, so extension-only work and private BYOK testing do
not require this process. Public deployment and future correction work are
intentionally deferred; see
[SERVER_FIRST_FUTURE_WORK.md](./SERVER_FIRST_FUTURE_WORK.md).

Real YouTube timedtext access is disabled by default so local development does
not silently make outbound caption requests. Enable it deliberately when needed:

```bash
TOPSKIP_ENABLE_NETWORK_CAPTION_EXTRACTION=true pnpm run backend:dev
```

This sends the watched video ID to YouTube's caption endpoint. Fixture videos
continue to work without the opt-in.

---

## Project layout

| Path                | Role                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/background/`   | MV3 **service worker** — sole **`local` storage** access for prefs; Valibot; **`runtime.onMessage`**; broadcasts updates via **`tabs.sendMessage`**                             |
| `src/content/`      | **Content script** — `Content.init()` → `YoutubeWatch`; `skip-logic.ts` / `page-guards.ts` (pure); `youtube-watch.ts` (orchestration + runtime messaging, no storage for prefs) |
| `src/popup/`        | **React + Mantine + MobX** toolbar popup; **`preferences-store.ts`** (messaging to background only)                                                                             |
| `src/shared/`       | **`browser.ts`**, **Valibot** schema + constants, **`messages.ts`**, **`error.ts`** / **`valibot.ts`** (`getErrorMessage`, `extractMessageFromValiError`)                       |
| `src/public/`       | Static files copied into `dist/` (e.g. icons)                                                                                                                                   |
| `src/backend/`      | Local server-first API, caption extraction, analysis jobs, and durable artifacts                                                                                                |
| `dist/`             | **Build output** — load this folder as unpacked extension (gitignored)                                                                                                          |
| `e2e/`              | Playwright tests and `e2e/fixtures` static HTML                                                                                                                                 |
| `src/manifest.json` | Source manifest; **emitted into `dist/`** by the build                                                                                                                          |
| `.sdd/`             | SDD feature **spec.md** / **plan.md** (e.g. `.sdd/001-init-extension/` MVP baseline, dated folders per feature)                                                                 |

The bundler is **Rspack** (`rspack.config.ts`): background, content, popup,
options, and caption-page-bridge entries, with HTML plugins for popup and
options pages.

### Preferences and `browser.storage.local`

Only **`PrefsSyncStorage`** in **`src/background/storage/prefs-sync.ts`** reads or writes **`browser.storage.local`** for the `topskip:prefs` key (query: **`PrefsSyncStorage.load`**, command: **`PrefsSyncStorage.save`**). The service worker entry **`src/background/index.ts`** calls **`Background.init()`** from **`src/background/background.ts`**, which registers install + runtime messaging. Persisted objects are validated with **Valibot** (`userPreferencesSchema` in `src/shared/constants.ts`) — no unchecked casts on storage payloads.

The **popup** and **content** scripts must not call **`storage.local`** for preferences. They use **`browser.runtime.sendMessage`** with **`TOPSKIP_*`** message types from **`src/shared/messages.ts`**. After a successful update, the background notifies content scripts with **`TOPSKIP_PREFS_UPDATED`** via **`tabs.sendMessage`**, which requires the **`tabs`** permission in **`manifest.json`**.

---

## Commands reference

### Makefile targets

| Command              | What it runs                                                   |
| -------------------- | -------------------------------------------------------------- |
| `make setup`         | `pnpm install`                                                 |
| `make build`         | `pnpm run build`                                               |
| `make lint`          | `pnpm run lint`                                                |
| `make test`          | `pnpm run test:coverage` then `pnpm run test:e2e` (full suite) |
| `make test-unit`     | `pnpm run test` (Vitest, no coverage)                          |
| `make test-coverage` | `pnpm run test:coverage`                                       |
| `make test-e2e`      | `pnpm run test:e2e`                                            |

### pnpm scripts

| Script                                       | Description                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm run setup`                             | Same as `pnpm install`                                                               |
| `pnpm run build`                             | Production build to `dist/`                                                          |
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
| `pnpm run test:e2e:ui`                       | Playwright UI mode                                                                   |
| `pnpm run openrouter:compare-presets`        | Maintainer-only: same transcript → every built-in OpenRouter preset (see below)      |
| `pnpm run openrouter:extract-log-transcript` | Rebuild `[sec] text` user message from an exported caption `.log` (see below)        |

`pnpm run format` is the repo-wide formatter. `pnpm run lint` includes `format:check`, so CI enforces the same formatting as local development.

### Maintainer: compare preset models on one transcript

Use this **only** when you deliberately want **N** OpenRouter `chat/completions` calls (one per built-in preset in `src/shared/openrouter-model-presets.ts`). It does **not** run during normal video playback.

1. **Fixture input** — UTF-8 file in one of two shapes:
    - **Timed lines only**: `[12] caption text` per line (synthetic sample: `scripts/fixtures/promo-compare-110-lines.txt`).
    - **Full user body** (what the worker sends to OpenRouter): starts with `videoId=…` then `language=…` then a blank line then `[sec] lines`. For a **real** video, export the service worker log (with expanded caption chunk objects, not only `{…}`), then rebuild:

        ```bash
        pnpm run openrouter:extract-log-transcript -- tmp/logs/your-export.log \
          -o scripts/fixtures/promo-v3eXTAqGkzg-ru-from-console.log.txt \
          --video-id v3eXTAqGkzg --language ru
        ```

        See `scripts/fixtures/README.txt` for how to compare model JSON against a human baseline and notes on segment counts.

2. Put **`OPENROUTER_API_KEY=sk-or-…`** in **`extension/.env`** (gitignored), or export the variable in your shell. If both are set, the shell value wins.
3. From the `extension` directory on macOS:

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

3. **CI** (`.github/workflows/ci.yml`) on push/PR: **`pnpm install --frozen-lockfile`** → **lint** → **build** → **test** → **test:coverage** → **Playwright Chromium** → **`pnpm run test:e2e`** (e2e is **headless**; no Xvfb).
4. **Specs** — Larger behavior changes should align with `.sdd/001-init-extension/spec.md` / `plan.md` and relevant `.sdd/yyyymmdd-…` specs (update those docs in the same change when appropriate).

Detailed contribution rules live in [AGENTS.md](./AGENTS.md).

---

## Testing

### Unit tests (Vitest)

```bash
make test-unit
make test-coverage
```

Unit tests live under **`tests/`**, mirroring **`src/`** (e.g. `tests/content/skip-logic.test.ts` → `src/content/skip-logic.ts`). Coverage thresholds apply to **`skip-logic.ts`**, **`page-guards.ts`**, and **`src/popup/preferences-store.ts`** (see `vitest.config.ts`).

### Manual server-mode check

1. `make build`, load **`dist/`** unpacked (see [Getting started](#3-load-the-extension-in-chrome)).
2. Run the local backend; add `TOPSKIP_ENABLE_NETWORK_CAPTION_EXTRACTION=true`
   for a real-caption smoke test.
3. Open a `/watch` URL and verify the popup first reports server analysis and
   then a ready, unavailable, or no-promo terminal state.
4. For a ready result, let playback reach a detected block start and verify it
   skips only that future block once.
5. Switch to Private BYOK and open a new video; verify no server request occurs.

### Manual caption-capture smoke test

This flow depends on YouTube's live player and is not part of CI.

1. Run `pnpm run build`.
2. Reload `dist/` at `chrome://extensions`.
3. Open a YouTube watch page with known captions and turn YouTube captions off.
4. Confirm TopSkip is enabled.
5. In the extension service worker console, verify a captions payload arrives
   without visible subtitles flashing on the page.
6. Repeat with captions already on and verify TopSkip leaves them on.

Verbose manual-smoke logs are enabled by **`CAPTION_CAPTURE_VERBOSE_LOGS`** in
**`src/shared/constants.ts`**. In the service worker console, look for
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

**Default:** **`CAPTION_TRANSCRIPT_DEV_ENABLED`** is **`true`** in **`src/shared/constants.ts`**. On supported YouTube watch pages, TopSkip installs a MAIN-world bridge, briefly asks the player to activate captions when needed, observes the player's own successful `/api/timedtext?fmt=json3` response, parses it in the content script, and sends **`TOPSKIP_CAPTIONS_FROM_CONTENT`** to the background.

The production path no longer uses direct timedtext probing, direct InnerTube fallback clients, or fresh watch-page HTML scraping. The bridge preserves the page's fetch/XHR behavior, forwards caption bodies only to the internal parser pipeline, and keeps diagnostics to bounded metadata such as failure stage, language, body length, segment count, and sanitized timedtext parameter names.

**Trigger:** When TopSkip is enabled and the watch **video id** changes, **`WatchCaptions`** schedules **`PlayerCaptionCapture`**. The capture flow installs the bridge, waits through bounded activation retries if the player appears unstable or an ad is visible, then cleans up temporary caption state after success or timeout.

1. `make build`, load **`dist/`** unpacked.
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

Playwright starts a static server for **`e2e/fixtures`** (see `playwright.config.ts`, port **4173**). The extension manifest includes **`http://127.0.0.1:4173/*`** so the **content script** runs on the fixture page. Tests load the unpacked extension from **`dist/`** using **headless** Chromium by default; set **`PW_EXTENSION_HEADED=1`** when debugging (visible browser).

The fixture uses a **small vendored** silent MP4 (`e2e/fixtures/skip-test.mp4`, ~3 KiB, 120s) served from the same static root — **no network** required for e2e. The video is **muted** in HTML and tests (`muted` / `playsinline`) so playback does not emit sound. To regenerate the asset after changing duration/encoding, run:

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

| File                      | Purpose                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/log-server.ts`   | Node.js HTTP server on `127.0.0.1:9222`; writes timestamped lines to `debug.log` and stdout                                                                      |
| `src/shared/debug-log.ts` | `debugLog(source, message)` — fire-and-forget `fetch POST` to the log server; safe to call in any context (silently ignores failures when the server is offline) |
| `debug.log`               | Output file created by the server (gitignored)                                                                                                                   |

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
   bundles. `src/shared/debug-log.ts` itself stays in the repo so
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

| Task                          | Steps                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| **Iterate on UI (popup)**     | Edit `src/popup/*`, `make build`, reload extension on `chrome://extensions`                |
| **Iterate on content script** | Edit `src/content/*`, `make build`, reload extension **and** the YouTube tab               |
| **Add a unit test**           | Add `tests/.../*.test.ts` mirroring the `src/` path; run `pnpm run test`                   |
| **Debug failing CI locally**  | Run `pnpm install --frozen-lockfile`, then the same commands as `.github/workflows/ci.yml` |
| **Clean install**             | Remove `node_modules`, run `pnpm install --frozen-lockfile`                                |

---

## Troubleshooting

| Issue                                                 | What to try                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`make build` fails**                                | Ensure Node **≥ 20**; run `pnpm install`; check Rspack/TypeScript errors in the terminal                                                                                   |
| **Extension doesn’t update after edits**              | Run `make build` again; on `chrome://extensions`, click **Reload** on the extension; for content scripts, **reload the tab** (or close/reopen YouTube)                     |
| **Lint errors in IDE but not terminal**               | Run `pnpm run lint` from repo root (includes **`pnpm run lint:types`**). ESLint alone does not repeat every `tsc` error — the editor uses the TypeScript language service. |
| **`pnpm run test:e2e` fails (browser)**               | Run `pnpm exec playwright install chromium`                                                                                                                                |
| **`pnpm run test:e2e` times out / video never plays** | Confirm `e2e/fixtures/skip-test.mp4` exists; re-run `bash scripts/generate-e2e-fixture-video.sh` if needed                                                                 |
| **Port 4173 already in use**                          | Stop the other process using the port, or adjust `playwright.config.ts` `webServer` + manifest host if you must (keep them in sync)                                        |
| **Coverage fails after changes**                      | Run `pnpm run test:coverage` and add tests or adjust coverage scope in `vitest.config.ts` deliberately                                                                     |

---

## Additional resources

| Document                         | Purpose                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| [README.md](./README.md)         | Quick start and command table                                       |
| [AGENTS.md](./AGENTS.md)         | Architecture, conventions, what agents should not do                |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Zipping `dist/` and Chrome Web Store checklist (not day-to-day dev) |
