# AGENTS.md — TopSkip workspace

Guidance for LLM agents and human contributors working on this repository.

## Project overview

**TopSkip** is a pnpm workspace containing an analysis backend, shared
contracts, and a **Chrome Manifest V3** extension. Server mode captures timed
captions through the YouTube player and uploads them through the extension
background; the backend validates them, analyzes promo blocks, and reuses only
exact transcript results. This extension upload path is the default local and
production source; retained yt-dlp extraction is operator-only and never a
fallback. Private BYOK keeps analysis in the extension and
makes zero TopSkip analysis or registration requests. There is **no fixed
30s→60s window**.

Users control the extension from the **toolbar popup** (React + Mantine + MobX)
and options page. Preferences and provider settings are read/written **only in
the extension background** (`browser.storage.local`, **Valibot** at boundaries);
popup, options, and content scripts use **`runtime.sendMessage`**.

The service worker may **`fetch` OpenRouter** in BYOK mode. Extension APIs use
the standardized **`browser.*`** surface via **`webextension-polyfill`** (import
from **`extension/src/shared/browser.ts`**, not the global `chrome` object).
Feature intent and dated feature specs live under **`.sdd/`**.

## Technical context

| Topic                  | Details                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language**           | TypeScript **5.x** (strict), **ESM** (`"type": "module"`)                                                                                                                                                                                                                                                                                                                                      |
| **Runtime (tooling)**  | **Node.js ≥ 22** (`engines` in `package.json`); **pnpm** for installs (`packageManager` in `package.json`)                                                                                                                                                                                                                                                                                     |
| **UI**                 | **React 19.2+** (required by Mantine 9), **Mantine 9.x** (`@mantine/core` / `@mantine/hooks` in `package.json`), **MobX 6** + **mobx-react-lite** (popup only)                                                                                                                                                                                                                                 |
| **Bundler**            | **Rspack** (`@rspack/cli`, `@rspack/core`) — multi-entry build to `extension/dist/`                                                                                                                                                                                                                                                                                                            |
| **Extension platform** | **Chrome** MV3 (`extension/src/manifest.json` → `extension/dist/manifest.json`); load unpacked from **`extension/dist/`**                                                                                                                                                                                                                                                                      |
| **Storage**            | **`browser.storage.local`** — prefs + OpenRouter config, **background only**; **Valibot** in `extension/src/shared/constants.ts` and OpenRouter schema; popup/options/content use **`runtime` messaging** (`extension/src/shared/messages.ts`)                                                                                                                                                 |
| **Unit tests**         | **Vitest** 4.x; coverage thresholds in `vitest.config.ts` (`skip-logic.ts`, `page-guards.ts`, `extension/src/popup/preferences-store.ts`)                                                                                                                                                                                                                                                      |
| **E2E**                | **Playwright** — loads unpacked extension + local static fixture (`extension/e2e/`); **headless** Chromium by default (`PW_EXTENSION_HEADED=1` for a visible browser). CI runs **`pnpm run test:e2e`** (see `.github/workflows/ci.yml`)                                                                                                                                                        |
| **Lint / format**      | **`pnpm run lint`** = **oxfmt** check + **oxlint** + ESLint parity + markdownlint + **`tsc --noEmit`** (`lint:types`). **oxfmt** owns formatting (`pnpm run format`; `.oxfmtrc.json`, 4-space indent). **ESLint** remains because oxlint does not yet cover local/custom policy such as `local/no-plain-block-comments`; **lint:types** aligns CI/terminal with editor TypeScript diagnostics. |
| **CI**                 | `.github/workflows/ci.yml` — **`pnpm install --frozen-lockfile`** → **lint** → **build** → deployment asset tests → **test** → **test:coverage** → Playwright Chromium → **`pnpm run test:e2e`**                                                                                                                                                                                               |
| **Project type**       | pnpm workspace: `backend`, `common`, and `extension`                                                                                                                                                                                                                                                                                                                                           |
| **Performance goals**  | N/A beyond product spec (informal UX: skip soon after crossing 30s)                                                                                                                                                                                                                                                                                                                            |
| **Constraints**        | Permissions include `storage`, `tabs`, `scripting`; host access for YouTube and optional **OpenRouter**; avoid shipping dev-only host entries (`127.0.0.1`) to the Web Store — see `extension/DEPLOYMENT.md`                                                                                                                                                                                   |

