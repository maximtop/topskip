# AGENTS.md — TopSkip extension

Guidance for LLM agents and human contributors working on this repository.

## Project overview

**TopSkip** is a **Chrome Manifest V3** extension (MVP) that, when enabled, **automatically seeks** the main YouTube **watch** player from **0:30 → 1:00** on each video. Users can **disable** the behavior via a **toolbar popup** (React + Mantine + MobX). The on/off preference is persisted in **`browser.storage.sync`** only from the **background service worker**; validated with **Valibot** at read/write boundaries. The **popup** and **content** scripts use **`runtime.sendMessage`** to the background (no direct `storage` access for prefs).

There is **no backend** and **no `fetch()` to third-party APIs** in MVP — all logic is client-side. Extension APIs use the standardized **`browser.*`** surface via **`webextension-polyfill`** (import from **`src/shared/browser.ts`**, not the global `chrome` object). Feature intent and tasks live under **`specs/mvp/`** (`spec.md`, `plan.md`).

## Technical context

| Topic | Details |
|--------|---------|
| **Language** | TypeScript **5.x** (strict), **ESM** (`"type": "module"`) |
| **Runtime (tooling)** | **Node.js ≥ 20** (`engines` in `package.json`); **pnpm** for installs (`packageManager` in `package.json`) |
| **UI** | **React 19.2+** (required by Mantine 9), **Mantine 9.x** (`@mantine/core` / `@mantine/hooks` in `package.json`), **MobX 6** + **mobx-react-lite** (popup only) |
| **Bundler** | **Rspack** (`@rspack/cli`, `@rspack/core`) — multi-entry build to `dist/` |
| **Extension platform** | **Chrome** MV3 (`src/manifest.json` → `dist/manifest.json`); load unpacked from **`dist/`** |
| **Storage** | **`browser.storage.sync`** — **background only** (`webextension-polyfill`); **Valibot** `userPreferencesSchema` in `src/shared/constants.ts`; popup/content use **`runtime` messaging** (`src/shared/messages.ts`) |
| **Unit tests** | **Vitest** 4.x; coverage thresholds in `vitest.config.ts` (`skip-logic.ts`, `page-guards.ts`, `src/popup/preferences-store.ts`) |
| **E2E** | **Playwright** — loads unpacked extension + local static fixture (`e2e/`); **headless** Chromium by default (`PW_EXTENSION_HEADED=1` for a visible browser). CI runs **`pnpm run test:e2e`** (see `.github/workflows/ci.yml`) |
| **Lint** | **`pnpm run lint`** = ESLint + markdownlint + **`tsc --noEmit`** (`lint:types`). **ESLint** does not replace the full TypeScript checker — type errors appear in the editor from **`tsc`**; **`lint:types`** aligns CI/terminal with that. **markdownlint-cli2** (`.markdownlint.json`); **typescript-eslint**, **react-hooks**, **eslint-plugin-jsdoc** on `src/**`; **ESLint 10** exists, but **eslint-plugin-react-hooks** currently peers **ESLint ≤9** only, so the repo stays on **9.x** latest |
| **CI** | `.github/workflows/ci.yml` — **`pnpm install --frozen-lockfile`** → **lint** → **build** → **test** → **test:coverage** → Playwright Chromium → **`pnpm run test:e2e`** |
| **Project type** | Single-package repo (not a monorepo) |
| **Performance goals** | N/A beyond product spec (informal UX: skip soon after crossing 30s) |
| **Constraints** | Minimal extension permissions (`storage`, `tabs`, YouTube hosts); avoid shipping dev-only host entries (`127.0.0.1`) to the Web Store — see `DEPLOYMENT.md` |

## Project structure

