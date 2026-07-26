# TODO

Backlog and ideas — not a binding spec. Feature intent lives in `.sdd/`, which
is local-only.

## Product

- [ ] Post-install page explaining how to use the extension. Nothing listens to
      `runtime.onInstalled` today.
- [ ] Let the user choose how much of a detected block to cut, with sensible
      defaults. More settings here is a feature, not clutter.
- [ ] Collect skip stats — total time skipped, top channels.
- [ ] Fill in or remove the placeholder options sections. `options.tsx` still
      renders `PlaceholderSettingsSection` for Detection, Appearance, and
      Shortcuts, which reads as "not configurable yet".
- [ ] Advanced-settings toggle and a clear button for the promo-detection
      cache. Server mode already mirrors ready results in a versioned
      background cache (`server-result-cache.ts`, 30-day freshness), but the
      user cannot see or reset it, and BYOK has no cache at all.
- [ ] Remove locale keys no source file references. `pnpm locales info -N`
      currently lists about ten, mostly leftovers from the options redesign.

## Detection quality

- [ ] Re-measure Chrome built-in AI once the input language stops being a
      confound. It is compiled out behind `INCLUDE_CHROME_BUILTIN_PROVIDER`
      after scoring 0.054 mean IoU against the annotated fixture versus 0.747
      for the cloud model; the flag's comment carries the full measurement.
      Russian is not an accepted Prompt API language, so the untested variable
      is translating the transcript through the Translator API first, or
      annotating an English fixture. Harness: `extension/tmp/nano-bench/`.

## Server: correction workflow

Deferred by design — the extension has no correction-submission endpoint and
no in-product correction UI, and this section is the reason why.

- [ ] Design the product, security, and privacy workflow before accepting any
      correction. It has to validate canonical IDs, require a target identity,
      normalize proposed blocks, redact sensitive evidence, apply abuse
      controls, define retention, and record provenance and moderation
      decisions.
- [ ] Corrections target immutable analysis history keyed by `videoId` and
      `algorithmVersion`. When several results exist for that pair, `recordId`
      or `sourceResultId` selects the specific artifact. A proposal must never
      silently mutate a prior analysis or lose the algorithm-version context
      needed to investigate a result.
- [ ] A proposal record needs a durable `correctionId`, target identity,
      proposed action and normalized promo-block payload, reason, safe evidence
      metadata, submitter and trust metadata, moderation state, and timestamps.
      Expected lifecycle: draft or submitted, then queued, then accepted,
      rejected, or superseded.

### Constraints any of this must preserve

- Server mode sends metadata-only analysis requests and may use shared backend
  caching.
- Private BYOK makes zero TopSkip analysis, cache, and status requests.
- Local development stays possible without the public edge.

## Decided against

- **Sentry for error reporting.** The extension ships no error-reporting SDK.
  For eligible failures the user may explicitly open a sanitized prefilled
  GitHub issue, which never includes the video ID — see
  `extension/DEPLOYMENT.md`.

## Done

- [x] Translate to 20 locales — `extension/src/_locales/` covers 20.
- [x] Design and icons — the popup/options redesign shipped along with the icon
      set in `extension/src/public/icons/`.
- [x] Add a logger — `content-log.ts` plus the server-analysis dev logs.
- [x] Public backend hardening — Cloudflare Tunnel, anonymous installation
      tokens, durable quotas and budgets, SQLite artifacts, and a constrained
      container are all live; see `DEPLOYMENT.md`.