## Project structure

```text
.
├── backend/
│   ├── src/                  # HTTP API, extraction, analysis, jobs, artifacts
│   └── tests/                # Backend tests
├── common/
│   ├── src/                  # Pure cross-runtime contracts, schemas, and types
│   └── tests/                # Contract and helper tests
├── extension/
│   ├── src/
│   │   ├── background/       # MV3 service worker and extension-owned I/O
│   │   ├── content/          # YouTube page integration and seek orchestration
│   │   ├── options/          # React options page
│   │   ├── popup/            # React + Mantine + MobX toolbar UI
│   │   └── shared/           # Extension-only cross-bundle types and helpers
│   ├── tests/                # Extension unit tests
│   ├── e2e/                  # Playwright tests and fixture
│   ├── rspack.config.ts
│   └── dist/                 # Load this unpacked in Chrome
├── .sdd/                     # Cross-cutting feature specifications
├── package.json              # Workspace commands and development tooling
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.json
└── vitest.config.ts
```

## Build and test commands

Prefer **`make`** targets; they delegate to **`pnpm run`**.

| Action                | Command                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Install deps          | `make setup` (pnpm dependencies only)                                                     |
| Production build      | `make build` or `pnpm run build`                                                          |
| Local backend         | `make server` (default `extension_upload`; no `yt-dlp` required)                          |
| Watch extension build | `make extension` or `pnpm run build:watch`                                                |
| Lint                  | `make lint` or `pnpm run lint`                                                            |
| Full tests            | `make test` — runs coverage, deployment assets, then E2E (build before E2E)               |
| Unit tests only       | `make test-unit` or `pnpm run test`                                                       |
| Unit + coverage only  | `make test-coverage` or `pnpm run test:coverage`                                          |
| Deployment assets     | `make test-deployment` or `pnpm run test:deployment`                                      |
| Production container  | `make test-container` or `pnpm run test:container`                                        |
| E2E only              | `make test-e2e` or `pnpm run test:e2e` (vendored silent MP4 in `extension/e2e/fixtures/`) |
| E2E UI mode           | `pnpm run test:e2e:ui`                                                                    |

**CI (GitHub Actions)** matches: `pnpm run lint`, `pnpm run build`, `pnpm run test:deployment`, `pnpm run test:container`, `pnpm run test`, `pnpm run test:coverage`, then `pnpm exec playwright install chromium --with-deps`, **`pnpm run test:e2e`**, and the release-package boundary check.

Use **`pnpm run format`** for repo-wide formatting. `pnpm run lint` includes `format:check`, oxlint, ESLint parity checks, markdownlint, and TypeScript.

## Contribution instructions

1. **Read** `.sdd/001-init-extension/spec.md` and `.sdd/001-init-extension/plan.md` (baseline MVP) and any active `.sdd/yyyymmdd-…` spec for the feature you touch; align or update those docs in the same PR when behavior changes.
2. **Branch / PR**: Conventional practice — small PRs; describe _what_ and _why_.
3. **Before pushing**, run locally (or rely on CI):
    - `pnpm install` (or `pnpm install --frozen-lockfile` to match CI)
    - `pnpm run lint`
    - `pnpm run build`
    - `pnpm run test`
    - `pnpm run test:coverage` (if you touch covered modules)
    - `pnpm exec playwright install chromium` (once per machine, if needed)
    - `pnpm run test:e2e`
4. **Do not** add network dependencies to the extension runtime for MVP without an explicit spec change.
5. **Chrome Web Store**: Before release, review `extension/DEPLOYMENT.md` (zip `extension/dist/` only; trim dev-only manifest matches if needed).

## Code guidelines

### Architecture

