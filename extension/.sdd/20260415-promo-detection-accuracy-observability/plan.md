# Implementation Plan: OpenRouter Multi-Block Promo Detection

**Created**: 2026-04-14  
**Status**: Validated  
**Input**: Feature specification from `.sdd/.current/spec.md`  
**Model**: Auto (agent-authored)  
**User Input**: None (no additional constraints)

## Summary

Replace the fixed 30s→60s skip with **LLM-detected promo blocks**: after captions arrive in the background, merge segments into **one** transcript, call **OpenRouter** `POST /api/v1/chat/completions` once per `videoId`, parse **`promoBlocks`**, log results for developers, and send validated blocks to the content script. The content script **skips** each block at most once when playback crosses each `startSec` (player **seek** to `endSec` or default). **OpenRouter API key and model** live on a new **options page**; the toolbar popup keeps the main **enabled** toggle and shows **detection status**. When **enabled** is false, **no content scripts** inject (programmatic `registerContentScripts` / unregister). **Host permission** for `https://openrouter.ai/*` is required for `fetch` from the service worker.

## Technical Context

| Item | Value |
|------|--------|
| **Language/Version** | TypeScript 5.x (strict), ESM (`"type": "module"`) |
| **Primary Dependencies** | React 19, Mantine 9, MobX 6 (popup/options UI); Rspack; Valibot; Vitest; Playwright |
| **Storage** | `browser.storage.local` — existing `topskip:prefs` + new key for OpenRouter config (spec FR-004); background-only writes |
| **Testing** | Vitest 4 (`pnpm run test`, `pnpm run test:coverage`); Playwright E2E (`pnpm run test:e2e`) |
| **Target Platform** | Chrome MV3 extension (`dist/` unpacked); service worker + content + popup + **new options bundle** |
| **Project Type** | Single package (`/Volumes/dev/topskip/extension`) |
| **Performance Goals** | One OpenRouter request per caption analysis (NFR-006); non-blocking UI (NFR-001) |
| **Constraints** | No `@openrouter/sdk`; direct `fetch` only; no API key in logs; JSDoc + ESLint per `AGENTS.md` |
| **Scale/Scope** | Single-user extension; transcripts bounded before send (edge case) |

## Research

### OpenRouter HTTP API (direct `fetch`)

