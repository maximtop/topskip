# Implementation Plan: Apply Detected Promo Timings as Seeks

**Created**: 2026-04-15
**Status**: Validated
**Input**: Feature specification from `.sdd/.current/spec.md`
**Model**: claude-opus-4.6
**User Input**: None

## Summary

Harden the promo-block "apply" path so that every LLM-detected block is
actually skipped during playback, late-arriving blocks are handled
correctly, fired blocks reset on replay/backward seek, and the `enabled`
flag is unified between the popup and options page. The detection pipeline
is already complete — this plan focuses exclusively on the content-script
skip evaluation, the `firedPromoBlockIndices` lifecycle, the
`computePromoBlockTargetTime` edge cases, and the cross-surface `enabled`
synchronisation in the background.

## Technical Context

**Language/Version**: TypeScript 6.x (strict), ESM
**Primary Dependencies**: React 19, Mantine 9, MobX 6, Valibot 1.3, webextension-polyfill 0.12
**Storage**: `browser.storage.local` (background only); in-memory `Map<number, PromoDetectionStatePayload>` for per-tab detection state
**Testing**: Vitest 4.x (unit), Playwright 1.59 (e2e)
**Target Platform**: Chrome MV3 extension (Chromium)
**Project Type**: Single-package Chrome extension
**Performance Goals**: Skip within one `timeupdate` cycle (~250 ms) after crossing a block boundary
**Constraints**: No new storage keys; no changes to the LLM prompt or detection pipeline; `enabled` toggle respected
**Scale/Scope**: Single-user browser extension; in-memory per-tab state

## Research

### FR-012: `endSec === startSec` or `endSec < startSec` fallback

The current `computePromoBlockTargetTime` in `src/content/promo-skip-logic.ts:31`
only checks `block.endSec > block.startSec`. If `endSec === startSec`, the
condition `endSec > startSec` is `false`, so it already falls back to
`startSec + 30`. This means the only missing case is `endSec < startSec`
(where `endSec` is defined but invalid). The current code would also fall
through correctly since `endSec < startSec` fails the `>` check. **No code
change is needed for FR-012** — the current logic already handles it. We
will add explicit tests to lock this behaviour in.

### FR-004: Replay / backward seek resets fired indices

The current code clears `firedPromoBlockIndices` only when:

1. New blocks arrive via `onPromoBlocksMessage` (`youtube-watch.ts:315`)
2. Video ID changes via `resetForNewVideo` (`youtube-watch.ts:232`)

There is **no** mechanism to reset individual fired indices when the user
seeks backward past a block's `startSec`. FR-004 requires that seeking
back before a block's `startSec` re-enables that block. This requires new
logic in either the `seeked` event handler or the `onTimeUpdate` method.

**Decision**: Add a `resetFiredIndicesOnBackwardSeek` call at the top of
`onTimeUpdate` (before evaluating blocks). When `currentTime < prevTime`
(backward jump detected), iterate `firedPromoBlockIndices` and remove any
index `i` where `blocks[i].startSec > currentTime`. This is simpler and
more reliable than using the `seeked` event (which fires before
`timeupdate` gives us the new position context).

### FR-013–016: Unified `enabled` flag

Currently two independent `enabled` booleans exist:

- `topskip:prefs` → `{ enabled: boolean }` — written by popup via
  `SET_PREFS`, read by content scripts and `PromoAnalysis`
- `topskip:openrouter` → `{ enabled: boolean, apiKey, model, ... }` —
  written by options page via `SET_OPENROUTER_CONFIG`, read by
  `PromoAnalysis`

These can diverge. The spec requires a single authoritative `enabled`
source. The simplest approach that avoids a storage migration:

1. When `SET_PREFS` (popup) writes `enabled`, also propagate to
   `topskip:openrouter.enabled`.
2. When `SET_OPENROUTER_CONFIG` (options) writes `enabled`, also propagate
   to `topskip:prefs.enabled` and broadcast `PREFS_UPDATED` to all tabs.
3. On `Background.init()`, if the two values disagree, resolve by
   preferring `true` (opt-in wins per FR-016) and write both to the
   winning value.

### FR-009: Late-arriving blocks