- **Three bundles** — `background.js`, `content.js`, `popup.js`. Any new entry requires **`extension/rspack.config.ts`** + **`extension/src/manifest.json`** updates.
- **Separation**: Pure logic in **`skip-logic.ts`** and **`page-guards.ts`**; DOM + `browser.runtime` messaging in **`YoutubeWatch`** (`youtube-watch.ts`); **popup** prefs via **`extension/src/popup/preferences-store.ts`** (messages only); **only `PrefsSyncStorage`** performs **`browser.storage.local`** read/write for preferences. **Content** (`content.ts`), **background** (`background.ts`), and **popup** (`popup.tsx`) use static-only entry classes; bundle entries **`index.ts`** / **`main.tsx`** only call **`Content.init()`** / **`Background.init()`** / **`Popup.init()`** (no other side effects at load).
- **Prefs fan-out after writes**: The watch content script caches prefs in memory and does **not** re-read storage on navigation or idle. Whenever the background persists a prefs change (`PrefsSyncStorage.save` path), also call **`PrefsBroadcast.sendUpdatedToAllTabs`** so open tabs receive **`TOPSKIP_MESSAGE.PREFS_UPDATED`** without a full page reload. Extension UI (popup/options) uses **`PrefsPortHub`** for the same event over ports; keep those two paths in sync when adding new prefs fields.
- **Promo detection UI push**: **`PromoDetectionStore`** is in-memory in the background; the popup reads it via **`GET_DETECTION_STATUS`** and also polls. After **`PromoDetectionStore.set`**, **`PromoDetectionBroadcast.notify`** sends **`TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED`** with **`runtime.sendMessage`** so an open popup can refresh immediately instead of waiting for the next poll. Content scripts are not the audience for this message (they receive promo blocks on a different channel).
- **Imports**: Use **`@/...`** inside the extension, **`@topskip/backend/...`**
  inside the backend, and **`@topskip/common/...`** for shared contracts.
- **Backend HTTP ownership**: The watch content script never calls the TopSkip
  backend directly. For Server mode it may only send the non-network
  `SERVER_ANALYSIS_SESSION_EVENT`, `REQUEST_SERVER_ANALYSIS` with validated
  timed captions, and `REFRESH_SERVER_ANALYSIS_STATUS` runtime messages. Only
  the background service worker may import the backend client or `fetch` the
  TopSkip backend; authentication, exact local-cache lookup, timeout handling,
  response validation, polling response mapping, and support URLs remain
  background-owned. Do not add TopSkip backend `fetch` calls to content code.
- **Content script** matches YouTube + local e2e origin; **activation** for real users is gated in code via **`shouldActivateTopSkip`** (`page-guards.ts`), not only by broad manifest patterns.
- **Simple abstractions over repeated branching**: Keep code simple by making variation explicit in data/config/registry maps instead of scattering repeated `if` / `switch` chains across handlers and UI. A one-off conditional is fine, but when the same choice affects multiple behaviors (load/save/test/label/render/routing), define a small typed abstraction for those behaviors and keep the orchestration generic.
- **`extension/src/shared/`**: Reserve for **constants**, **shared types**, **`browser`**, **message type unions**, and **pure helpers** (deterministic, no network/storage/timers/`console` side effects). Do **not** put modules that perform **I/O** or other ambient side effects in `shared/` — keep those next to the bundle that owns them (e.g. YouTube **`fetch`** lives under **`extension/src/content/captions/`**, not `shared/`). Likewise, **interfaces consumed by a single bundle** (e.g. the `LlmProviderAdapter` interface and provider registry, used only by the background promo-detection pipeline) belong in that bundle's directory (`extension/src/background/`), not in `shared/`. Only the serialized payload types that cross bundle boundaries via `runtime.sendMessage` (provider ID literals, display names) go in `extension/src/shared/messages.ts`.
- **`common/src/`**: Keep only deterministic code consumed by both runtime
  packages: serialized API contracts, validation schemas, shared promo/caption
  types, and pure helpers. No network, storage, timers, DOM, or logging.

### Code quality

