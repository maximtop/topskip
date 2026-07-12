# Deployment

This document describes **shipping TopSkip to the Chrome Web Store**. Packaging
the extension remains separate from the server-first development MVP, which
uses only a loopback backend at `127.0.0.1:8787`. Public hosting is intentionally
deferred: this MVP configures no public backend origin, token, or edge
infrastructure. Local development and testing are covered in
[`DEVELOPMENT.md`](DEVELOPMENT.md); deferred public hardening and corrections
are tracked in [`SERVER_FIRST_FUTURE_WORK.md`](SERVER_FIRST_FUTURE_WORK.md).

## Production configuration (reference)

| Area                        | Production behavior                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment variables**   | None. The extension bundle does not read `process.env` or similar at runtime.                                                                     |
| **Infrastructure**          | No public infrastructure is configured. The development backend is loopback-only and retains local artifacts for 30 days.                         |
| **External APIs / network** | Development server mode targets loopback only. Private BYOK may use a user-configured provider; production public-service networking is deferred. |
| **Error reporting**         | No Sentry or similar SDK in the shipped code.                                                                                                     |
| **Logging**                 | No centralized logging; behavior is entirely in the user’s browser.                                                                               |

User data: preferences and provider configuration are stored in
**`browser.storage.local`**, written only by the extension’s **background**
service worker. Private BYOK does not make TopSkip backend analysis, cache, or
status requests. State the applicable storage and network behavior clearly in
the store’s privacy fields.

## Production build

Requires **Node.js ≥ 20** (see `package.json` `engines`).

```bash
pnpm run release
```

Rspack writes **`dist/`** with `background.js`, `content.js`, `popup.js`,
`options.js`, `popup.html`, `options.html`, **`manifest.json`**
(from **`src/manifest.json`**), and any files under `src/public/` (e.g. icons when added).

## Package for Chrome Web Store

1. Run a clean release build: `pnpm run release`
2. Zip **only** the contents of `dist/` (not the parent repo). On macOS:

    ```bash
    (cd dist && zip -r ../topskip-extension.zip .)
    ```

3. Upload `topskip-extension.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Pre-submit checklist

- [ ] **Manifest V3** — `manifest_version` is `3`
- [ ] **Permissions** — `storage`, `tabs`, `scripting`; host access for YouTube (`https://www.youtube.com/*`), optional **OpenRouter** (`https://openrouter.ai/*`); verify both dev-only origins (`http://127.0.0.1:4173/*` and `http://127.0.0.1:8787/*`) are absent from `host_permissions` and programmatic content-script matches
- [ ] **Privacy** — Describe access to `browser.storage` (local prefs + OpenRouter settings), **`tabs`** (messages and detection status), optional **OpenRouter** (user-supplied API key for transcript analysis), and YouTube pages
- [ ] **Icons** — Verify `src/public/icons/topskip.svg` and generated PNG sizes are copied into `dist/` and referenced by `manifest.json`
- [ ] **Version** — Bump `"version"` in `src/manifest.json` for each submission (it is emitted into `dist/`)

## Notes

- Automated store review expectations change; review [Chrome extension program policies](https://developer.chrome.com/docs/webstore/program-policies/) before publishing.