- **Endpoint**: `POST https://openrouter.ai/api/v1/chat/completions` (FR-009).  
- **Headers**: `Authorization: Bearer <OPENROUTER_API_KEY>`, `Content-Type: application/json`. Optional: `HTTP-Referer`, `X-Title` per [OpenRouter docs](https://openrouter.ai/docs) for app attribution.  
- **Body**: OpenAI-compatible `{ model, messages: [{role, content}], stream: false }`.  
- **Response**: Parse `choices[0].message.content` as string; inner text must be strict JSON matching FR-011 / `.sdd/.current/contracts/promo-detection-result.schema.json`.  
- **Errors**: Non-JSON or HTTP errors → detection `error` state; log sanitized reason, never log `Authorization`.

### MV3 programmatic content scripts (FR-021)

- Remove **static** `content_scripts` for YouTube from `src/manifest.json` to avoid injecting when disabled.  
- On startup and when `enabled` flips **true**, call `browser.scripting.registerContentScripts([{ id: 'topskip-watch', matches: ['https://www.youtube.com/*'], + dev localhost], js: ['content.js'], runAt: 'document_idle' }])`.  
- When `enabled` is **false**, `unregisterContentScripts({ ids: ['topskip-watch'] })`.  
- Requires existing `scripting` permission. Ensure `content.js` path matches **dist** filename after build.  
- **E2E dev** builds add `http://127.0.0.1:4173/*` match — mirror existing `applyDevLocalhostToManifest` / `TOPSKIP_BUILD` logic for registered scripts.

### Transcript merge + truncation

- Deterministic lines: e.g. `[12.5] caption text` sorted by `startSec` (NFR-002).  
- If over budget (chars or estimated tokens), truncate tail with explicit log “truncated” (spec edge case).

### Multi-block skip logic

- Generalize crossing detection: for each block index `i`, fire when `prevTime < startSec && currentTime >= startSec` (and same delta guard as `MAX_PLAYBACK_DELTA_SEC` in `skip-logic.ts`).  
- Track `firedBlockIndices: Set<number>` per `videoId`.  
- Target time: `endSec ?? min(startSec + 30, duration)` per FR-011 / spec.  
- Remove reliance on `SKIP_START_SEC` / `SKIP_END_SEC` when promo blocks are active for that video (spec: no fixed-window skip).

## Entities

### OpenRouterConfig (spec)

| Field | Type | Validation |
|-------|------|------------|
| `enabled` | boolean | LLM feature on/off |
| `apiKey` | string | Non-empty when `enabled` (FR-006) |
| `model` | string | Non-empty when `enabled` |

Stored under a dedicated `STORAGE_KEY_OPENROUTER` in `browser.storage.local`, read/write **only** in background.

### PromoBlock (validated, after FR-012)

| Field | Type | Rules |
|-------|------|--------|
| `startSec` | number | finite, ≥ 0 |
| `endSec` | number | optional; if set, > `startSec` |
| `confidence` | `'low' \| 'medium' \| 'high'` | optional |

Sorted ascending by `startSec`; overlaps deduped deterministically.

### PromoDetectionStatus / PromoDetectionResult

As in spec § Key Entities; keyed in background by `(tabId, videoId)` for status queries from popup.

## Contracts

| Artifact | Path |
|----------|------|
| Chat completion response subset | `.sdd/.current/contracts/openrouter-chat-completion.schema.json` |
| Parsed LLM promo JSON | `.sdd/.current/contracts/promo-detection-result.schema.json` |

### Runtime messages (extension-internal)

| Message | Direction | Payload summary |
|---------|-------------|-----------------|
| `TOPSKIP_GET_OPENROUTER_CONFIG` | options → bg | — |
| `TOPSKIP_SET_OPENROUTER_CONFIG` | options → bg | `{ enabled, apiKey?, model }` (exact shape in `messages.ts`) |
| `TOPSKIP_GET_DETECTION_STATUS` | popup → bg | active tab id resolved in bg |
| `TOPSKIP_PROMO_DETECTION_UPDATED` | bg → popup/content | `{ videoId, status, promoBlocks?, error? }` |
| `TOPSKIP_PROMO_BLOCKS_DETECTED` | bg → content | `{ videoId, promoBlocks: PromoBlock[] }` |
| `TOPSKIP_CAPTIONS_FROM_CONTENT` | content → bg | existing `CaptionsFromContentPayload` |

REST **external** API: OpenRouter only — no OpenAPI file for this repo beyond JSON schemas above; refer to OpenRouter official docs.

## File Structure

| File | Action | Responsibility |
|------|--------|------------------|
| `src/manifest.json` | Modify | `options_ui`; `host_permissions` + `https://openrouter.ai/*`; remove static `content_scripts` (or leave empty) |
| `rspack.config.ts` | Modify | New entry `options` → `options.html` + `options.js` |
| `src/options/index.html` | Create | Options page shell |
| `src/options/main.tsx` | Create | Options app entry; `Options.init()` pattern |
| `src/options/options.tsx` | Create | Mantine form: LLM toggle, API key, model presets + custom |
| `src/shared/constants.ts` | Modify | OpenRouter storage key; schemas; remove or gate fixed skip constants when LLM active |
| `src/shared/messages.ts` | Modify | New `TOPSKIP_*` types and unions |
| `src/shared/promo-types.ts` | Create | `PromoBlock`, detection status types (shared, no I/O) |
| `src/background/openrouter/` | Create | `openrouter-client.ts` (`fetch`), `merge-transcript.ts`, `parse-llm-json.ts`, `promo-dedupe.ts` |
| `src/background/storage/openrouter-storage.ts` | Create | Valibot read/write for OpenRouter config |
| `src/background/messaging/openrouter-runtime-messages.ts` | Create | Handlers for get/set config |
| `src/background/messaging/promo-detection-messages.ts` | Create | Orchestrate analysis on captions; stale `videoId` cancel |
| `src/background/messaging/caption-runtime-messages.ts` | Modify | After captions OK → enqueue analysis (or call promo pipeline) |
| `src/background/background.ts` | Modify | Register content scripts on prefs; wire new handlers |
| `src/content/content.ts` | Modify | Ensure init only when injected (no-op if script not injected) |
| `src/content/youtube-watch.ts` | Modify | Multi-block skip; listen for `TOPSKIP_PROMO_BLOCKS_DETECTED`; reset on `videoId` change |
| `src/content/skip-logic.ts` | Modify or split | Add `evaluatePromoBlocksSkip` + keep or deprecate fixed window per spec |
| `src/popup/PopupApp.tsx` | Modify | Main toggle; “Open settings”; detection status via `GET_DETECTION_STATUS` |
| `src/popup/preferences-store.ts` | Modify | Optional: subscribe to detection updates |
| `tests/**` | Create/Modify | Unit tests mirroring `src/**` |
| `e2e/**` | Modify | Fixture flows; may mock network or document manual OpenRouter |
| `DEPLOYMENT.md`, `README.md`, `AGENTS.md` | Modify | OpenRouter, new host permission, options page (FR-019) |

## Tasks

Implementation order: **shared types & pure functions (TDD) → background storage & OpenRouter client → messaging & analysis → manifest & dynamic injection → content skip → options UI → popup → E2E → docs**.

---

### [x] Task 1: Valibot schema for LLM JSON + unit tests

**Files:**
- Create: `src/shared/promo-types.ts` — exported types only
- Create: `src/shared/openrouter-llm-schema.ts` — Valibot schema matching FR-011
- Create: `tests/shared/openrouter-llm-schema.test.ts`
- Modify: `src/shared/constants.ts` — add `STORAGE_KEY_OPENROUTER` string constant only if needed by schema tests

**Steps:**

1. **Write failing tests** in `tests/shared/openrouter-llm-schema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parse } from 'valibot';
import { llmPromoDetectionSchema } from '@/shared/openrouter-llm-schema';

describe('llmPromoDetectionSchema', () => {
  it('accepts hasPromo true with non-empty promoBlocks', () => {
    const out = parse(llmPromoDetectionSchema, {
      hasPromo: true,
      promoBlocks: [{ startSec: 1, endSec: 2, confidence: 'low' }],
    });
    expect(out.hasPromo).toBe(true);
    expect(out.promoBlocks).toHaveLength(1);
  });

  it('rejects hasPromo true with empty promoBlocks', () => {
    expect(() =>
      parse(llmPromoDetectionSchema, { hasPromo: true, promoBlocks: [] }),
    ).toThrow();
  });
});
```

2. **Run**: `cd /Volumes/dev/topskip/extension && pnpm exec vitest run tests/shared/openrouter-llm-schema.test.ts`  
   **Expected**: FAIL (module or schema missing)

3. **Implement** `src/shared/openrouter-llm-schema.ts` with `v.union` / `v.object` matching FR-011 (true branch + false branch).

4. **Run** same vitest command — **Expected**: PASS

**Verification**: `pnpm exec vitest run tests/shared/openrouter-llm-schema.test.ts` passes.

---

### [x] Task 2: Pure function — merge caption segments to transcript

**Files:**
- Create: `src/shared/captions/merge-transcript.ts`
- Create: `tests/shared/captions/merge-transcript.test.ts`

**Steps:**

1. **Write failing test** `tests/shared/captions/merge-transcript.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mergeCaptionSegmentsToTranscript } from '@/shared/captions/merge-transcript';
import type { CaptionSegment } from '@/shared/caption-types';

describe('mergeCaptionSegmentsToTranscript', () => {
  it('returns empty string for empty segments', () => {
    const r = mergeCaptionSegmentsToTranscript([], 10_000);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('sorts by startSec and joins deterministically', () => {
    const segments: CaptionSegment[] = [
      { startSec: 10, durationSec: 1, text: 'B' },
      { startSec: 2, durationSec: 1, text: 'A' },
    ];
    const r = mergeCaptionSegmentsToTranscript(segments, 10_000);
    expect(r.text).toBe('[2] A\n[10] B');
    expect(r.truncated).toBe(false);
  });

  it('sets truncated when exceeding maxChars', () => {
    const segments: CaptionSegment[] = [
      { startSec: 0, durationSec: 1, text: 'hello' },
    ];
    const r = mergeCaptionSegmentsToTranscript(segments, 4);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4);
  });
});
```

2. **Run**: `cd /Volumes/dev/topskip/extension && pnpm exec vitest run tests/shared/captions/merge-transcript.test.ts`  
   **Expected**: FAIL (module missing)

3. **Implement** `src/shared/captions/merge-transcript.ts`:

```typescript
import type { CaptionSegment } from '@/shared/caption-types';

/**
 * @param segments - Caption rows from YouTube transcript
 * @param maxChars - Maximum characters for the merged user message (excluding truncation notice)
 * @returns Merged transcript and whether tail was cut
 */
export function mergeCaptionSegmentsToTranscript(
  segments: CaptionSegment[],
  maxChars: number,
): { text: string; truncated: boolean } {
  if (segments.length === 0) {
    return { text: '', truncated: false };
  }
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const lines = sorted.map((s) => `[${s.startSec}] ${s.text.trim()}`);
  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}
```

4. **Run** same vitest command — **Expected**: PASS

**Verification**: `pnpm exec vitest run tests/shared/captions/merge-transcript.test.ts` passes.

---

### [x] Task 3: Pure function — sort/dedupe promo blocks

**Files:**
- Create: `src/shared/promo-dedupe.ts` — `sortAndDedupePromoBlocks(blocks: PromoBlockInput[]): PromoBlock[]`
- Create: `tests/shared/promo-dedupe.test.ts`

**Steps:**

1. **Test**: overlapping intervals → deterministic keep-first or wider (document choice in JSDoc to match FR-012).

2. **Implement**.

3. **Run vitest** — PASS

**Verification**: Unit tests document dedupe rule.

---

### [x] Task 4: Pure function — multi-block skip decision

**Files:**
- Create: `src/content/promo-skip-logic.ts` — exports `evaluatePromoBlockSkip(input)` using `MAX_PLAYBACK_DELTA_SEC` from `skip-logic.ts`
- Create: `tests/content/promo-skip-logic.test.ts`

**Input shape** (illustrative):

```typescript
export type PromoSkipInput = {
  prevTime: number;
  currentTime: number;
  duration: number;
  isSeeking: boolean;
  firedIndices: ReadonlySet<number>;
  blocks: ReadonlyArray<{ startSec: number; endSec?: number }>;
};
```

**Output**: `{ action: 'none' } | { action: 'skip'; blockIndex: number; targetTime: number }`

**Steps:**

1. **Tests**: crossing block 0; `firedIndices` prevents double fire; manual seek (`isSeeking`) suppresses; `endSec` missing → `startSec + 30` clamped to `duration`.

2. **Implement**.

3. **Run**: `pnpm exec vitest run tests/content/promo-skip-logic.test.ts`

**Verification**: Matches FR-015 (a)(b).

---

### [x] Task 5: OpenRouter client (`fetch`) — unit test with mocked `globalThis.fetch`

**Files:**
- Create: `src/background/openrouter/openrouter-client.ts` — `callOpenRouterChat(params): Promise<{ ok: true; rawContent: string } | { ok: false; error: string }>`
- Create: `tests/background/openrouter/openrouter-client.test.ts`

**Steps:**

1. **Mock** `fetch` to return `{ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }`.

2. **Assert** request URL and `Authorization` header shape (use dummy key).

3. **Implement** client: `stream: false`, single system + user message.

4. **Run vitest** — PASS

**Verification**: No API key logged; errors handled for non-200.

---

### [x] Task 6: Parse + validate assistant JSON string

**Files:**
- Create: `src/background/openrouter/parse-llm-promo-response.ts`
- Create: `tests/background/openrouter/parse-llm-promo-response.test.ts`

**Steps:**

1. **Tests**: valid JSON; markdown fence around JSON (if model adds fences — strip or fail per spec: prose → error).

2. **Implement** with `valibot` `llmPromoDetectionSchema` + `sortAndDedupePromoBlocks`.

**Verification**: Invalid JSON throws or returns `{ ok: false }` per product rules.

---

### [x] Task 7: `OpenRouterStorage` (local) + tests with mocked `browser.storage.local`

**Files:**
- Create: `src/background/storage/openrouter-storage.ts`
- Create: `tests/background/storage/openrouter-storage.test.ts`
- Modify: `src/shared/constants.ts` — `STORAGE_KEY_OPENROUTER = 'topskip:openrouter'` (or similar)

Follow pattern from `PrefsSyncStorage` in `src/background/storage/prefs-sync.ts`: static class, Valibot parse on load, `save` validates.

**Verification**: `pnpm exec vitest run tests/background/storage/openrouter-storage.test.ts` passes.

---

### [x] Task 8: Extend `messages.ts` with new runtime types

**Files:**
- Modify: `src/shared/messages.ts`

Add `TOPSKIP_MESSAGE` keys and `TopSkipRuntimeMessage` variants for OpenRouter config + detection + blocks to content. Export TypeScript types for payloads.

**Verification**: `pnpm run lint:types` (or `pnpm run lint`) passes.

---

### [x] Task 9: Background handlers — `GET/SET_OPENROUTER_CONFIG`

**Files:**
- Create: `src/background/messaging/openrouter-runtime-messages.ts`
- Modify: `src/background/background.ts` — register listeners

**Behavior**: `GET` returns `{ enabled, model, apiKeyMasked }` never full key. `SET` validates and persists via `OpenRouterStorage`.

**Verification**: Unit test with mocked browser APIs.

---

### [x] Task 10: Promo analysis pipeline — `onCaptionsSuccess`

**Files:**
- Create: `src/background/messaging/promo-analysis.ts` (or under `openrouter/`)
- Modify: `src/background/messaging/caption-runtime-messages.ts`

**Behavior**:

- If `!prefs.enabled` or `!openRouter.enabled` or missing key → return early (no `fetch`).
- Merge transcript via `mergeCaptionSegmentsToTranscript`.
- `callOpenRouterChat` → parse → store result per `(sender.tab?.id, videoId)`.
- Log per spec (Edge Cases — Analysis visibility): `videoId`, model, segment count, raw assistant text, parsed blocks; optional truncated prompt SHOULD.
- Cancel in-flight if new `videoId` for same tab (FR-016).

**Verification**: Unit tests with mocks; manual smoke with service worker console.

---

### [x] Task 11: Message `TOPSKIP_PROMO_BLOCKS_DETECTED` to content + tab broadcast

**Files:**
- Modify: `src/background/messaging/promo-analysis.ts` — after success, `tabs.sendMessage(tabId, { type, videoId, promoBlocks })`

**Verification**: Content script receives payload (E2E or unit integration).

---

### [x] Task 12: Manifest — `options_ui`, `host_permissions`, content_scripts

**Files:**
- Modify: `src/manifest.json`

**Changes**:

- Add `"options_ui": { "page": "options.html", "open_in_tab": true }` (or `options_page` — pick one, match Rspack output name).
- Add `"https://openrouter.ai/*"` to `host_permissions`.
- Remove static `content_scripts` array **or** empty it once Task 13 registers scripts programmatically.

**Verification**: `pnpm run build` emits valid `dist/manifest.json`.

---

### [x] Task 13: Background — register/unregister content scripts on `enabled`

**Files:**
- Modify: `src/background/background.ts`
- Possibly create: `src/background/lifecycle/content-scripts-registration.ts`

On `Background.init()`, after loading prefs: if `enabled`, `registerContentScripts` with matches including dev localhost when `TOPSKIP_BUILD=dev` (reuse logic from `applyDevLocalhostToManifest` for match list). If `!enabled`, unregister.

Subscribe to prefs updates (existing path) to re-register on toggle.

**Verification**: With `enabled: false`, load youtube.com — no `content.js` in Sources. With `enabled: true`, content script present.

---

### [x] Task 14: Content — `YoutubeWatch` multi-block skip

**Files:**
- Modify: `src/content/youtube-watch.ts`

**Behavior**:

- State: `promoBlocksByVideoId`, `firedBlockIndices` per video, `currentVideoId`.
- On `runtime.onMessage` for `TOPSKIP_PROMO_BLOCKS_DETECTED`, if `videoId` matches, store blocks.
- On `timeupdate`, if blocks present, call `evaluatePromoBlockSkip` from `promo-skip-logic.ts`; else **no fixed skip** (remove `evaluateSkipOnTimeUpdate` path when blocks active per spec).
- When no LLM blocks for current video, **do not** use 30→60 skip (spec: no legacy window). If product still needs “no blocks = no skip”, wire explicitly.

**Verification**: Manual: two blocks seek correctly; unit tests for integration hook if extracted.

---

### [x] Task 15: Options page bundle

**Files:**
- Create: `src/options/index.html`, `src/options/main.tsx`, `src/options/options-app.tsx`
- Modify: `rspack.config.ts` — entry `options`, `HtmlRspackPlugin` for `options.html`

**UI**: Mantine; fields per FR-001–FR-003; load/save via `sendMessage` `TOPSKIP_GET/SET_OPENROUTER_CONFIG`; show errors from response `{ ok: false, error }`.

**Verification**: Load `chrome-extension://…/options.html`, save key, reload page, masked key visible.

---

### [x] Task 16: Popup — link to options + detection status

**Files:**
- Modify: `src/popup/PopupApp.tsx` — `Button` or `Anchor` `onClick={() => browser.runtime.openOptionsPage()}`
- Modify: `src/popup/preferences-store.ts` or new small store — poll or listen for `TOPSKIP_PROMO_DETECTION_UPDATED` for status text

**Verification**: Click opens options; status shows analyzing/detected/error (sanitized).

---

### [x] Task 17: Caption path triggers analysis only when LLM enabled

**Files:**
- Modify: `src/background/messaging/caption-runtime-messages.ts` — call promo pipeline from Task 10

**Verification**: With LLM off, still ack captions but **no** `fetch` to OpenRouter (spy on `fetch`).

---

### [x] Task 18: Developer logging helper

**Files:**
- Create: `src/background/openrouter/log-promo-analysis.ts`

Centralize FR-020 / Edge Cases logging; never log `Authorization`.

**Verification**: Grep `Authorization` in `src/background` — only in `fetch` header construction file.

---

### [x] Task 19: Vitest coverage thresholds

**Files:**
- Modify: `vitest.config.ts` — add `include` globs for new modules if required by project policy

**Verification**: `pnpm run test:coverage` meets thresholds.

---

### [x] Task 20: Playwright E2E

**Files:**
- Modify: `e2e/**/*.ts`

Update flows: extension disabled → no skip behavior; if OpenRouter not mockable in CI, document `test.skip` for live API or inject fixture response via CDP only if feasible — **prefer** unit tests for OpenRouter; E2E for injection + options page load.

**Verification**: `pnpm run build && pnpm run test:e2e` passes in CI.

---

### [x] Task 21: Documentation

**Files:**
- Modify: `DEPLOYMENT.md`, `README.md`, `AGENTS.md`

Document: `openrouter.ai` host permission; options page; user-supplied key; no fixed 30–60 skip when on LLM path.

**Verification**: Markdownlint passes (`pnpm run lint`).

---

## Spec coverage checklist

| Spec section | Task(s) |
|--------------|---------|
| FR-000 OpenRouter HTTP | Task 5, 10 |
| FR-001–003b Options UI | Task 12, 15, 16 |
| FR-004–008 Storage & gates | Task 7, 10, 17 |
| FR-009–011 Request/JSON | Task 1, 5, 6, 10 |
| FR-012–014 Validate + message | Task 3, 6, 11 |
| FR-015 Skip logic | Task 4, 14 |
| FR-016 Stale videoId | Task 10 |
| FR-017–018 Popup status / errors | Task 16 |
| FR-019 Docs | Task 21 |
| FR-020 Logging | Task 18 |
| FR-021 Dynamic injection | Task 13, 14 |
| User stories 1–4 | Tasks 15–17, 16 |
| Edge cases (truncation, logging) | Task 2, 18 |

## Supplement: Promo detection accuracy & observability (2026-04-15)

**Spec**: `.sdd/.current/spec.md` (extends baseline; focuses on prompt clarity, developer log bundles, preset comparison workflow).

| Task | Description | Status |
|------|-------------|--------|
| S.1 | Shared `PROMO_DETECTION_SYSTEM_PROMPT` + wire `promo-analysis.ts` | [x] |
| S.2 | Plain-text analysis log bundle (`log-promo-analysis.ts`) + Vitest | [x] |
| S.3 | Empty merged transcript → no OpenRouter call; bundle on success/error paths | [x] |
| S.4 | `pnpm run openrouter:compare-presets` + `scripts/fixtures/` + `DEVELOPMENT.md` | [x] |

---

## Self-review notes

- **Gap**: Open Question “session storage for detection status” — plan uses in-memory Maps in background first; add `browser.storage.session` only if UX requires (Task 10 follow-up).  
- **Type consistency**: Use single `PromoBlock` type in `promo-types.ts` referenced from `messages.ts` and content.  
- **README vs code**: README still mentions 30s–1min MVP; Task 21 updates to match spec.  
- **No placeholders**: All tasks name concrete files and commands; adjust line numbers after first edit if needed.
