# TopSkip (Chrome extension)

Chrome extension that **skips detected sponsor/promo blocks** on YouTube watch
pages. **Server** mode is the default: the local development backend extracts
captions, analyzes them, and reuses cached results. **Private BYOK** is an
explicit opt-in for users who prefer their own provider and do not want video
IDs sent to the TopSkip backend. There is no fixed 30s→60s skip window.

## Requirements

- **Node.js** 20+
- **pnpm** (see `package.json` → `packageManager`; [install pnpm](https://pnpm.io/installation))
- **Chrome** (Chromium) for loading the unpacked extension

## Quick start

```bash
make setup    # or: pnpm install
make build    # or: pnpm run build
```

Load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder inside this repository (after `make build`)

## Commands

| Command                | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `make setup`           | Install dependencies (pnpm)                               |
| `make build`           | Production build into `dist/`                             |
| `make lint`            | Oxfmt + oxlint + ESLint + markdownlint + TypeScript       |
| `make test`            | Vitest with coverage, then Playwright E2E                 |
| `make test-unit`       | Vitest unit tests only (no coverage)                      |
| `make test-coverage`   | Vitest with coverage thresholds                           |
| `make test-e2e`        | Playwright only (headless; extension + local fixture MP4) |
| `pnpm run backend:dev` | Run the local server-mode backend for development         |

## Project docs

- [DEVELOPMENT.md](./DEVELOPMENT.md) — architecture and local testing
- [DEPLOYMENT.md](./DEPLOYMENT.md) — packaging and Chrome Web Store notes
- [SERVER_FIRST_FUTURE_WORK.md](./SERVER_FIRST_FUTURE_WORK.md) — deferred server
  hardening and correction-workflow design
- [AGENTS.md](./AGENTS.md) — notes for AI-assisted changes

## License

Private / unlicensed unless you add a `LICENSE` file.