The current `onPromoBlocksMessage` handler stores blocks and clears
`firedPromoBlockIndices`. On the next `timeupdate`, `evaluatePromoBlocksSkip`
checks `prevTime < startSec && currentTime >= startSec` — for blocks
whose `startSec` is already behind `currentTime`, `prevTime` (set to
`lastTime`, which tracks current playback position) will likely be ≥
`startSec`, so the crossing condition fails naturally. **No code change
is needed for FR-009** — the existing logic handles late arrival correctly
because `lastTime` already represents the current playback position when
blocks arrive. We will add a test to verify this.

### FR-011: `prevTime` set to seek target after skip

This is already implemented in `applyPromoSeek` (`youtube-watch.ts:127`):
`YoutubeWatch.lastTime = targetTime`. **No code change needed.** We will
add a test for this specific invariant.

## Entities

### PromoBlock

- **Fields**:
  - `startSec`: `number` — start of the promo segment in seconds
  - `endSec`: `number | undefined` — end of the segment (optional)
  - `confidence`: `PromoConfidence | undefined` — `'low' | 'medium' | 'high'`
- **Relationships**: Stored in `PromoDetectionStatePayload.promoBlocks[]`
  (background) and `YoutubeWatch.promoBlocks[]` (content)
- **Validation**: `startSec >= 0`; `endSec > startSec` when present;
  clamped to video `duration`
- **States**: N/A (immutable after LLM response parsing)
- **Existing**: `src/shared/promo-types.ts:9-13` — no changes needed

### firedPromoBlockIndices

- **Fields**: `Set<number>` — indices into `promoBlocks[]`
- **Relationships**: Owned by `YoutubeWatch` class; read by
  `evaluatePromoBlocksSkip` via the `firedIndices` parameter
- **Validation**: Indices must be valid array positions
- **States**:
  - Empty → indices added on skip → cleared on new blocks / video change
  - **NEW**: individual indices removed on backward seek past their
    `startSec`
- **Existing**: `src/content/youtube-watch.ts:27` — lifecycle changes
  needed (FR-004)

### PromoBlocksSkipDecision

- **Fields**: `{ action: 'none' }` or `{ action: 'skip'; blockIndex: number; targetTime: number }`
- **Existing**: `src/content/promo-skip-logic.ts:13-15` — no changes
  needed

### PromoDetectionStatePayload

- **Fields**:
  - `videoId`: `string`
  - `status`: `PromoDetectionStatus`
  - `promoBlocks`: `PromoBlock[] | undefined`
  - `error`: `string | undefined`
- **Existing**: `src/shared/messages.ts:79-84` — no changes needed

### UserPreferences

- **Fields**: `{ enabled: boolean }`
- **Existing**: `src/shared/constants.ts:34-36` — no changes needed

### OpenRouterConfig

- **Fields**: `{ enabled: boolean; apiKey: string; model: string; customModels: string[] }`
- **Existing**: `src/background/storage/openrouter-storage.ts:15-23` — no
  changes needed

## Contracts

N/A — no HTTP API endpoints; all communication is via `browser.runtime`
messaging (already defined in `src/shared/messages.ts`).

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/content/promo-skip-logic.ts` | Modify | Add `resetFiredIndicesOnBackwardSeek` export (FR-004) |
| `src/content/youtube-watch.ts` | Modify | Call `resetFiredIndicesOnBackwardSeek` in `onTimeUpdate`; no other logic changes needed |
| `src/background/messaging/runtime-messages.ts` | Modify | After `SET_PREFS` save, propagate `enabled` to OpenRouter storage (FR-014) |
| `src/background/messaging/openrouter-runtime-messages.ts` | Modify | After `SET_OPENROUTER_CONFIG` save, propagate `enabled` to prefs storage + broadcast (FR-015) |
| `src/background/background.ts` | Modify | Add `enabled` reconciliation on init (FR-016) |
| `tests/content/promo-skip-logic.test.ts` | Modify | Add tests for `resetFiredIndicesOnBackwardSeek`, FR-012 edge cases |
| `tests/content/youtube-watch-skip-integration.test.ts` | Create | Integration tests for `onTimeUpdate` flow (FR-001–FR-009, FR-011) |
| `tests/background/messaging/enabled-sync.test.ts` | Create | Tests for cross-surface `enabled` propagation (FR-013–FR-016) |

## Tasks

### [x] Task 1: Add `resetFiredIndicesOnBackwardSeek` to promo-skip-logic

**Files:**

- Modify: `src/content/promo-skip-logic.ts`
- Test: `tests/content/promo-skip-logic.test.ts`

- [ ] **Step 1: Write the failing test for `resetFiredIndicesOnBackwardSeek`**

Add to `tests/content/promo-skip-logic.test.ts`:

```typescript
import {
  computePromoBlockTargetTime,
  evaluatePromoBlocksSkip,
  resetFiredIndicesOnBackwardSeek,
} from '@/content/promo-skip-logic';

