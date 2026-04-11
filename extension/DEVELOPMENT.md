# Development guide

This document explains how to set up a local environment, run builds and tests, and debug the TopSkip Chrome extension. For **shipping to the Chrome Web Store**, see [DEPLOYMENT.md](./DEPLOYMENT.md). For **code conventions and architecture**, see [AGENTS.md](./AGENTS.md). For a short **overview**, see [README.md](./README.md).

---

## Prerequisites

| Tool | Version / notes |
|------|------------------|
| **Node.js** | **20.x or newer** (`package.json` → `"engines": { "node": ">=20" }`) |
| **pnpm** | Package manager (`packageManager` in `package.json`; [install](https://pnpm.io/installation)) |
| **Git** | For cloning and version control |
| **Google Chrome** (or Chromium) | Required to load the **unpacked** extension from `dist/` during development |

Optional:

| Tool | When |
|------|------|
| **GNU Make** | Optional convenience; all `make` targets call `pnpm run` (see [Makefile](./Makefile)) |

No `.env` file or database is required — the MVP uses only `chrome.storage.sync` in the browser.

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

Output goes to **`dist/`** (Rspack: `background.js`, `content.js`, `popup.js`, `popup.html`, `manifest.json`, source maps).

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

---

## Project layout

| Path | Role |
|------|------|
| `src/background/` | MV3 **service worker** — sole **`sync` storage** access for prefs; Valibot; **`runtime.onMessage`**; broadcasts updates via **`tabs.sendMessage`** |
| `src/content/` | **Content script** — `Content.init()` → `YoutubeWatch`; `skip-logic.ts` / `page-guards.ts` (pure); `youtube-watch.ts` (orchestration + runtime messaging, no storage for prefs) |
| `src/popup/` | **React + Mantine + MobX** toolbar popup; **`preferences-store.ts`** (messaging to background only) |
| `src/shared/` | **`browser.ts`**, **Valibot** schema + constants, **`messages.ts`**, **`error.ts`** / **`valibot.ts`** (`getErrorMessage`, `extractMessageFromValiError`) |
| `src/public/` | Static files copied into `dist/` (e.g. icons) |
| `dist/` | **Build output** — load this folder as unpacked extension (gitignored) |
| `e2e/` | Playwright tests and `e2e/fixtures` static HTML |
| `src/manifest.json` | Source manifest; **emitted into `dist/`** by the build |
| `specs/mvp/` | Feature **spec.md** / **plan.md** |

The bundler is **Rspack** (`rspack.config.ts`): three entries (`background`, `content`, `popup`), `HtmlRspackPlugin` for `popup.html`.

### Preferences and `browser.storage.sync`

Only **`PrefsSyncStorage`** in **`src/background/storage/prefs-sync.ts`** reads or writes **`browser.storage.sync`** for the `topskip:prefs` key (query: **`PrefsSyncStorage.load`**, command: **`PrefsSyncStorage.save`**). The service worker entry **`src/background/index.ts`** calls **`Background.init()`** from **`src/background/background.ts`**, which registers install + runtime messaging. Persisted objects are validated with **Valibot** (`userPreferencesSchema` in `src/shared/constants.ts`) — no unchecked casts on storage payloads.

The **popup** and **content** scripts must not call **`storage.sync`** for preferences. They use **`browser.runtime.sendMessage`** with **`TOPSKIP_*`** message types from **`src/shared/messages.ts`**. After a successful update, the background notifies content scripts with **`TOPSKIP_PREFS_UPDATED`** via **`tabs.sendMessage`**, which requires the **`tabs`** permission in **`manifest.json`**.

---

## Commands reference

### Makefile targets

| Command | What it runs |
|---------|----------------|
| `make setup` | `pnpm install` |
| `make build` | `pnpm run build` |
| `make lint` | `pnpm run lint` |
| `make test` | `pnpm run test:coverage` then `pnpm run test:e2e` (full suite) |
| `make test-unit` | `pnpm run test` (Vitest, no coverage) |
| `make test-coverage` | `pnpm run test:coverage` |
| `make test-e2e` | `pnpm run test:e2e` |

### pnpm scripts

| Script | Description |
|--------|-------------|
| `pnpm run setup` | Same as `pnpm install` |
| `pnpm run build` | Production build to `dist/` |
| `pnpm run build:watch` | Rspack watch mode |
| `pnpm run lint` | ESLint + **markdownlint** + **`tsc --noEmit`** (`eslint.config.ts`, `.markdownlint.json`, `tsconfig.json`) |
| `pnpm run lint:md` | **markdownlint-cli2** on `**/*.md` (excludes `node_modules`, `dist`, `coverage`) |
| `pnpm run lint:types` | **TypeScript** — full project typecheck (`tsc --noEmit`, same as editor diagnostics) |
| `pnpm run test` | Vitest once (`vitest run`) |
| `pnpm run test:watch` | Vitest watch mode |
| `pnpm run test:coverage` | Vitest with coverage (thresholds in `vitest.config.ts`) |
| `pnpm run test:e2e` | Playwright (headless extension; set `PW_EXTENSION_HEADED=1` for headed) |
| `pnpm run test:e2e:ui` | Playwright UI mode |

There is **no** `format` script — formatting is left to the editor; **lint** is the enforced check.

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
4. **Specs** — Larger behavior changes should align with `specs/mvp/spec.md` / `plan.md` (update those docs in the same change when appropriate).

Detailed contribution rules live in [AGENTS.md](./AGENTS.md).

---

## Testing

### Unit tests (Vitest)

```bash
make test-unit
make test-coverage
```

Unit tests live under **`tests/`**, mirroring **`src/`** (e.g. `tests/content/skip-logic.test.ts` → `src/content/skip-logic.ts`). Coverage thresholds apply to **`skip-logic.ts`**, **`page-guards.ts`**, and **`src/popup/preferences-store.ts`** (see `vitest.config.ts`).

### Manual check on real YouTube

1. `make build`, load **`dist/`** unpacked (see [Getting started](#3-load-the-extension-in-chrome)).
2. Open a **`/watch`** URL with a video **longer than one minute**.
3. Let playback pass **0:30** — the player should jump to **1:00** and show a small **“Skip applied”** toast.
4. Open the extension **popup** and turn the **switch off** — on another long video, playback should **not** jump at 0:30.
5. Turn the switch **on** again **before** 0:30 — the jump at 0:30 should return.

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

## Common tasks

| Task | Steps |
|------|--------|
| **Iterate on UI (popup)** | Edit `src/popup/*`, `make build`, reload extension on `chrome://extensions` |
| **Iterate on content script** | Edit `src/content/*`, `make build`, reload extension **and** the YouTube tab |
| **Add a unit test** | Add `tests/.../*.test.ts` mirroring the `src/` path; run `pnpm run test` |
| **Debug failing CI locally** | Run `pnpm install --frozen-lockfile`, then the same commands as `.github/workflows/ci.yml` |
| **Clean install** | Remove `node_modules`, run `pnpm install --frozen-lockfile` |

---

## Troubleshooting

| Issue | What to try |
|--------|-------------|
| **`make build` fails** | Ensure Node **≥ 20**; run `pnpm install`; check Rspack/TypeScript errors in the terminal |
| **Extension doesn’t update after edits** | Run `make build` again; on `chrome://extensions`, click **Reload** on the extension; for content scripts, **reload the tab** (or close/reopen YouTube) |
| **Lint errors in IDE but not terminal** | Run `pnpm run lint` from repo root (includes **`pnpm run lint:types`**). ESLint alone does not repeat every `tsc` error — the editor uses the TypeScript language service. |
| **`pnpm run test:e2e` fails (browser)** | Run `pnpm exec playwright install chromium` |
| **`pnpm run test:e2e` times out / video never plays** | Confirm `e2e/fixtures/skip-test.mp4` exists; re-run `bash scripts/generate-e2e-fixture-video.sh` if needed |
| **Port 4173 already in use** | Stop the other process using the port, or adjust `playwright.config.ts` `webServer` + manifest host if you must (keep them in sync) |
| **Coverage fails after changes** | Run `pnpm run test:coverage` and add tests or adjust coverage scope in `vitest.config.ts` deliberately |

---

## Additional resources

| Document | Purpose |
|----------|---------|
| [README.md](./README.md) | Quick start and command table |
| [AGENTS.md](./AGENTS.md) | Architecture, conventions, what agents should not do |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Zipping `dist/` and Chrome Web Store checklist (not day-to-day dev) |
