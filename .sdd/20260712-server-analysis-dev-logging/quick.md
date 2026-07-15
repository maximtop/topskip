# Server Analysis Dev Logging

**Created**: 2026-07-12
**Status**: Implemented
**Type**: Development observability

## Problem

Opening a YouTube video provided no visible evidence that the content script
selected Server mode, that the background handled the runtime request, or that
the backend started extraction. Cache hits and missing prerequisites were
indistinguishable from a broken request path.

## Decision

Add permanent dev-only structured logs for the complete server-analysis flow.
Content stages are forwarded to the background service-worker console, while
the local backend logs HTTP, jobs, yt-dlp, extraction, and terminal results to
its terminal.

The content script remains message-only. Backend HTTP, local-cache access,
timeouts, validation, and response mapping are owned exclusively by the
background service worker.

## Safety

Logs may contain `videoId`, `jobId`, scalar statuses, counts, and timings. They
must not contain transcripts, subtitle bodies, signed URLs, stderr, cookies,
credentials, or remote response bodies. A compile-time flag disables extension
logs in beta/release builds, and imported backend test servers stay quiet unless
the local CLI enables tracing.

## Verification

- Unit tests cover the build gates, scalar log format, message-only content
  routing, cache hit/miss behavior, polling, and safe yt-dlp failures.
- Manual verification uses `make extension`, `make server`, the extension
  service-worker console, and a reloaded YouTube watch page.