```text
.
├── src/manifest.json          # MV3 source; emitted to dist/ by Rspack (service worker + content_scripts + action)
├── rspack.config.ts           # Entries: background, content, popup; HtmlRspackPlugin for popup.html
├── tsconfig.json              # Strict TS; path alias @/* → src/*
├── eslint.config.ts
├── vitest.config.ts
├── playwright.config.ts       # webServer serves e2e/fixtures; baseURL 127.0.0.1:4173
├── Makefile                   # setup, build, lint, test, test-unit, test-coverage, test-e2e
├── package.json
├── pnpm-lock.yaml
├── specs/mvp/            # spec.md, plan.md (feature source of truth)
├── src/
│   ├── background/
│   │   ├── index.ts         # `Background.init()` only (bundle entry)
│   │   ├── background.ts    # class `Background` — `static init()` wires lifecycle + messaging
│   │   ├── storage/         # `PrefsSyncStorage` — static-only class (namespace) for `sync` prefs
│   │   ├── messaging/       # `PrefsRuntimeMessages`, `PrefsBroadcast` — static-only classes
│   │   └── lifecycle/       # `BackgroundInstallLifecycle`
│   ├── content/
│   │   ├── index.ts           # `Content.init()` only (bundle entry)
│   │   ├── content.ts         # class `Content` — `static init()` gates URL, then `YoutubeWatch.init()`
│   │   ├── youtube-watch.ts   # class `YoutubeWatch` — watch binding, `timeupdate`, messaging, SPA hooks, toast
│   │   ├── skip-logic.ts      # Pure skip / seek-heuristic logic (unit-tested)
│   │   └── page-guards.ts     # URL rules: watch vs Shorts vs e2e host (unit-tested)
│   ├── popup/                 # `main.tsx` → `Popup.init()` only; `popup.tsx` (class `Popup`), PopupApp, preferences-store, index.html
│   └── shared/
│       ├── browser.ts         # `webextension-polyfill` default export (`browser.*` API)
│       ├── constants.ts     # `SKIP_START_SEC` / `SKIP_END_SEC`, storage key, Valibot `userPreferencesSchema`, `UserPreferences`
│       ├── error.ts         # `getErrorMessage` (ValiError → `extractMessageFromValiError`, else `Error` / string)
│       ├── messages.ts    # `TOPSKIP_*` runtime message types (popup/content ↔ background)
│       └── valibot.ts       # `extractMessageFromValiError` (`summarize` on `ValiError.issues`)
├── src/public/                # Optional static assets copied into dist/ (e.g. icons)
├── tests/                     # Vitest unit tests (mirrors `src/**` layout)
├── e2e/                       # Playwright tests + static video fixture
└── dist/                      # Build output (gitignored) — **load this** as unpacked extension
```

## Build and test commands

Prefer **`make`** targets; they delegate to **`pnpm run`**.

| Action | Command |
|--------|---------|
| Install deps | `make setup` or `pnpm install` |
| Production build | `make build` or `pnpm run build` |
| Watch build | `pnpm run build:watch` |
| Lint | `make lint` or `pnpm run lint` |
| Full tests (coverage + E2E) | `make test` — runs `test:coverage` then `test:e2e` (run **`make build`** before E2E) |
| Unit tests only | `make test-unit` or `pnpm run test` |
| Unit + coverage only | `make test-coverage` or `pnpm run test:coverage` |
| E2E only | `make test-e2e` or `pnpm run test:e2e` (vendored silent MP4 in `e2e/fixtures/`) |
| E2E UI mode | `pnpm run test:e2e:ui` |

**CI (GitHub Actions)** matches: `pnpm run lint`, `pnpm run build`, `pnpm run test`, `pnpm run test:coverage`, then `pnpm exec playwright install chromium --with-deps`, then **`pnpm run test:e2e`**.

There is **no** repo-wide formatter (no Prettier script). Rely on ESLint + editor formatting.

## Contribution instructions

1. **Read** `specs/mvp/spec.md` and `specs/mvp/plan.md` before large changes; align with them or update the spec in the same PR when behavior changes.
2. **Branch / PR**: Conventional practice — small PRs; describe *what* and *why*.
3. **Before pushing**, run locally (or rely on CI):
   - `pnpm install` (or `pnpm install --frozen-lockfile` to match CI)
   - `pnpm run lint`
   - `pnpm run build`
   - `pnpm run test`
   - `pnpm run test:coverage` (if you touch covered modules)
   - `pnpm exec playwright install chromium` (once per machine, if needed)
   - `pnpm run test:e2e`
4. **Do not** add network dependencies to the extension runtime for MVP without an explicit spec change.
5. **Chrome Web Store**: Before release, review `DEPLOYMENT.md` (zip `dist/` only; trim dev-only manifest matches if needed).

## Code guidelines

### Architecture

- **Three bundles** — `background.js`, `content.js`, `popup.js`. Any new entry requires **`rspack.config.ts`** + **`src/manifest.json`** updates.
- **Separation**: Pure logic in **`skip-logic.ts`** and **`page-guards.ts`**; DOM + `browser.runtime` messaging in **`YoutubeWatch`** (`youtube-watch.ts`); **popup** prefs via **`src/popup/preferences-store.ts`** (messages only); **only `PrefsSyncStorage`** performs **`browser.storage.sync`** read/write for preferences. **Content** (`content.ts`), **background** (`background.ts`), and **popup** (`popup.tsx`) use static-only entry classes; bundle entries **`index.ts`** / **`main.tsx`** only call **`Content.init()`** / **`Background.init()`** / **`Popup.init()`** (no other side effects at load).
- **Imports**: Use **`@/...`** alias mapping to `src/` (see `tsconfig.json`).
- **Content script** matches YouTube + local e2e origin; **activation** for real users is gated in code via **`shouldActivateTopSkip`** (`page-guards.ts`), not only by broad manifest patterns.

### Code quality

- **TypeScript strict** — avoid `any`; prefer explicit types for public APIs.
- **Avoid `as` (type assertions)** except where unavoidable (e.g. interop with untyped data). Prefer **`satisfies`**, **narrowing** (`typeof`, `in`, **`Reflect.get` + `unknown`** checks), **typed helpers**, or **APIs that match the declared types** — e.g. `browser.runtime.onMessage` handlers as **`async` functions** that return a **`Promise`** (MV3) instead of `sendResponse` + `return true` plus a cast to `OnMessageListener`.
- **Structure**: Prefer **classes used as namespaces** (static methods and/or grouping related behavior) over loose **top-level functions** when adding non-trivial logic — keeps call sites and imports predictable; pure utilities may stay as functions (e.g. `skip-logic.ts`).
- **JSDoc**: Under `src/`, use **multi-line** `/** … */` blocks only (`jsdoc/multiline-blocks` — no single-line blocks). Document **`@param`** for each parameter and **`@returns`** when the function returns a value; **async** functions must include **`@returns`** (including `Promise<void>`), per `jsdoc/require-param` / `jsdoc/require-returns` / `forceReturnsWithAsync`. Every **function declaration** and **class method** still needs a block (`jsdoc/require-jsdoc`). Object parameters may use a single **`@param`** for the root (`checkDestructuredRoots: false`).
- **MobX**: `PreferencesStore` for popup; use `runInAction` where async flows update observables (see existing store).
- **React**: Functional components; Mantine only in popup — **do not** import Mantine into content/background bundles (keeps `content.js` lean).
- **Bundle size**: Popup already includes full Mantine CSS; avoid extra UI libraries in the popup without justification.

### Testing

- **Vitest** (`tests/**` mirrors `src/**`, e.g. `tests/popup/preferences-store.test.ts`): mock **`@/shared/browser`** for store tests; keep **`skip-logic`** / **`page-guards`** free of browser globals.
- **Playwright**: Build first; tests load **`dist/`** as unpacked extension. Prefer fixture URLs over live YouTube when possible.
- **Coverage**: Config enforces thresholds on selected files — if you add substantial logic, extend tests or adjust `vitest.config.ts` coverage `include` deliberately.

### Other

- **`TODO.md`**: Backlog / ideas — not binding spec.
- **Documentation**: `README.md` (onboarding), `DEVELOPMENT.md` (deep dive), `DEPLOYMENT.md` (release).
