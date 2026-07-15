# Backend Caption Extraction With yt-dlp

**Created**: 2026-07-12
**Status**: Implemented
**Type**: Backend integration

## Problem

The local backend used direct YouTube timedtext requests behind an opt-in
environment flag. That path was brittle, duplicated extraction behavior, and
made the server's primary capability appear optional.

## Decision

Use `yt-dlp` as the only production subtitle extraction strategy. Keep an
official standalone executable in the gitignored `.tools/` directory and
install a pinned nightly with SHA-256 verification. Server startup never updates
the executable. `TOPSKIP_YT_DLP_PATH` may point to an operator-managed
executable.

The extension HTTP contract does not change and the executable is never bundled
with the Chrome extension.

## Requirements

- Node.js 22 or newer is required and every YouTube invocation supplies
  `--js-runtimes node`.
- Subprocesses run without a shell, ignore ambient yt-dlp configuration, reject
  playlists, cap stdout, and have a hard timeout.
- Extraction first reads bounded JSON metadata and selects tracks in this order:
  manual original, automatic original, manual English, automatic English, first
  manual, first automatic.
- A second process downloads exactly the selected subtitle as JSON3 into a
  temporary directory without video or audio.
- The shared pure JSON3 parser enforces response, segment, and transcript-size
  limits; temporary files are always removed.
- Stored diagnostics contain stable codes only and never retain stderr, signed
  URLs, or remote arguments.
- Existing `youtube_timedtext` artifact records remain readable while new
  artifacts use `youtube_yt_dlp`.
- Local transcript fixtures precede yt-dlp only when `NODE_ENV=test`.

## Tooling

- `make setup` and `make yt-dlp-install` install/check the pinned executable.
- `make server` and `pnpm run backend:dev` start without an update check.
- CI runs `pnpm run yt-dlp:install` and therefore uses only the pinned bootstrap
  release.
- `make yt-dlp-refresh-pin` refreshes the repository's pinned tag and digests;
  the reviewed pin is then installed and shipped through a normal PR/deploy.

## Verification

- Unit coverage includes track priorities and backward-compatible artifacts.
- Injectable-runner tests cover arguments, missing binary, timeout, output cap,
  non-zero exit, malformed JSON3, and temporary-directory cleanup.
- The full format, lint, typecheck, build, unit/coverage, and Playwright suites
  must pass.
- A non-CI live smoke verifies manual and automatic subtitle extraction without
  media files.
