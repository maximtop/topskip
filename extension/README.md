# TopSkip (Chrome extension)

MVP Chrome extension that **skips sponsor/promo blocks** on YouTube watch pages
when an **OpenRouter**-backed LLM detects them from captions (no fixed 30s→60s
window). A popup toggle enables or disables the extension; **OpenRouter API key
and model** are configured on the **options** page. Preferences use
`browser.storage` (see `AGENTS.md`).

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

| Command              | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `make setup`         | Install dependencies (pnpm)                               |
| `make build`         | Production build into `dist/`                             |
| `make lint`          | Oxfmt + oxlint + ESLint + markdownlint + TypeScript       |
| `make test`          | Vitest with coverage, then Playwright E2E                 |
| `make test-unit`     | Vitest unit tests only (no coverage)                      |
| `make test-coverage` | Vitest with coverage thresholds                           |
| `make test-e2e`      | Playwright only (headless; extension + local fixture MP4) |

## Project docs

- [DEVELOPMENT.md](./DEVELOPMENT.md) — architecture and local testing
- [DEPLOYMENT.md](./DEPLOYMENT.md) — packaging and Chrome Web Store notes
- [AGENTS.md](./AGENTS.md) — notes for AI-assisted changes

## License

Private / unlicensed unless you add a `LICENSE` file.