- **TypeScript only** — every source file must be **`.ts`** (or **`.tsx`** for React). Do **not** create **`.js`** or **`.mjs`** files; use **`tsx`** (already a devDependency) to run standalone scripts (e.g. `pnpm tsx scripts/log-server.ts`). The only non-TS files in the repo are config files that tooling requires in JS form (e.g. `Makefile`, shell scripts).
- **TypeScript strict** — avoid `any`; prefer explicit types for public APIs.
- **Avoid `as` (type assertions)** — linting enforces `consistent-type-assertions` (`assertionStyle: 'as'`, `objectLiteralTypeAssertions: 'never'`) on all `extension/src/` files. Beyond that rule, follow these additional constraints:
    - **Allowed exceptions** (each site must have a brief comment explaining why):
        - `as const` — literal narrowing; no comment required.
        - `JSON.parse(s) as unknown` / `(await res.json()) as unknown` — tames `any` from untyped APIs; the `as unknown` form is intentional and correct.
        - Final cast at a **validated boundary** (immediately after a Valibot `v.parse` / `v.safeParse` call, or after a user-defined type guard that already proved the shape).
        - XState `setup({ types: { context: {} as Ctx, events: {} as Ev } })` — the framework idiom; no alternative exists.
        - Re-exports: `import { x as Y }` — module aliasing, not a type assertion.
    - **Disallowed patterns — use these alternatives instead**:
        - `(value as Record<string, unknown>)['key']` → narrow to an object shape first, then prefer direct property access (`value.key`) when TypeScript can prove the field with `in` checks or a type predicate. Use `Reflect.get(value, 'key')` only when the property name is dynamic or direct access cannot be narrowed cleanly.
        - `arr.filter(isThing) as Thing[]` → make `isThing` a user-defined type predicate (`(x: unknown): x is Thing`) so `filter` narrows automatically.
        - `obj as SomethingWithHiddenField` to attach runtime metadata to a DOM element → use a module-scoped `WeakMap<DomElement, Metadata>` keyed by the element.
        - `response.json() as SomeConcreteShape` (when shape is not `unknown`) → parse to `unknown` first, then validate with Valibot.
        - `JSON.parse(s) as SomeConcreteShape` (same as above).
        - `(x as SomeInterface).prop` where `x` is `unknown` → narrow with `typeof`, `in`, or a user-defined type predicate before reading the property; prefer direct property access after narrowing. Use `Reflect.get` only for dynamic keys or global/prototype-sensitive lookups.
        - `globalThis as typeof globalThis & { foo: Bar }` → use `Reflect.get(globalThis, 'foo')` and narrow the result.
