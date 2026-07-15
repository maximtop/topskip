# Deployment

This document describes **shipping TopSkip to the Chrome Web Store**. Packaging
the extension remains separate from operating the public backend. Development
builds use `127.0.0.1:8787`; beta and release builds use
`https://topskip.maximtop.dev`. Local development is covered in
[`DEVELOPMENT.md`](../DEVELOPMENT.md), while backend provisioning and rollback
are covered in [`DEPLOYMENT.md`](../DEPLOYMENT.md).

## Production configuration (reference)

| Area                        | Production behavior                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Environment variables**   | None. The extension bundle does not read `process.env` or similar at runtime.                                                                          |
| **Infrastructure**          | Server mode targets `https://topskip.maximtop.dev`; the origin is reached through Cloudflare Tunnel and is not encoded in the extension.               |
| **External APIs / network** | Server mode sends video metadata to TopSkip; Private BYOK skips TopSkip registration/config/analysis and may use the user-configured provider instead. |
| **Error reporting**         | No Sentry SDK. For eligible failures, the user may explicitly open a sanitized prefilled issue on GitHub; the extension never includes the video ID.   |
| **Logging**                 | Dev-only browser logs are compiled out of beta/release builds; production backend operations are separate from the extension package.                  |

User data: preferences, the anonymous 90-day installation token, public server
config, and ready-result cache are stored in **`browser.storage.local`** and
owned by the extension’s **background** service worker. Private BYOK does not
make TopSkip registration, config, analysis, cache, or status requests. State
the applicable storage and network behavior clearly in the store’s privacy
fields.

## Production build

Requires **Node.js ≥ 22** (see `package.json` `engines`). The backend's
gitignored `.tools/yt-dlp` executable is never included in `extension/dist/` or
the Chrome Web Store archive.

```bash
pnpm run release
```

Run release commands from the repository root. Rspack writes
**`extension/dist/`** with `background.js`, `content.js`, `popup.js`,
`options.js`, `popup.html`, `options.html`, **`manifest.json`**
(from **`extension/src/manifest.json`**), and any files under
`extension/src/public/` (e.g. icons when added).

## Package for Chrome Web Store

1. Run a clean release build: `pnpm run release`
2. Inspect `extension/dist/manifest.json`: it must contain
   `https://topskip.maximtop.dev/*` and neither development origin.
3. Zip **only** the contents of `extension/dist/`. On macOS:

    ```bash
    (cd extension/dist && zip -r ../topskip-extension.zip .)
    ```

4. Upload `topskip-extension.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## Pre-submit checklist

- [ ] **Manifest V3** — `manifest_version` is `3`
- [ ] **Permissions** — `storage`, `tabs`, `scripting`; host access for YouTube (`https://www.youtube.com/*`), TopSkip (`https://topskip.maximtop.dev/*`), and optional **OpenRouter** (`https://openrouter.ai/*`); verify both dev-only origins (`http://127.0.0.1:4173/*` and `http://127.0.0.1:8787/*`) are absent
- [ ] **Privacy** — Describe `browser.storage` (prefs, optional OpenRouter settings, installation token, config, and ready cache), **`tabs`** (messages and detection status), TopSkip Server mode, optional **OpenRouter**, and YouTube pages
- [ ] **Icons** — Verify `extension/src/public/icons/topskip.svg` and generated PNG sizes are copied into `extension/dist/` and referenced by `manifest.json`
- [ ] **Version** — Bump `"version"` in `extension/src/manifest.json` for each submission (it is emitted into `extension/dist/`)

## Notes

- Automated store review expectations change; review [Chrome extension program policies](https://developer.chrome.com/docs/webstore/program-policies/) before publishing.
