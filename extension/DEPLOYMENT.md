# Deployment

This document describes **shipping TopSkip to the Chrome Web Store**. Packaging
the extension remains separate from operating the public backend. Development
builds may use the one explicit loopback exception, while beta and release
builds require a public-looking HTTPS DNS origin supplied by the
`TOPSKIP_SERVER_ORIGIN` build-time environment variable. Only development also
matches the local Playwright page. Local development is covered in
[`DEVELOPMENT.md`](../DEVELOPMENT.md), while backend provisioning and rollback
are covered in [`DEPLOYMENT.md`](../DEPLOYMENT.md).

## Production configuration (reference)

| Area                        | Production behavior                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment variables**   | None. The extension bundle does not read `process.env` or similar at runtime.                                                                        |
| **Infrastructure**          | Server mode targets the origin from `TOPSKIP_SERVER_ORIGIN` at build time; it is reached through Cloudflare Tunnel.                                   |
| **External APIs / network** | Background uploads Server captions to TopSkip; explicit Private BYOK may separately request optional OpenRouter or OpenAI access.                  |
| **Error reporting**         | No Sentry SDK. For eligible failures, the user may explicitly open a sanitized prefilled issue on GitHub; the prefilled issue never includes the video ID. When a local debug log exists, the issue body adds one line asking the user to attach the exported log themselves; the log is never embedded in the URL. |
| **Logging**                 | Beta/release consoles are quiet by default: one `[TopSkip] Service worker started` line per worker start plus `warn`/`error` with stable codes; dev-only console stages are compiled out. The optional **Debug logging** switch (Options → Diagnostics) is off by default in beta/release, user-initiated and local-only: a `storage.local` ring buffer up to 5 MiB (oldest entries replaced) that includes video IDs, excludes transcripts and secrets, is kept until debug logging is turned on again, and leaves the browser only through the user's own Copy/Download. Production backend operations are separate from the extension package. |

User data: preferences, optional provider keys/models, the anonymous 90-day
installation token, public server config, ready-result cache, and — only while
the user has turned it on — the local debug log (switch state, counters, and
allow-listed diagnostic events tagged with YouTube video IDs; no captions,
transcripts, keys, tokens, cookies, URLs, or raw responses) are stored in
**`browser.storage.local`** and owned by the extension’s **background** service
worker. The debug log is a ring buffer up to 5 MiB (oldest entries replaced),
kept until debug logging is turned on again, and exported only by the user’s
own Copy/Download from Options → Diagnostics. All TopSkip and Private BYOK
provider HTTP is also background-owned; content, popup, options, and page
contexts use validated messages. This extension upload path is the production
Server-mode source. Private BYOK makes
zero TopSkip analysis or registration requests and no TopSkip config, cache,
or status request.

Saved provider credentials and Chrome host access are independent. OpenRouter
and OpenAI appear only under `optional_host_permissions`; one is granted after
an explicit provider-specific **Allow access** or **Test connection** action.
Revoking access does not delete the saved key, but every provider network path
rechecks the grant and refuses to fetch until it is restored. Server mode never
requests either optional provider host, because its model call occurs in the
TopSkip backend. State both storage and optional-network behavior clearly in
the store's privacy fields.

Server mode sends the current video ID, caption language, and timed caption text
to TopSkip and its configured model provider. Validated transcripts and bounded
assistant output may be retained for up to 30 days under access control and
pruning. The prefilled GitHub issue never includes transcript text or the video
ID; the optional, user-initiated, local debug log does include video IDs and
says so in the UI and export header, but never transcript text or secrets.
Users must not paste retained content into issues.

## Production build

Requires **Node.js ≥ 22** (see `package.json` `engines`) and targets
**Chrome 111+**, the first version supporting declarative MAIN-world content
scripts. No yt-dlp executable, manager, or server extraction code is included
in `extension/dist/` or the Chrome Web Store archive.

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
2. Verify the deployed backend's `/v1/health` and `/v1/config` before reloading
   or distributing the matching extension build. The public Valibot contract is
   `common/src/server-analysis-contract.ts`.
3. Inspect `extension/dist/manifest.json`: it must contain the localized
   release name `__MSG_name__` and the server host permission matching
   `TOPSKIP_SERVER_ORIGIN`, and must not contain the development fixture
   origin. Then run the exact packaging-boundary validator:

    ```bash
    pnpm run validate:extension-manifest -- \
      --build release \
      --server-origin "${TOPSKIP_SERVER_ORIGIN}" \
      --manifest extension/dist/manifest.json
    ```

   CI runs this validator for dev, beta, and release artifacts. The
   beta/release origin policy rejects HTTP, IP literals, paths, credentials,
   and private/special-use-looking DNS names. It performs no DNS lookup, so it
   cannot prove that an accepted public-looking hostname resolves publicly.
4. Zip **only** the contents of `extension/dist/`. On macOS:

    ```bash
    (cd extension/dist && zip -r ../topskip-extension.zip .)
    ```

5. Upload `topskip-extension.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
6. After install/update, tell testers that YouTube tabs which were already
   open recover as soon as they open the TopSkip popup on them (the popup
   re-attaches the bundles via `scripting` + `activeTab`); a page reload also
   works. Worker sleep/restart alone needs neither while the content context
   remains live; the readiness wake resumes delivery but never injects a
   replacement bundle.
7. Updating from a build without `unlimitedStorage`: Chrome grants the new
   permission silently (it carries no install warning), so testers need do
   nothing and the extension stays enabled. Confirm once with the Extension
   Update Testing Tool or a packed `.crx` before the first store update that
   carries it; the manual checklist in `DEVELOPMENT.md` lists the expected
   debug-log markers.

## Pre-submit checklist

- [ ] **Manifest V3** — `manifest_version` is `3`
- [ ] **Browser floor** — `minimum_chrome_version` is `111`
- [ ] **API permissions** — `permissions` contains exactly `storage`, `scripting`, `activeTab`, and `unlimitedStorage` (no install warning; granted silently on update); `tabs`, `downloads`, `alarms`, and `clipboardWrite` are absent
- [ ] **Required hosts** — `host_permissions` contains exactly the TopSkip backend from `TOPSKIP_SERVER_ORIGIN`; YouTube and provider hosts are absent
- [ ] **Optional hosts** — `optional_host_permissions` contains exactly OpenRouter (`https://openrouter.ai/*`) and OpenAI (`https://api.openai.com/*`)
- [ ] **Static site access** — both content-script entries match YouTube only, run at `document_start`, and declare MAIN before ISOLATED; `http://127.0.0.1:4173/*` is absent
- [ ] **Privacy** — Describe background-owned storage, Server caption upload, optional per-provider grants, Private BYOK isolation, declarative YouTube access, that `scripting` + `activeTab` are used only to re-inject the YouTube bundles into the tab the popup was opened on, and that `unlimitedStorage` backs the optional local debug log (off by default, user-initiated, includes video IDs, excludes transcripts and secrets, never uploaded by the extension)
- [ ] **Icons** — Verify `extension/src/public/icons/topskip.svg` and generated PNG sizes are copied into `extension/dist/` and referenced by `manifest.json`
- [ ] **Version** — Bump `"version"` in `extension/src/manifest.json` for each submission (it is emitted into `extension/dist/`)

## Notes

- Automated store review expectations change; review [Chrome extension program policies](https://developer.chrome.com/docs/webstore/program-policies/) before publishing.