- **Structure**: Prefer **classes used as namespaces** (exported class, related helpers as **`private static`**, public entry points as **`static`**) over loose **top-level functions** when a file groups several steps of one concern — call sites read as `ClassName.method` and imports stay one symbol. Do **not** add an **empty** constructor: **`@typescript-eslint/no-empty-function`** rejects `constructor() {}` (including `private constructor() {}`). Omit the constructor and document “static API only” in the class JSDoc; `new` remains possible at compile time but is discouraged by convention. _Maintainer preference_: use this pattern for new background messaging–style modules; small single-purpose pure files may still use top-level functions (e.g. `skip-logic.ts`).
- **Control flow — guards over nesting**: Prefer **early returns** and **guard clauses** (handle invalid / edge cases first, then the main path) so the happy path stays shallow instead of growing rightward inside nested `if` blocks. ESLint enforces related limits: **`max-depth`** (max block nesting **5**) and **`no-else-return`** (no redundant `else` after a branch that returns). There is no rule that literally requires “guard style” for every function; depth and `else` removal are what the linter can check.
- **JSDoc**: Under every package's `src/`, use **multi-line** `/** … */` blocks only (`jsdoc/multiline-blocks` — no single-line blocks). Each block needs a **short summary** (prose before any tag), not only `@param` and `@returns` lines (`jsdoc/require-description`, `descriptionStyle: body`). Document **`@param`** for each parameter and **`@returns`** when the function returns a value; **async** functions must include **`@returns`** (including `Promise<void>`), per `jsdoc/require-param` / `jsdoc/require-returns` / `forceReturnsWithAsync`. Every **function declaration** and **class method** still needs a block (`jsdoc/require-jsdoc`); **class fields** (`PropertyDefinition`, including `static` and instance properties) and **type aliases** (`TSTypeAliasDeclaration`) also require a JSDoc block via the same rule’s **`contexts`**. Object parameters may use a single **`@param`** for the root (`checkDestructuredRoots: false`). When tightening a documentation rule, update lint config and fix existing violations in the same change so `pnpm run lint` stays green.
- **Comments — explain _why_, not _what_**: Inline comments (`//`) and JSDoc descriptions should explain the **reason** or **constraint** behind the code, not restate what the code already says. A reader can see _what_ the code does; the comment's job is to say _why_ it does it. Good: `// Must import after mock setup so vi.mock takes effect`. Bad: `// Simulate connection`. Apply the same standard to JSDoc summaries — describe the purpose or the problem solved, not just "does X".
- **Spec-shaped behavior in code**: When implementing requirements from `.sdd/`, describe the **actual constraint or invariant** in JSDoc or brief comments (what the code guarantees and why). Do **not** paste spec file paths or internal requirement labels (e.g. **FR-00x**) into `extension/src/` — paths move or disappear, and requirement IDs go stale when duplicated outside the spec.
- **MobX**: `PreferencesStore` for popup; use `runInAction` where async flows update observables (see existing store).
- **React**: Functional components; Mantine only in popup — **do not** import Mantine into content/background bundles (keeps `content.js` lean).
- **UI text / i18n**: User-visible strings in popup/options/content UI must come from `_locales/*/messages.json` through `translator.getMessage(...)` / the project i18n helpers. Do not hardcode labels, placeholders, button text, status badges, helper copy, or validation success/failure text in React components. Brand/provider names may use shared constants such as `PROVIDER_LABEL.*`, and dynamic model slugs/IDs remain raw data. When adding a new key, add it to every locale file; if translations are not available, use the English source string consistently so lookups never render empty after i18n initialization.
- **Bundle size**: Popup already includes full Mantine CSS; avoid extra UI libraries in the popup without justification.
- **No magic literals**: Do not repeat magic strings or magic numbers with semantic meaning. Extract them into a named `const` with a descriptive, `UPPERCASE_SNAKE_CASE` name. Where constants live:
    - Pure cross-bundle values (e.g. YouTube base URLs, unit-conversion factors, Prompt API global identifiers) → `extension/src/shared/constants.ts` or a small dedicated `extension/src/shared/*.ts` module (e.g. `chromepromptapi.ts`).
    - Bundle-specific values (e.g. DOM selectors, UI timings, popup polling intervals) → co-located module in the bundle directory (e.g. `extension/src/content/youtubedom.ts`, `extension/src/popup/constants.ts`).
    - External-API identifiers (global names, method names, event names, state strings) must be centralized the first time they're referenced in a second call site — see `extension/src/shared/chromepromptapi.ts`.
    - Time and percentage arithmetic should use `MS_PER_SECOND`, `SECONDS_PER_MINUTE`, `SECONDS_PER_HOUR`, `PERCENT_SCALE` instead of inline `1000` / `60` / `3600` / `100` where the literal represents the conversion factor.
    - Exceptions: trivial literals with a single local use (e.g. `.slice(0, 1)`, `index + 1`), tightly-scoped tuning constants already named in the same function (e.g. a loop increment), and literals already covered by a TS union/enum.

### Testing

- **Vitest** (`extension/tests/**` mirrors `extension/src/**`, e.g. `extension/tests/popup/preferences-store.test.ts`): mock **`@/shared/browser`** for store tests; keep **`skip-logic`** / **`page-guards`** free of browser globals.
- **Playwright**: Build first; tests load **`extension/dist/`** as unpacked extension. Prefer fixture URLs over live YouTube when possible.
- **Coverage**: Config enforces thresholds on selected files — if you add substantial logic, extend tests or adjust `vitest.config.ts` coverage `include` deliberately.

### Other

- **`TODO.md`**: Backlog / ideas — not binding spec.
- **Documentation**: `README.md` (onboarding), `DEVELOPMENT.md` (deep dive), `extension/DEPLOYMENT.md` (release).
