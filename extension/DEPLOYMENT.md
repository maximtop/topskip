# Deployment

This document describes **shipping TopSkip to the Chrome Web Store**. It is not a hosted service: there is **no server**, **no runtime environment variables**, and **no backend infrastructure** in the MVP. Local development and testing are covered in [`DEVELOPMENT.md`](DEVELOPMENT.md).

## Production configuration (reference)

| Area                        | Production behavior                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment variables**   | None. The extension bundle does not read `process.env` or similar at runtime.                                                                                                |
| **Infrastructure**          | None (no database, cache, queue, or object storage).                                                                                                                         |
| **External APIs / network** | Optional: **OpenRouter** `https://openrouter.ai/api/v1/chat/completions` when the user enables LLM promo detection and supplies an API key (declared in `host_permissions`). |
| **Error reporting**         | No Sentry or similar SDK in the shipped code.                                                                                                                                |
| **Logging**                 | No centralized logging; behavior is entirely in the user’s browser.                                                                                                          |

User data: the on/off preference is stored in **`browser.storage.sync`** (written only by the extension’s **background** service worker) on the user’s Google account (Chrome sync), not on TopSkip servers—state this clearly in the store’s privacy fields.

## Production build

Requires **Node.js ≥ 20** (see `package.json` `engines`).

```bash
make build
```

Rspack writes **`dist/`** with `background.js`, `content.js`, `popup.js`,
`options.js`, `popup.html`, `options.html`, **`manifest.json`**
(from **`src/manifest.json`**), and any files under `src/public/` (e.g. icons when added).

## Package for Chrome Web Store

1. Run a clean build: `make build`
2. Zip **only** the contents of `dist/` (not the parent repo). On macOS:

    ```bash
    (cd dist && zip -r ../topskip-extension.zip .)
    ```

3. Upload `topskip-extension.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Pre-submit checklist

- [ ] **Manifest V3** — `manifest_version` is `3`
- [ ] **Permissions** — `storage`, `tabs`, `scripting`; host access for YouTube (`https://www.youtube.com/*`), optional **OpenRouter** (`https://openrouter.ai/*`); remove dev-only `http://127.0.0.1:4173/*` from `host_permissions` and from programmatic content-script matches before a public release if that entry was only for local Playwright fixtures
- [ ] **Privacy** — Describe access to `browser.storage` (local prefs + OpenRouter settings), **`tabs`** (messages and detection status), optional **OpenRouter** (user-supplied API key for transcript analysis), and YouTube pages
- [ ] **Icons** — Add icons under `src/public/` and reference them in `manifest.json` if the listing requires them (the MVP manifest may ship without `icons` until assets exist)
- [ ] **Version** — Bump `"version"` in `src/manifest.json` for each submission (it is emitted into `dist/`)

## Notes

- Automated store review expectations change; review [Chrome extension program policies](https://developer.chrome.com/docs/webstore/program-policies/) before publishing.