// ... existing tests ...

describe('resetFiredIndicesOnBackwardSeek', () => {
  it('removes fired index when currentTime is before block startSec', () => {
    const blocks = [
      { startSec: 10, endSec: 20 },
      { startSec: 50, endSec: 60 },
    ];
    const fired = new Set([0, 1]);
    resetFiredIndicesOnBackwardSeek({
      currentTime: 5,
      prevTime: 55,
      blocks,
      firedIndices: fired,
    });
    expect(fired.has(0)).toBe(false);
    expect(fired.has(1)).toBe(false);
  });

  it('keeps fired index when currentTime is still past block startSec', () => {
    const blocks = [
      { startSec: 10, endSec: 20 },
      { startSec: 50, endSec: 60 },
    ];
    const fired = new Set([0, 1]);
    resetFiredIndicesOnBackwardSeek({
      currentTime: 30,
      prevTime: 55,
      blocks,
      firedIndices: fired,
    });
    expect(fired.has(0)).toBe(true);
    expect(fired.has(1)).toBe(false);
  });

  it('is a no-op when currentTime >= prevTime (forward playback)', () => {
    const blocks = [{ startSec: 10, endSec: 20 }];
    const fired = new Set([0]);
    resetFiredIndicesOnBackwardSeek({
      currentTime: 25,
      prevTime: 20,
      blocks,
      firedIndices: fired,
    });
    expect(fired.has(0)).toBe(true);
  });

  it('is a no-op when firedIndices is empty', () => {
    const blocks = [{ startSec: 10, endSec: 20 }];
    const fired = new Set<number>();
    resetFiredIndicesOnBackwardSeek({
      currentTime: 5,
      prevTime: 25,
      blocks,
      firedIndices: fired,
    });
    expect(fired.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/content/promo-skip-logic.test.ts`
Expected: FAIL — `resetFiredIndicesOnBackwardSeek` is not exported from
`@/content/promo-skip-logic`

- [ ] **Step 3: Write minimal implementation**

Add to the end of `src/content/promo-skip-logic.ts` (before the closing
of the file), after the `evaluatePromoBlocksSkip` function:

```typescript
export type ResetFiredInput = {
  currentTime: number;
  prevTime: number;
  blocks: ReadonlyArray<PromoBlock>;
  firedIndices: Set<number>;
};

/**
 * Clears fired indices for blocks whose `startSec` is now ahead of
 * `currentTime` after a backward seek, so they can fire again on replay
 * (FR-004).
 *
 * @param input - Current playback state and fired set to mutate
 */
export function resetFiredIndicesOnBackwardSeek(
  input: ResetFiredInput,
): void {
  const { currentTime, prevTime, blocks, firedIndices } = input;
  if (currentTime >= prevTime || firedIndices.size === 0) {
    return;
  }
  for (const i of firedIndices) {
    const block = blocks[i];
    if (block !== undefined && block.startSec > currentTime) {
      firedIndices.delete(i);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/content/promo-skip-logic.test.ts`
Expected: PASS — all existing and new tests pass

**Verification**: `pnpm run test -- tests/content/promo-skip-logic.test.ts`
shows all `resetFiredIndicesOnBackwardSeek` tests green.

---

### [x] Task 2: Add FR-012 edge-case tests for `computePromoBlockTargetTime`

**Files:**

- Test: `tests/content/promo-skip-logic.test.ts`

- [ ] **Step 1: Write the tests for FR-012 edge cases**

Add to the existing `describe('computePromoBlockTargetTime', ...)` block
in `tests/content/promo-skip-logic.test.ts`:

```typescript
  it('falls back to start + 30 when endSec equals startSec (FR-012)', () => {
    expect(
      computePromoBlockTargetTime({ startSec: 100, endSec: 100 }, 200),
    ).toBe(130);
  });

  it('falls back to start + 30 when endSec < startSec (FR-012)', () => {
    expect(
      computePromoBlockTargetTime({ startSec: 100, endSec: 50 }, 200),
    ).toBe(130);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm run test -- tests/content/promo-skip-logic.test.ts`
Expected: PASS — existing logic already handles these cases; the tests
lock in the behaviour.

**Verification**: Both new FR-012 tests are green, confirming no code
change is needed.

---

### [x] Task 3: Wire `resetFiredIndicesOnBackwardSeek` into `YoutubeWatch.onTimeUpdate`

**Files:**

- Modify: `src/content/youtube-watch.ts:1` (import) and `src/content/youtube-watch.ts:137-171` (`onTimeUpdate`)

- [ ] **Step 1: Add the import**

In `src/content/youtube-watch.ts`, change line 1 from:

```typescript
import { evaluatePromoBlocksSkip } from '@/content/promo-skip-logic';
```

to:

```typescript
import {
  evaluatePromoBlocksSkip,
  resetFiredIndicesOnBackwardSeek,
} from '@/content/promo-skip-logic';
```

- [ ] **Step 2: Add the `resetFiredIndicesOnBackwardSeek` call in `onTimeUpdate`**

In `src/content/youtube-watch.ts`, in the `onTimeUpdate` method, insert
a call after capturing `currentTime` and `prev` (after line 150) but
before the promo-blocks evaluation (before line 152). The modified
section becomes:

```typescript
    const currentTime = video.currentTime;
    const prev = YoutubeWatch.lastTime;

    if (YoutubeWatch.promoBlocks.length > 0) {
      resetFiredIndicesOnBackwardSeek({
        currentTime,
        prevTime: prev,
        blocks: YoutubeWatch.promoBlocks,
        firedIndices: YoutubeWatch.firedPromoBlockIndices,
      });

      const decision = evaluatePromoBlocksSkip({
```

- [ ] **Step 3: Run full unit tests**

Run: `pnpm run test`
Expected: PASS — no tests break from this wiring change

- [ ] **Step 4: Run lint and type-check**

Run: `pnpm run lint`
Expected: PASS — no lint or type errors

**Verification**: `pnpm run test` and `pnpm run lint` both pass.

---

### [x] Task 4: Add integration tests for the `onTimeUpdate` skip pipeline

**Files:**

- Create: `tests/content/youtube-watch-skip-integration.test.ts`

This test file exercises the interaction between `evaluatePromoBlocksSkip`
and `resetFiredIndicesOnBackwardSeek` in a simulated `onTimeUpdate` loop.
Since `YoutubeWatch` is a static class with private methods, we test the
exported pure functions in combination to verify the pipeline behaviour
described in FR-001 through FR-009 and FR-011.

- [ ] **Step 1: Create the integration test file**

Create `tests/content/youtube-watch-skip-integration.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  evaluatePromoBlocksSkip,
  resetFiredIndicesOnBackwardSeek,
  computePromoBlockTargetTime,
} from '@/content/promo-skip-logic';
import type { PromoBlock } from '@/shared/promo-types';

/**
 * Simulates the YoutubeWatch.onTimeUpdate loop by calling
 * resetFiredIndicesOnBackwardSeek then evaluatePromoBlocksSkip, mirroring
 * the real code path in youtube-watch.ts.
 */
function simulateTimeUpdate(params: {
  prevTime: number;
  currentTime: number;
  duration: number;
  isSeeking: boolean;
  firedIndices: Set<number>;
  blocks: PromoBlock[];
}): { action: 'none' } | { action: 'skip'; blockIndex: number; targetTime: number } {
  const { prevTime, currentTime, duration, isSeeking, firedIndices, blocks } =
    params;

  resetFiredIndicesOnBackwardSeek({
    currentTime,
    prevTime,
    blocks,
    firedIndices,
  });

  return evaluatePromoBlocksSkip({
    prevTime,
    currentTime,
    duration,
    isSeeking,
    firedIndices,
    blocks,
  });
}

describe('onTimeUpdate skip pipeline integration', () => {
  it('FR-001: skips when crossing a block start naturally', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [{ startSec: 105, endSec: 135 }];
    const d = simulateTimeUpdate({
      prevTime: 104.8,
      currentTime: 105.2,
      duration: 600,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d).toEqual({ action: 'skip', blockIndex: 0, targetTime: 135 });
    expect(fired.has(0)).toBe(false); // caller adds it after applyPromoSeek
  });

  it('FR-001: uses start + 30 when endSec absent', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [{ startSec: 200 }];
    const d = simulateTimeUpdate({
      prevTime: 199.5,
      currentTime: 200.3,
      duration: 600,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d).toEqual({ action: 'skip', blockIndex: 0, targetTime: 230 });
  });

  it('FR-001: clamps to duration when target exceeds it', () => {
    const target = computePromoBlockTargetTime({ startSec: 200 }, 210);
    expect(target).toBe(210); // min(230, 210)
  });

  it('FR-003: does not skip when enabled is simulated off (no blocks evaluated)', () => {
    // This test verifies the contract: when no blocks are passed
    // (simulating disabled state), no skip fires.
    const fired = new Set<number>();
    const d = simulateTimeUpdate({
      prevTime: 104.8,
      currentTime: 105.2,
      duration: 600,
      isSeeking: false,
      firedIndices: fired,
      blocks: [],
    });
    expect(d.action).toBe('none');
  });

  it('FR-004: backward seek resets fired indices for replay', () => {
    const blocks: PromoBlock[] = [{ startSec: 45, endSec: 75 }];
    const fired = new Set([0]);

    // Simulate seeking back to before the block
    const d = simulateTimeUpdate({
      prevTime: 80,
      currentTime: 10,
      duration: 300,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    // The large delta prevents a skip from firing here, but the
    // fired index should have been cleared
    expect(fired.has(0)).toBe(false);

    // Now simulate natural playback crossing the block again
    const d2 = simulateTimeUpdate({
      prevTime: 44.5,
      currentTime: 45.3,
      duration: 300,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d2).toEqual({ action: 'skip', blockIndex: 0, targetTime: 75 });
  });

  it('FR-005: SPA navigation resets are handled by resetForNewVideo (no pipeline test needed)', () => {
    // This is tested by verifying that a fresh firedIndices set
    // allows all blocks to fire. resetForNewVideo clears the set
    // and replaces blocks — both are constructor-level resets.
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [{ startSec: 30, endSec: 60 }];
    const d = simulateTimeUpdate({
      prevTime: 29,
      currentTime: 31,
      duration: 300,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d.action).toBe('skip');
  });

  it('FR-006: does not skip when isSeeking is true', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [{ startSec: 10, endSec: 20 }];
    const d = simulateTimeUpdate({
      prevTime: 9,
      currentTime: 11,
      duration: 120,
      isSeeking: true,
      firedIndices: fired,
      blocks,
    });
    expect(d.action).toBe('none');
  });

  it('FR-008: large delta suppresses skip (tab backgrounding)', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [{ startSec: 10, endSec: 20 }];
    const d = simulateTimeUpdate({
      prevTime: 0,
      currentTime: 15,
      duration: 120,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d.action).toBe('none');
  });

  it('FR-009: late-arriving blocks do not retroactively seek', () => {
    // Simulate: playback is at 65s, blocks arrive with startSec 30 and 120.
    // The block at 30 should NOT fire (prevTime=65, 65 < 30 is false).
    // The block at 120 should fire later.
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [
      { startSec: 30, endSec: 45 },
      { startSec: 120, endSec: 150 },
    ];

    // First timeupdate after blocks arrive: currentTime=65, prevTime=64.5
    const d1 = simulateTimeUpdate({
      prevTime: 64.5,
      currentTime: 65,
      duration: 600,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d1.action).toBe('none'); // block at 30 is past; 120 not reached

    // Later: crossing 120
    const d2 = simulateTimeUpdate({
      prevTime: 119.5,
      currentTime: 120.3,
      duration: 600,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d2).toEqual({ action: 'skip', blockIndex: 1, targetTime: 150 });
  });

  it('FR-011: after skip, lastTime should be targetTime (verified by next call)', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [
      { startSec: 10, endSec: 20 },
      { startSec: 25, endSec: 35 },
    ];

    // Skip first block
    const d1 = simulateTimeUpdate({
      prevTime: 9,
      currentTime: 11,
      duration: 120,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d1).toEqual({ action: 'skip', blockIndex: 0, targetTime: 20 });
    fired.add(0); // simulate YoutubeWatch adding the index

    // After skip, lastTime is set to targetTime (20). Next timeupdate
    // comes with prevTime=20 (the targetTime), currentTime=20.5.
    // Block at 25 should NOT fire yet.
    const d2 = simulateTimeUpdate({
      prevTime: 20,
      currentTime: 20.5,
      duration: 120,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d2.action).toBe('none');

    // Crossing block 2
    const d3 = simulateTimeUpdate({
      prevTime: 24.5,
      currentTime: 25.3,
      duration: 120,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d3).toEqual({ action: 'skip', blockIndex: 1, targetTime: 35 });
  });

  it('multiple blocks: skips each in order', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [
      { startSec: 30, endSec: 45 },
      { startSec: 90, endSec: 110 },
    ];

    const d1 = simulateTimeUpdate({
      prevTime: 29,
      currentTime: 31,
      duration: 300,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d1).toEqual({ action: 'skip', blockIndex: 0, targetTime: 45 });
    fired.add(0);

    const d2 = simulateTimeUpdate({
      prevTime: 89,
      currentTime: 91,
      duration: 300,
      isSeeking: false,
      firedIndices: fired,
      blocks,
    });
    expect(d2).toEqual({ action: 'skip', blockIndex: 1, targetTime: 110 });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm run test -- tests/content/youtube-watch-skip-integration.test.ts`
Expected: PASS — all integration tests pass with the functions
implemented in Tasks 1 and 3.

**Verification**: All integration tests green.

---

### [x] Task 5: Propagate `enabled` from `SET_PREFS` to OpenRouter storage (FR-014)

**Files:**

- Modify: `src/background/messaging/runtime-messages.ts:76-92`
- Test: `tests/background/messaging/enabled-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/background/messaging/enabled-sync.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sendMessage = vi.fn();
const storageGet = vi.fn();
const storageSet = vi.fn();
const tabsQuery = vi.fn().mockResolvedValue([]);
const tabsSendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: { sendMessage },
    storage: { local: { get: storageGet, set: storageSet } },
    tabs: { query: tabsQuery, sendMessage: tabsSendMessage },
    scripting: {
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { PrefsRuntimeMessages } from
  '@/background/messaging/runtime-messages';
import { STORAGE_KEY_PREFS, STORAGE_KEY_OPENROUTER } from
  '@/shared/constants';

describe('SET_PREFS propagates enabled to OpenRouter storage (FR-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PrefsSyncStorage.ready() — seed prefs
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: false,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });
    storageSet.mockResolvedValue(undefined);
  });

  it('updates OpenRouter enabled when popup sets enabled=false', async () => {
    const result = await PrefsRuntimeMessages.handle(
      { type: 'TOPSKIP_SET_PREFS', enabled: false },
      { id: 'test' },
    );
    expect(result).toEqual({ ok: true });

    // Verify that storage.set was called for BOTH keys
    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();

    const orSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCall).toBeDefined();
    const orValue = (orSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_OPENROUTER
    ];
    expect(orValue.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: FAIL — `SET_PREFS` does not currently write to OpenRouter
storage, so the `orSetCall` assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/background/messaging/runtime-messages.ts`, add an import for
`OpenRouterStorage`:

```typescript
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
```

Then modify the `handleSet` method. After the `PrefsSyncStorage.save(prefs)`
call (line 85) and before `ContentScriptsRegistration.syncFromPrefs()`
(line 86), add the propagation:

```typescript
      await PrefsSyncStorage.save(prefs);

      // FR-014: propagate enabled to OpenRouter storage
      try {
        const orConfig = await OpenRouterStorage.load();
        if (orConfig.enabled !== prefs.enabled) {
          await OpenRouterStorage.save({
            ...orConfig,
            enabled: prefs.enabled,
          });
        }
      } catch {
        /* OpenRouter storage may reject if key/model empty + enabled=true;
           that is fine — the prefs save already succeeded. */
      }

      await ContentScriptsRegistration.syncFromPrefs();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: PASS

**Verification**: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
shows the propagation test green.

---

### [x] Task 6: Propagate `enabled` from `SET_OPENROUTER_CONFIG` to prefs storage (FR-015)

**Files:**

- Modify: `src/background/messaging/openrouter-runtime-messages.ts:78-103`
- Test: `tests/background/messaging/enabled-sync.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/background/messaging/enabled-sync.test.ts`:

```typescript
import { OpenRouterRuntimeMessages } from
  '@/background/messaging/openrouter-runtime-messages';

describe('SET_OPENROUTER_CONFIG propagates enabled to prefs (FR-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });
    storageSet.mockResolvedValue(undefined);
    tabsQuery.mockResolvedValue([]);
  });

  it('updates prefs enabled and broadcasts when options sets enabled=false', async () => {
    const result = await OpenRouterRuntimeMessages.handle(
      {
        type: 'TOPSKIP_SET_OPENROUTER_CONFIG',
        enabled: false,
        apiKey: '',
        model: 'test/model',
      },
      { id: 'test' },
    );
    expect(result).toEqual({ ok: true });

    // Verify prefs storage was updated
    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();
    const prefsValue = (prefsSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_PREFS
    ];
    expect(prefsValue.enabled).toBe(false);

    // Verify broadcast was sent to all tabs
    expect(tabsQuery).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: FAIL — `SET_OPENROUTER_CONFIG` does not currently write to
prefs storage.

- [ ] **Step 3: Write minimal implementation**

In `src/background/messaging/openrouter-runtime-messages.ts`, add imports:

```typescript
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { PrefsBroadcast } from
  '@/background/messaging/broadcast-prefs-updated';
import {
  ContentScriptsRegistration,
} from '@/background/lifecycle/content-scripts-registration';
```

Then modify the `handleSet` method. After the `OpenRouterStorage.save()`
call (line 93-98) and before `return { ok: true }` (line 99), add:

```typescript
      await OpenRouterStorage.save({
        enabled: enabledRaw,
        apiKey,
        model: modelRaw,
        customModels: current.customModels,
      });

      // FR-015: propagate enabled to prefs storage + broadcast
      try {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (prefs.enabled !== enabledRaw) {
          const newPrefs = { enabled: enabledRaw };
          await PrefsSyncStorage.save(newPrefs);
          await ContentScriptsRegistration.syncFromPrefs();
          await PrefsBroadcast.sendUpdatedToAllTabs(newPrefs);
        }
      } catch {
        /* prefs sync is best-effort; OpenRouter save already succeeded */
      }

      return { ok: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: PASS

**Verification**: FR-015 test is green.

---

### [x] Task 7: Reconcile divergent `enabled` flags on background init (FR-016)

**Files:**

- Modify: `src/background/background.ts`
- Test: `tests/background/messaging/enabled-sync.test.ts` (append)

- [ ] **Step 1: Read the current `background.ts` to determine exact insertion point**

Read `src/background/background.ts` to see the current `init()` body.

- [ ] **Step 2: Write the failing test**

Append to `tests/background/messaging/enabled-sync.test.ts`:

```typescript
import { reconcileDivergentEnabled } from '@/background/background';

describe('reconcileDivergentEnabled (FR-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageSet.mockResolvedValue(undefined);
  });

  it('resolves to true when prefs=true but openrouter=false', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: false,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    const orSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCall).toBeDefined();
    const orValue = (orSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_OPENROUTER
    ];
    expect(orValue.enabled).toBe(true);
  });

  it('resolves to true when prefs=false but openrouter=true', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: false },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();
    const prefsValue = (prefsSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_PREFS
    ];
    expect(prefsValue.enabled).toBe(true);
  });

  it('does nothing when both agree', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    // Only PrefsSyncStorage.ready() seed calls — no extra writes
    // to unify since they already agree.
    const orSetCalls = storageSet.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCalls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: FAIL — `reconcileDivergentEnabled` is not exported from
`@/background/background`

- [ ] **Step 4: Write minimal implementation**

In `src/background/background.ts`, add the function and export it.
Add imports for `OpenRouterStorage` and `PrefsSyncStorage`:

```typescript
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
```

Add the exported function (before or after the `Background` class):

```typescript
/**
 * On startup, if the two `enabled` flags (`topskip:prefs` vs
 * `topskip:openrouter`) disagree, resolve to `true` (opt-in wins) and
 * write the unified value to both storage keys (FR-016).
 *
 * @returns Promise that settles after reconciliation (or no-op)
 */
export async function reconcileDivergentEnabled(): Promise<void> {
  await PrefsSyncStorage.ready();
  const prefs = await PrefsSyncStorage.load();
  const orConfig = await OpenRouterStorage.load();

  if (prefs.enabled === orConfig.enabled) {
    return; // already in sync
  }

  const unified = true; // opt-in wins per FR-016

  if (!prefs.enabled) {
    await PrefsSyncStorage.save({ enabled: unified });
  }
  if (!orConfig.enabled) {
    try {
      await OpenRouterStorage.save({ ...orConfig, enabled: unified });
    } catch {
      /* OpenRouter may reject if key/model empty; prefs is authoritative */
    }
  }
}
```

Then wire it into `Background.init()` by calling it after
`PrefsSyncStorage.ready()` resolves:

```typescript
  static init(): void {
    void PrefsSyncStorage.ready().then(async () => {
      await reconcileDivergentEnabled();
      await ContentScriptsRegistration.syncFromPrefs();
    });
    registerRuntimeMessages();
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite and lint**

Run: `pnpm run test && pnpm run lint`
Expected: PASS

**Verification**: All tests pass, lint clean.

---

### [x] Task 8: Add coverage threshold for `promo-skip-logic.ts`

**Files:**

- Modify: `vitest.config.ts`

- [ ] **Step 1: Update vitest.config.ts to include promo-skip-logic in coverage**

In `vitest.config.ts`, add `'src/content/promo-skip-logic.ts'` to the
coverage `include` array. The existing entries are:

```typescript
include: [
  'src/content/skip-logic.ts',
  'src/content/page-guards.ts',
  'src/popup/preferences-store.ts',
],
```

Change to:

```typescript
include: [
  'src/content/skip-logic.ts',
  'src/content/promo-skip-logic.ts',
  'src/content/page-guards.ts',
  'src/popup/preferences-store.ts',
],
```

- [ ] **Step 2: Run coverage to verify thresholds pass**

Run: `pnpm run test:coverage`
Expected: PASS — the new and existing tests for `promo-skip-logic.ts`
should exceed the 80% thresholds.

**Verification**: `pnpm run test:coverage` passes with
`promo-skip-logic.ts` meeting the coverage thresholds.

---

### [x] Task 9: Build and run E2E tests

**Files:**

- No file changes — validation only

- [ ] **Step 1: Build the extension**

Run: `pnpm run build`
Expected: PASS — clean build

- [ ] **Step 2: Run E2E tests**

Run: `pnpm run test:e2e`
Expected: PASS — existing E2E tests continue to pass. The key E2E test
"fixture page: no fixed 30s→60s jump without promo blocks" validates
that without promo blocks, playback proceeds normally (no regression).
The "popup toggle disables skip" test validates the enabled toggle still
works.

**Verification**: `pnpm run build && pnpm run test:e2e` both pass.

---

### [x] Task 10: Full CI simulation

**Files:**

- No file changes — final validation

- [ ] **Step 1: Run the full CI pipeline locally**

Run:

```bash
pnpm run lint && pnpm run build && pnpm run test && pnpm run test:coverage && pnpm run test:e2e
```

Expected: PASS — all steps succeed, matching the CI pipeline in
`.github/workflows/ci.yml`.

**Verification**: All five commands pass cleanly.
