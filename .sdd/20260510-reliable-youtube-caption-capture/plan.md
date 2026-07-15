# Implementation Plan: Reliable YouTube Caption Capture

**Created**: 2026-05-10
**Status**: Validated
**Input**: Feature specification from `.sdd/.current/spec.md`
**Model**: GPT-5.5
**User Input**: no additional constraints

## Summary

Replace the current debug-heavy caption path with a production caption capture
flow that lets the YouTube page player issue its own `/api/timedtext` request,
captures the resulting `json3` body from the MAIN world, parses it into
segments, and restores the user's caption state. Remove obsolete direct
timedtext, InnerTube, get-transcript, and watch-HTML fallback paths from the
runtime flow because probe evidence showed they return empty bodies or bot
walls.

The implementation should preserve existing architecture boundaries:
content script owns page/player interaction, background only installs the
MAIN-world bridge and receives validated caption payloads, and the promo
analysis pipeline continues to start from `TOPSKIP_CAPTIONS_FROM_CONTENT`.

## Technical Context

**Language/Version**: TypeScript 6.0.2, strict, ESM.
**Primary Dependencies**: `webextension-polyfill` 0.12.0, Valibot 1.3.1,
React/Mantine/MobX for UI, Rspack for bundling.
**Storage**: `browser.storage.local` in background only for preferences and
OpenRouter config; this feature adds no persistence.
**Testing**: Vitest 4.1.4 for unit tests, Playwright 1.59.1 for extension e2e.
**Target Platform**: Chrome Manifest V3 extension loaded from `dist/`.
**Project Type**: Single-package browser extension.
**Performance Goals**: Capture should complete within 3 seconds after player
readiness for a healthy supported video; no repeated transcript acquisition per
video id.
**Constraints**: No local server or remote caption proxy; no new non-YouTube
host permissions; no raw token/cookie/caption-body logging in production; avoid
string eval due YouTube Trusted Types.
**Scale/Scope**: Per-tab capture sessions for any number of open YouTube watch
tabs. Popup/status may focus on active tab, but capture state is tab-local.

## Research

### Probe Findings From `tmp/caption-probe-extension`

The MVP probe showed the working path:

- `auto-activate` succeeded with actions:
  `hide-css-injected`, `loadModule:captions`, `setOption:reload`,
  `toggleSubtitlesOn`.
- The page's own XHR produced `main-world-xhr-capture` with `status: 200`,
  `contentType: application/json; charset=UTF-8`, `bodyLength: 449062`, and URL
  shape containing `fmt=json3`, `pot`, `potc`, `signature`, `expire`, `xobt`,
  and `xovt`.
- `auto-capture-seen` arrived about 335 ms after activation.
- `auto-deactivate` restored the off state and removed hide CSS.

The same run showed obsolete paths:

- Direct isolated/main fetches of `baseUrl`, `baseUrl&fmt=json3`, and minimal
  timedtext URL all returned HTTP 200 with empty `text/html` bodies.
- InnerTube `ANDROID`, `IOS`, and `WEB` `/player` calls returned
  `LOGIN_REQUIRED` with "Sign in to confirm you're not a bot".
- Embedded/TV clients returned `ERROR` or unsupported responses.
- Fresh watch HTML did not provide usable caption tracks.

Decision: production runtime should use player-mediated capture as the primary
and only automatic caption acquisition strategy. Obsolete paths can remain only
in historical specs/tests or removed source files, not active fallback logic.

### Existing Caption Architecture

Current source files:

- `src/content/watch-captions.ts` schedules caption work, installs a
  debug-named MAIN-world monitor, parses captured XHR payloads, and still calls
  `fetchYoutubeTranscript(videoId)`.
- `src/background/messaging/caption-network-debug-messages.ts` installs the
  MAIN-world fetch/XHR wrapper and posts captured `json3` timedtext bodies to
  the isolated content script.
- `src/content/captions/youtube-transcript-fetch.ts` contains the obsolete
  direct fetch / watch HTML / InnerTube / get-transcript logic.
- `src/background/messaging/fetch-timedtext-page-messages.ts` supports obsolete
  direct page-world `fetch` of `/api/timedtext`.
- `src/shared/messages.ts` exposes debug-shaped message names
  `FETCH_TIMEDTEXT_PAGE` and `INSTALL_CAPTION_NETWORK_DEBUG`.

Decision: rename the debug installation path into a production
`INSTALL_CAPTION_CAPTURE` bridge, remove `FETCH_TIMEDTEXT_PAGE`, and move the
caption state machine out of ad-hoc debug helpers into focused content modules.

### Existing Patterns To Follow

- Use `browser.*` from `src/shared/browser.ts`, not global `chrome`, except
  when probing `globalThis.chrome.scripting` inside a background helper that
  already follows this pattern.
- Runtime messages are defined in `src/shared/messages.ts` and routed in
  `src/background/messaging/register-runtime-messages.ts`.
- Files grouping one concern use static-only classes, with no empty
  constructors.
- Shared modules must be pure. DOM/player interaction belongs in
  `src/content/`; background MAIN-world script injection belongs in
  `src/background/messaging/`.
- Production comments should explain constraints, not paste spec IDs.

## Entities

### Target Video

- **Fields**:
  - `videoId`: `string` - current YouTube watch video id for one tab.
  - `tabId`: browser tab id, available in background message sender.
- **Relationships**: Owns one `CaptionCaptureSession` in that tab.
- **Validation**: Must be non-empty and must match the video id in captured
  timedtext URL.
- **States**: `unknown` -> `watch-active` -> `stale` on SPA navigation.

### Caption Capture Session

- **Fields**:
  - `videoId`: `string`
  - `state`: `'idle' | 'installing' | 'activating' | 'waiting-capture' |
    'cleaning-up' | 'done' | 'failed'`
  - `startedAtMs`: `number`
  - `captureTimeoutMs`: `number`
  - `activationId`: `string`
  - `wasOn`: `boolean | null`
  - `userIntervened`: `boolean`
- **Relationships**: Uses `CaptionPageBridge` commands and sends a
  `CaptionSegmentPayload` on success.
- **Validation**: Must be cancelled when a newer session for another video id
  starts.
- **States**:
  - `idle` -> `installing` -> `activating` -> `waiting-capture`
  - `waiting-capture` -> `cleaning-up` -> `done`
  - any active state -> `cleaning-up` -> `failed`

### Caption State Snapshot

- **Fields**:
  - `wasOn`: `boolean`
  - `buttonPressedBefore`: `'true' | 'false' | null`
  - `userIntervened`: `boolean`
- **Relationships**: Created in the MAIN-world bridge during activation.
- **Validation**: If `wasOn` is true, cleanup must not turn captions off.

### Temporary Caption Hiding Layer

- **Fields**:
  - `styleId`: `'topskip-caption-hide-style'`
  - `applied`: `boolean`
- **Relationships**: Applied only for sessions that started with captions off.
- **Validation**: Cleanup removes only the style element with this id created by
  TopSkip.

### Captured Timedtext Response

- **Fields**:
  - `videoId`: `string`
  - `languageCode`: `string`
  - `body`: `string`
  - `contentType`: `string | null`
  - `bodyLength`: `number`
  - `urlShape`: `{ pathname: string; paramNames: string[]; fmt: string | null; hasPot: boolean }`
- **Relationships**: Parsed into `CaptionSegmentPayload`.
- **Validation**: Must have current `videoId`, non-empty JSON body, and parse to
  at least one segment.

### Caption Acquisition Failure

- **Fields**:
  - `reason`: `'player-not-ready' | 'activation-unavailable' |
    'capture-timeout' | 'parse-failed' | 'captions-unavailable' |
    'stale-video' | 'bridge-install-failed'`
  - `message`: `string`
- **Relationships**: Sent via existing error branch of
  `TOPSKIP_CAPTIONS_FROM_CONTENT`.
- **Validation**: Must not include raw signed URLs, tokens, cookies, or caption
  body text.

## Contracts

N/A — no network API endpoints are added.

### Runtime Message Summary

| Message | Direction | Description |
| --- | --- | --- |
| `TOPSKIP_INSTALL_CAPTION_CAPTURE` | content -> background | Installs the MAIN-world caption capture bridge in the sender tab. |
| `TOPSKIP_CAPTIONS_FROM_CONTENT` | content -> background | Existing success/error caption payload consumed by promo detection. |
| `TOPSKIP_CONTENT_LOG` | content -> background | Existing bounded diagnostics channel; keep safe metadata only. |

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/content/captions/caption-capture-types.ts` | Create | Shared content-side types/constants for capture sessions, failure reasons, and bridge messages. |
| `src/content/captions/caption-capture-state.ts` | Create | Pure state helpers for dedupe, stale-video checks, and cleanup decisions. |
| `src/content/captions/player-caption-capture.ts` | Create | Content-side session orchestrator: install bridge, activate, wait for capture, parse, cleanup, send payload. |
| `src/background/messaging/caption-page-capture-messages.ts` | Create | Production replacement for debug bridge installer; injects MAIN-world fetch/XHR capture and caption activation/deactivation RPC. |
| `src/content/watch-captions.ts` | Modify | Replace direct fetch scheduling with `PlayerCaptionCapture.scheduleForVideoId`. |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Route `INSTALL_CAPTION_CAPTURE`; remove debug/fetch timedtext routes. |
| `src/shared/messages.ts` | Modify | Add production install message and optional structured caption failure reason; remove obsolete direct timedtext message. |
| `src/shared/constants.ts` | Modify | Rename capture source constants, remove dev-only caption fallback constants if unused. |
| `src/content/captions/youtube-transcript-fetch.ts` | Delete or stop importing | Remove obsolete runtime fallback logic. Keep only if tests/scripts still need it, but no production import may remain. |
| `src/background/messaging/fetch-timedtext-page-messages.ts` | Delete | Remove obsolete direct page-world timedtext fetch handler. |
| `src/background/messaging/caption-network-debug-messages.ts` | Delete | Replaced by production capture bridge. |
| `tests/content/captions/caption-capture-state.test.ts` | Create | Pure state and cleanup decision tests. |
| `tests/content/captions/player-caption-capture.test.ts` | Create | Session orchestration tests with mocked browser/runtime and bridge events. |
| `tests/background/messaging/caption-page-capture-messages.test.ts` | Create | Installer validation and injected function shape tests. |
| `tests/shared/caption-payload-schema.test.ts` | Modify | Cover optional structured failure reason. |
| `tests/content/captions/youtube-transcript-fetch.test.ts` | Delete or replace | Remove tests that preserve obsolete direct-fetch fallbacks. |
| `.sdd/.current/plan.md` | Create | This implementation plan. |

## Tasks

### [x] Task 1: Define Capture Message And Failure Contracts

**Files:**

- Modify: `src/shared/messages.ts:15-66`
- Modify: `src/shared/messages.ts:242-303`
- Test: `tests/shared/caption-payload-schema.test.ts`

- [x] **Step 1: Write the failing test**

Add these cases to `tests/shared/caption-payload-schema.test.ts`:

```ts
it('accepts an error payload with a structured capture reason', () => {
    const r = v.safeParse(captionsFromContentPayloadSchema, {
        ok: false,
        videoId: 'abc',
        error: 'Caption capture timed out',
        reason: 'capture-timeout',
    });
    expect(r.success).toBe(true);
});

it('rejects an unknown structured capture reason', () => {
    const r = v.safeParse(captionsFromContentPayloadSchema, {
        ok: false,
        videoId: 'abc',
        error: 'bad',
        reason: 'raw-youtube-token-missing',
    });
    expect(r.success).toBe(false);
});

it('has a runtime message for installing caption capture', () => {
    expect(TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE).toBe(
        'TOPSKIP_INSTALL_CAPTION_CAPTURE',
    );
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/shared/caption-payload-schema.test.ts
```

Expected: FAIL because `reason` is not in the schema and
`INSTALL_CAPTION_CAPTURE` does not exist.

- [x] **Step 3: Write minimal implementation**

In `src/shared/messages.ts`, add:

```ts
export const CAPTION_CAPTURE_FAILURE_REASON = {
    PlayerNotReady: 'player-not-ready',
    ActivationUnavailable: 'activation-unavailable',
    CaptureTimeout: 'capture-timeout',
    ParseFailed: 'parse-failed',
    CaptionsUnavailable: 'captions-unavailable',
    StaleVideo: 'stale-video',
    BridgeInstallFailed: 'bridge-install-failed',
} as const;

export type CaptionCaptureFailureReason =
    (typeof CAPTION_CAPTURE_FAILURE_REASON)[keyof typeof CAPTION_CAPTURE_FAILURE_REASON];
```

Add to `TOPSKIP_MESSAGE`:

```ts
INSTALL_CAPTION_CAPTURE: 'TOPSKIP_INSTALL_CAPTION_CAPTURE',
```

Replace the error payload schema with:

```ts
const captionCaptureFailureReasonSchema = v.picklist([
    CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady,
    CAPTION_CAPTURE_FAILURE_REASON.ActivationUnavailable,
    CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout,
    CAPTION_CAPTURE_FAILURE_REASON.ParseFailed,
    CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable,
    CAPTION_CAPTURE_FAILURE_REASON.StaleVideo,
    CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
] as const);

const captionsFromContentPayloadErrSchema = v.object({
    ok: v.literal(false),
    videoId: v.pipe(v.string(), v.minLength(1)),
    error: v.string(),
    reason: v.optional(captionCaptureFailureReasonSchema),
});
```

In `TopSkipRuntimeMessage`, replace the old install/direct-fetch members:

```ts
| { type: typeof TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE }
```

Do not keep `FETCH_TIMEDTEXT_PAGE` or `INSTALL_CAPTION_NETWORK_DEBUG` in the
union after the production bridge is wired in Task 7.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/shared/caption-payload-schema.test.ts
```

Expected: PASS.

**Verification**: The shared message contract has a production install message
and bounded caption failure reasons.

### [x] Task 2: Add Pure Capture State Helpers

**Files:**

- Create: `src/content/captions/caption-capture-types.ts`
- Create: `src/content/captions/caption-capture-state.ts`
- Test: `tests/content/captions/caption-capture-state.test.ts`

- [x] **Step 1: Write the failing test**

Create `tests/content/captions/caption-capture-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    shouldIgnoreCapturedTimedtext,
    shouldRestoreCaptionsOff,
    createCaptureSession,
} from '@/content/captions/caption-capture-state';

describe('caption capture state helpers', () => {
    it('ignores stale captured timedtext for another video', () => {
        const session = createCaptureSession('video-a', 1000);
        expect(
            shouldIgnoreCapturedTimedtext(session, {
                videoId: 'video-b',
                languageCode: 'en',
                body: '{}',
                contentType: 'application/json',
                bodyLength: 2,
            }),
        ).toBe(true);
    });

    it('restores captions off only when TopSkip turned them on', () => {
        expect(
            shouldRestoreCaptionsOff({ wasOn: false, userIntervened: false }),
        ).toBe(true);
        expect(
            shouldRestoreCaptionsOff({ wasOn: true, userIntervened: false }),
        ).toBe(false);
        expect(
            shouldRestoreCaptionsOff({ wasOn: false, userIntervened: true }),
        ).toBe(false);
    });

    it('creates unique activation ids', () => {
        const a = createCaptureSession('video-a', 1000);
        const b = createCaptureSession('video-a', 1000);
        expect(a.activationId).not.toBe(b.activationId);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/content/captions/caption-capture-state.test.ts
```

Expected: FAIL because the helper module does not exist.

- [x] **Step 3: Write minimal implementation**

Create `src/content/captions/caption-capture-types.ts`:

```ts
import type { CaptionCaptureFailureReason } from '@/shared/messages';

export type CaptionCaptureState =
    | 'idle'
    | 'installing'
    | 'activating'
    | 'waiting-capture'
    | 'cleaning-up'
    | 'done'
    | 'failed';

export type CaptionCaptureSession = {
    videoId: string;
    activationId: string;
    startedAtMs: number;
    captureTimeoutMs: number;
    state: CaptionCaptureState;
};

export type CaptionCaptureSnapshot = {
    wasOn: boolean;
    userIntervened: boolean;
};

export type CapturedTimedtextPayload = {
    videoId: string;
    languageCode: string;
    body: string;
    contentType: string | null;
    bodyLength: number;
};

export type CaptionCaptureFailure = {
    reason: CaptionCaptureFailureReason;
    message: string;
};
```

Create `src/content/captions/caption-capture-state.ts`:

```ts
import type {
    CaptionCaptureSession,
    CaptionCaptureSnapshot,
    CapturedTimedtextPayload,
} from '@/content/captions/caption-capture-types';

let nextActivationId = 0;

export function createCaptureSession(
    videoId: string,
    captureTimeoutMs: number,
): CaptionCaptureSession {
    nextActivationId += 1;
    return {
        videoId,
        activationId: `topskip-caption-${String(nextActivationId)}`,
        startedAtMs: Date.now(),
        captureTimeoutMs,
        state: 'idle',
    };
}

export function shouldIgnoreCapturedTimedtext(
    session: CaptionCaptureSession,
    payload: CapturedTimedtextPayload,
): boolean {
    return payload.videoId !== session.videoId;
}

export function shouldRestoreCaptionsOff(
    snapshot: CaptionCaptureSnapshot,
): boolean {
    return !snapshot.wasOn && !snapshot.userIntervened;
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/content/captions/caption-capture-state.test.ts
```

Expected: PASS.

**Verification**: Capture decisions are testable without DOM or browser APIs.

### [x] Task 3: Add Content-Side Capture Orchestrator Tests

**Files:**

- Create: `src/content/captions/player-caption-capture.ts`
- Test: `tests/content/captions/player-caption-capture.test.ts`

- [x] **Step 1: Write the failing test**

Create `tests/content/captions/player-caption-capture.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendMessage } = vi.hoisted(() => ({
    mockSendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            sendMessage: mockSendMessage,
        },
    },
}));

import { PlayerCaptionCapture } from '@/content/captions/player-caption-capture';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

describe('PlayerCaptionCapture', () => {
    beforeEach(() => {
        mockSendMessage.mockResolvedValue({ ok: true });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('installs the page bridge before starting capture', async () => {
        const run = PlayerCaptionCapture.captureForVideoId('abc');
        await vi.runOnlyPendingTimersAsync();
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE,
        });
    });

    it('sends a structured timeout failure when no capture arrives', async () => {
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await vi.advanceTimersByTimeAsync(20);
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: false,
                videoId: 'abc',
                reason: 'capture-timeout',
                error: 'Caption capture timed out',
            },
        });
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: FAIL because `player-caption-capture.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

Create `src/content/captions/player-caption-capture.ts` with a static-only
class and public method:

```ts
import { createCaptureSession } from '@/content/captions/caption-capture-state';
import browser from '@/shared/browser';
import {
    CAPTION_CAPTURE_FAILURE_REASON,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

const DEFAULT_CAPTURE_TIMEOUT_MS = 3000;

type CaptureOptions = {
    captureTimeoutMs?: number;
};

export class PlayerCaptionCapture {
    static async captureForVideoId(
        videoId: string,
        options: CaptureOptions = {},
    ): Promise<void> {
        const session = createCaptureSession(
            videoId,
            options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
        );
        await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE,
        });
        await new Promise((resolve) =>
            window.setTimeout(resolve, session.captureTimeoutMs),
        );
        await browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: false,
                videoId,
                reason: CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout,
                error: 'Caption capture timed out',
            },
        });
    }
}
```

This minimal implementation intentionally times out. Later tasks replace the
timeout-only behavior with bridge commands and capture parsing.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: PASS.

**Verification**: The new orchestrator exists and reports bounded failures
without direct timedtext fetches.

### [x] Task 4: Replace WatchCaptions Scheduling With New Orchestrator

**Files:**

- Modify: `src/content/watch-captions.ts:1-399`
- Test: `tests/content/captions/player-caption-capture.test.ts`

- [x] **Step 1: Write the failing test**

Extend `tests/content/captions/player-caption-capture.test.ts`:

```ts
it('does not install the bridge for null video ids', () => {
    PlayerCaptionCapture.scheduleForVideoId(null, 'test');
    expect(mockSendMessage).not.toHaveBeenCalled();
});

it('dedupes repeated schedules for the same video id', () => {
    PlayerCaptionCapture.scheduleForVideoId('abc', 'first');
    PlayerCaptionCapture.scheduleForVideoId('abc', 'second');
    expect(PlayerCaptionCapture.getScheduledVideoIdForTest()).toBe('abc');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: FAIL because `scheduleForVideoId` and `getScheduledVideoIdForTest`
do not exist.

- [x] **Step 3: Write minimal implementation**

Add static scheduling state to `PlayerCaptionCapture`:

```ts
private static scheduledVideoId: string | null = null;

static scheduleForVideoId(videoId: string | null, _source = 'unknown'): void {
    if (videoId === null) {
        PlayerCaptionCapture.scheduledVideoId = null;
        return;
    }
    if (PlayerCaptionCapture.scheduledVideoId === videoId) {
        return;
    }
    PlayerCaptionCapture.scheduledVideoId = videoId;
    void PlayerCaptionCapture.captureForVideoId(videoId);
}

static getScheduledVideoIdForTest(): string | null {
    return PlayerCaptionCapture.scheduledVideoId;
}
```

Then simplify `src/content/watch-captions.ts` to delegate:

```ts
import { E2E_HOST } from '@/content/page-guards';
import { PlayerCaptionCapture } from '@/content/captions/player-caption-capture';
import { CAPTION_TRANSCRIPT_DEV_ENABLED } from '@/shared/constants';

export class WatchCaptions {
    static scheduleForVideoId(
        videoId: string | null,
        source = 'unknown',
    ): void {
        if (!CAPTION_TRANSCRIPT_DEV_ENABLED) {
            return;
        }
        if (videoId === null || location.hostname === E2E_HOST) {
            PlayerCaptionCapture.scheduleForVideoId(null, source);
            return;
        }
        PlayerCaptionCapture.scheduleForVideoId(videoId, source);
    }
}
```

This removes `fetchYoutubeTranscript`, live-caption debug observers, and
agent-only debug logs from `watch-captions.ts`.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: PASS.

**Verification**: `WatchCaptions` no longer calls direct transcript fetch logic.

### [x] Task 5: Build Production MAIN-World Bridge Installer

**Files:**

- Create: `src/background/messaging/caption-page-capture-messages.ts`
- Test: `tests/background/messaging/caption-page-capture-messages.test.ts`

- [x] **Step 1: Write the failing test**

Create `tests/background/messaging/caption-page-capture-messages.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeScript } = vi.hoisted(() => ({
    executeScript: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        scripting: {
            executeScript,
        },
    },
}));

import { CaptionPageCaptureMessages } from '@/background/messaging/caption-page-capture-messages';

describe('CaptionPageCaptureMessages', () => {
    beforeEach(() => {
        executeScript.mockResolvedValue([]);
    });

    it('returns an error without tab id', async () => {
        await expect(CaptionPageCaptureMessages.install(undefined)).resolves.toEqual({
            ok: false,
            error: 'No tab id',
        });
    });

    it('injects the page capture bridge into frame 0 main world', async () => {
        await expect(CaptionPageCaptureMessages.install(123)).resolves.toEqual({
            ok: true,
        });
        expect(executeScript).toHaveBeenCalledWith(
            expect.objectContaining({
                target: { tabId: 123, frameIds: [0] },
                world: 'MAIN',
                func: expect.any(Function),
            }),
        );
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Write minimal implementation**

Create `src/background/messaging/caption-page-capture-messages.ts` by copying
the safe parts of `caption-network-debug-messages.ts` and renaming the class.
The injected function must:

```ts
const INSTALL_FLAG = '__topskipCaptionCaptureInstalled';
const TIMEDTEXT_PATH = '/api/timedtext';
const PAGE_SOURCE = 'TOPSKIP_CAPTION_CAPTURE_PAGE';
const CONTENT_SOURCE = 'TOPSKIP_CAPTION_CAPTURE_CONTENT';
```

Inside the injected MAIN-world function, include these message kinds:

```ts
type PageBridgeMessage =
    | {
          source: typeof PAGE_SOURCE;
          kind: 'timedtext-capture';
          videoId: string | null;
          languageCode: string | null;
          body: string;
          contentType: string | null;
          bodyLength: number;
      }
    | {
          source: typeof PAGE_SOURCE;
          kind: 'command-reply';
          id: string;
          result: unknown;
      };
```

The XHR wrapper must only post bodies when:

```ts
parsed.pathname === timedtextPath &&
parsed.searchParams.get('fmt') === 'json3' &&
this.status >= 200 &&
this.status < 300 &&
text.trimStart().startsWith('{') &&
text.length > 0
```

Keep fetch/XHR wrappers transparent: always return the original `fetch`
promise/response and always call `originalSend.call(this, body ?? null)`.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: PASS.

**Verification**: The production bridge installer exists and is no longer named
debug.

### [x] Task 6: Add MAIN-World Activation And Cleanup RPC

**Files:**

- Modify: `src/background/messaging/caption-page-capture-messages.ts`
- Test: `tests/background/messaging/caption-page-capture-messages.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/background/messaging/caption-page-capture-messages.test.ts`:

```ts
it('injected bridge source mentions activate and deactivate commands', async () => {
    await CaptionPageCaptureMessages.install(123);
    const call = executeScript.mock.calls[0]?.[0];
    expect(String(call.func)).toContain('activate-captions');
    expect(String(call.func)).toContain('deactivate-captions');
    expect(String(call.func)).toContain('ytp-subtitles-button');
    expect(String(call.func)).toContain('topskip-caption-hide-style');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: FAIL until the injected function contains command handling.

- [x] **Step 3: Write minimal implementation**

In the injected function, add `window.message` command handling:

```ts
window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    if (Reflect.get(data, 'source') !== contentSource) return;
    const id = Reflect.get(data, 'id');
    const command = Reflect.get(data, 'command');
    if (typeof id !== 'string' || typeof command !== 'string') return;
    if (command === 'activate-captions') {
        postCommandReply(id, activateCaptions());
        return;
    }
    if (command === 'deactivate-captions') {
        postCommandReply(id, deactivateCaptions());
    }
});
```

The injected `activateCaptions()` must:

- Read `.ytp-subtitles-button[aria-pressed]`.
- If captions are off, inject a `<style id="topskip-caption-hide-style">`
  hiding caption text containers under `#movie_player`.
- Add `pointerdown` and `keydown` listeners to the captions button that mark
  `userIntervened = true`.
- Call safe player methods when present:
  `loadModule('captions')`, `setOption('captions', 'reload', true)`,
  `toggleSubtitlesOn()`.
- Return `{ ok: true, wasOn, userIntervened: false, actions }` or
  `{ ok: false, reason: 'activation-unavailable', actions }`.

The injected `deactivateCaptions()` must:

- Read stored `wasOn` and `userIntervened`.
- If `wasOn` is false and `userIntervened` is false, call available off methods
  such as `toggleSubtitlesOff()`, `setOption('captions', 'track', {})`, and
  `unloadModule('captions')`.
- Remove `topskip-caption-hide-style`.
- Return `{ ok: true, wasOn, userIntervened, actions }`.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: PASS.

**Verification**: The bridge can activate, hide, detect manual intervention,
and clean up without string eval.

### [x] Task 7: Route Production Install Message In Background

**Files:**

- Modify: `src/background/messaging/register-runtime-messages.ts:5-63`
- Modify: `src/shared/messages.ts:15-303`
- Delete: `src/background/messaging/fetch-timedtext-page-messages.ts`
- Delete: `src/background/messaging/caption-network-debug-messages.ts`
- Test: `tests/background/messaging/caption-page-capture-messages.test.ts`

- [x] **Step 1: Write the failing test**

Add a source scan assertion to
`tests/background/messaging/caption-page-capture-messages.test.ts`:

```ts
it('does not expose obsolete timedtext fetch message names', async () => {
    const messages = await import('@/shared/messages');
    expect(
        Reflect.get(messages.TOPSKIP_MESSAGE, 'FETCH_TIMEDTEXT_PAGE'),
    ).toBeUndefined();
    expect(
        Reflect.get(messages.TOPSKIP_MESSAGE, 'INSTALL_CAPTION_NETWORK_DEBUG'),
    ).toBeUndefined();
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: FAIL while obsolete message names still exist.

- [x] **Step 3: Write minimal implementation**

In `register-runtime-messages.ts`:

```ts
import { CaptionPageCaptureMessages } from '@/background/messaging/caption-page-capture-messages';
```

Replace old cases:

```ts
case TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE:
    return CaptionPageCaptureMessages.install(sender.tab?.id);
```

Remove imports and cases for:

```ts
FetchTimedtextPageMessages
CaptionNetworkDebugMessages
TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE
TOPSKIP_MESSAGE.INSTALL_CAPTION_NETWORK_DEBUG
```

Delete the obsolete files after no imports remain.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/background/messaging/caption-page-capture-messages.test.ts tests/shared/caption-payload-schema.test.ts
```

Expected: PASS.

**Verification**: Background routing exposes only the production bridge install
message.

### [x] Task 8: Wire Bridge Commands And Capture Events In Content

**Files:**

- Modify: `src/content/captions/player-caption-capture.ts`
- Test: `tests/content/captions/player-caption-capture.test.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/content/captions/player-caption-capture.test.ts`:

```ts
it('parses captured json3 and sends one successful payload', async () => {
    const raw = JSON.stringify({
        events: [
            {
                tStartMs: 1000,
                dDurationMs: 2000,
                segs: [{ utf8: 'sponsor message' }],
            },
        ],
    });

    const run = PlayerCaptionCapture.captureForVideoId('abc', {
        captureTimeoutMs: 1000,
    });

    window.dispatchEvent(
        new MessageEvent('message', {
            source: window,
            data: {
                source: 'TOPSKIP_CAPTION_CAPTURE_PAGE',
                kind: 'timedtext-capture',
                videoId: 'abc',
                languageCode: 'en',
                contentType: 'application/json; charset=UTF-8',
                bodyLength: raw.length,
                body: raw,
            },
        }),
    );

    await run;

    expect(mockSendMessage).toHaveBeenCalledWith({
        type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
        payload: {
            ok: true,
            videoId: 'abc',
            languageCode: 'en',
            segments: [{ startSec: 1, durationSec: 2, text: 'sponsor message' }],
        },
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: FAIL because capture events are not handled.

- [x] **Step 3: Write minimal implementation**

In `PlayerCaptionCapture`:

- Add a `window.addEventListener('message', ...)` listener once per document.
- Accept only `source === 'TOPSKIP_CAPTION_CAPTURE_PAGE'`.
- For `kind === 'timedtext-capture'`, validate `videoId`, `languageCode`, and
  `body` are strings.
- Ignore stale `videoId`.
- Parse with `parseTranscriptJson3(body)`.
- Send existing `TOPSKIP_CAPTIONS_FROM_CONTENT` success payload.
- Send `deactivate-captions` command after success.

Command RPC helper:

```ts
private static postBridgeCommand(command: string): Promise<unknown> {
    PlayerCaptionCapture.commandSeq += 1;
    const id = String(PlayerCaptionCapture.commandSeq);
    return new Promise((resolve) => {
        PlayerCaptionCapture.pendingCommands.set(id, resolve);
        window.postMessage(
            {
                source: 'TOPSKIP_CAPTION_CAPTURE_CONTENT',
                id,
                command,
            },
            window.location.origin,
        );
    });
}
```

Use `activate-captions` after install and before waiting for capture.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: PASS.

**Verification**: Captured page XHR bodies become validated caption payloads.

### [x] Task 9: Add Cleanup, Timeout, And User-Intervention Behavior

**Files:**

- Modify: `src/content/captions/player-caption-capture.ts`
- Modify: `src/content/captions/caption-capture-state.ts`
- Test: `tests/content/captions/player-caption-capture.test.ts`

- [x] **Step 1: Write the failing test**

Add:

```ts
it('calls deactivate after capture timeout', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const run = PlayerCaptionCapture.captureForVideoId('abc', {
        captureTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    await run;
    expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
            source: 'TOPSKIP_CAPTION_CAPTURE_CONTENT',
            command: 'deactivate-captions',
        }),
        window.location.origin,
    );
});

it('ignores duplicate captures for the same video after success', async () => {
    const raw = JSON.stringify({
        events: [{ tStartMs: 0, dDurationMs: 1, segs: [{ utf8: 'x' }] }],
    });
    const first = PlayerCaptionCapture.captureForVideoId('abc', {
        captureTimeoutMs: 1000,
    });
    const event = new MessageEvent('message', {
        source: window,
        data: {
            source: 'TOPSKIP_CAPTION_CAPTURE_PAGE',
            kind: 'timedtext-capture',
            videoId: 'abc',
            languageCode: 'en',
            contentType: 'application/json',
            bodyLength: raw.length,
            body: raw,
        },
    });
    window.dispatchEvent(event);
    window.dispatchEvent(event);
    await first;
    const successMessages = mockSendMessage.mock.calls.filter(
        ([msg]) =>
            msg.type === TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT &&
            msg.payload.ok === true,
    );
    expect(successMessages).toHaveLength(1);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: FAIL until cleanup and dedupe are complete.

- [x] **Step 3: Write minimal implementation**

Add content-side maps:

```ts
private static readonly sentVideoIds = new Set<string>();
private static activeSession: CaptionCaptureSession | null = null;
private static cleanupStarted = false;
```

On success:

```ts
if (PlayerCaptionCapture.sentVideoIds.has(payload.videoId)) {
    return;
}
PlayerCaptionCapture.sentVideoIds.add(payload.videoId);
```

In `captureForVideoId`, wrap waiting in `try/finally`:

```ts
try {
    await PlayerCaptionCapture.postBridgeCommand('activate-captions');
    await PlayerCaptionCapture.waitForCapture(session);
} finally {
    await PlayerCaptionCapture.postBridgeCommand('deactivate-captions');
    PlayerCaptionCapture.activeSession = null;
}
```

When `scheduleForVideoId(null)` or a new video id arrives, mark the previous
session stale and call `deactivate-captions` best-effort.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/content/captions/player-caption-capture.test.ts
```

Expected: PASS.

**Verification**: Capture sessions clean up on timeout and suppress duplicate
success payloads.

### [x] Task 10: Remove Obsolete Direct Fetch Source And Tests

**Files:**

- Delete or stop importing: `src/content/captions/youtube-transcript-fetch.ts`
- Delete: `tests/content/captions/youtube-transcript-fetch.test.ts`
- Modify: `src/content/watch-captions.ts`
- Modify: `src/shared/constants.ts:48-60`

- [x] **Step 1: Write the failing source scan**

Run:

```bash
rg "fetchYoutubeTranscript|FETCH_TIMEDTEXT_PAGE|CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK|GET_TRANSCRIPT_URL|INNERTUBE_PLAYER_URL" src tests
```

Expected before implementation: matches exist in source/tests.

- [x] **Step 2: Remove obsolete runtime imports**

Ensure `src/content/watch-captions.ts` no longer imports:

```ts
import { fetchYoutubeTranscript } from '@/content/captions/youtube-transcript-fetch';
```

Ensure no source file imports `youtube-transcript-fetch.ts`.

- [x] **Step 3: Remove obsolete files/constants**

Delete obsolete test:

```text
tests/content/captions/youtube-transcript-fetch.test.ts
```

Delete or orphan no-import source file:

```text
src/content/captions/youtube-transcript-fetch.ts
```

Remove unused constants:

```ts
CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK
YOUTUBE_TIMEDTEXT_URL
```

Only remove `YOUTUBE_TIMEDTEXT_URL` if `caption-page-capture-messages.ts` uses
literal path matching and no other source references it.

- [x] **Step 4: Verify source scan is clean**

Run:

```bash
rg "fetchYoutubeTranscript|FETCH_TIMEDTEXT_PAGE|CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK|GET_TRANSCRIPT_URL|INNERTUBE_PLAYER_URL" src tests
```

Expected: no matches.

**Verification**: Obsolete direct-fetch production paths are gone.

### [x] Task 11: Remove Debug Instrumentation From Caption Runtime

**Files:**

- Modify: `src/background/messaging/caption-runtime-messages.ts:24-41`
- Modify: `src/content/watch-captions.ts`
- Modify: `src/shared/constants.ts`
- Test: existing caption tests

- [x] **Step 1: Write the failing source scan**

Run:

```bash
rg "agent log|17a2a8|127\\.0\\.0\\.1:7257|CAPTION_NETWORK_DEBUG_SOURCE|TIMEDTEXT_XHR_CAPTURE_SOURCE|__TOPSKIP_AGENT_CAPTION_DEBUG__" src
```

Expected before implementation: matches exist.

- [x] **Step 2: Remove debug-only logging blocks**

In `caption-runtime-messages.ts`, remove the `fetch('http://127.0.0.1:7257/...')`
agent log region. Keep:

```ts
if (!payload.ok) {
    console.error(LOG_PREFIX_CAPTIONS, payload.error);
    return Promise.resolve({ ok: true });
}
```

In `watch-captions.ts`, remove `sendCaptionDebugLog` and all Hxx hypothesis
logging after delegation to `PlayerCaptionCapture`.

- [x] **Step 3: Remove debug source constants**

Remove constants that are no longer used:

```ts
CAPTION_NETWORK_DEBUG_SOURCE
TIMEDTEXT_XHR_CAPTURE_SOURCE
DEBUG_LOG_SERVER_URL
```

Keep `LOG_PREFIX_CAPTIONS`.

- [x] **Step 4: Verify source scan is clean**

Run:

```bash
rg "agent log|17a2a8|127\\.0\\.0\\.1:7257|CAPTION_NETWORK_DEBUG_SOURCE|TIMEDTEXT_XHR_CAPTURE_SOURCE|__TOPSKIP_AGENT_CAPTION_DEBUG__" src
```

Expected: no matches.

**Verification**: Production source no longer contains the previous debug
session instrumentation.

### [x] Task 12: Add Parser Edge Case Coverage

**Files:**

- Modify: `tests/shared/captions/transcript-json3.test.ts`
- Modify: `src/shared/captions/transcript-json3.ts`

- [x] **Step 1: Write the failing tests**

Add:

```ts
it('rejects empty json3 bodies', () => {
    const r = parseTranscriptJson3('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
        expect(r.error).toMatch(/empty/i);
    }
});

it('skips events without text cues', () => {
    const r = parseTranscriptJson3(
        JSON.stringify({
            events: [{ tStartMs: 0 }, { tStartMs: 1, segs: [{ utf8: '' }] }],
        }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
        expect(r.error).toMatch(/No caption cues/i);
    }
});

it('keeps multiline cue text readable', () => {
    const r = parseTranscriptJson3(
        JSON.stringify({
            events: [
                {
                    tStartMs: 0,
                    dDurationMs: 1000,
                    segs: [{ utf8: 'hello\n' }, { utf8: 'world' }],
                },
            ],
        }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
        expect(r.segments[0]?.text).toBe('hello world');
    }
});
```

- [x] **Step 2: Run test**

Run:

```bash
pnpm run test -- tests/shared/captions/transcript-json3.test.ts
```

Expected: PASS if parser already covers these cases; otherwise FAIL with a
specific parser mismatch.

- [x] **Step 3: Implement only if needed**

If any case fails, update `src/shared/captions/transcript-json3.ts` to preserve
current behavior:

```ts
text = text.replace(/\n/g, ' ').trim();
```

Do not add alternate XML parsing to the new production capture path; captured
player responses are expected to be `json3`.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test -- tests/shared/captions/transcript-json3.test.ts
```

Expected: PASS.

**Verification**: Parser failure modes from the spec are covered.

### [x] Task 13: Add E2E/Manual Verification Notes For Live YouTube

**Files:**

- Modify: `DEVELOPMENT.md`
- Modify: `.sdd/.current/plan.md`

- [x] **Step 1: Add a development note**

Append a short section to `DEVELOPMENT.md`:

```markdown
### Manual caption-capture smoke test

This flow depends on YouTube's live player and is not part of CI.

1. Run `pnpm run build`.
2. Reload `dist/` at `chrome://extensions`.
3. Open a YouTube watch page with known captions and turn YouTube captions off.
4. Confirm TopSkip is enabled.
5. In the extension service worker console, verify a captions payload arrives
   without visible subtitles flashing on the page.
6. Repeat with captions already on and verify TopSkip leaves them on.
```

- [x] **Step 2: Run markdown lint**

Run:

```bash
pnpm run lint:md
```

Expected: PASS.

**Verification**: Engineers have a repeatable live-site smoke test for behavior
that CI should not depend on.

### [x] Task 14: Run Focused And Full Verification

**Files:**

- No source changes.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm run test -- \
  tests/shared/caption-payload-schema.test.ts \
  tests/shared/captions/transcript-json3.test.ts \
  tests/content/captions/caption-capture-state.test.ts \
  tests/content/captions/player-caption-capture.test.ts \
  tests/background/messaging/caption-page-capture-messages.test.ts
```

Expected: PASS.

- [x] **Step 2: Run typecheck**

Run:

```bash
pnpm run lint:types
```

Expected: PASS.

- [x] **Step 3: Run lint**

Run:

```bash
pnpm run lint
```

Expected: PASS.

- [x] **Step 4: Run build**

Run:

```bash
pnpm run build
```

Expected: PASS.

- [x] **Step 5: Run unit and e2e suites**

Run:

```bash
pnpm run test
pnpm run test:e2e
```

Expected: PASS.

**Verification**: The feature satisfies SC-010.

## Spec Coverage Self-Review

- **FR-001..FR-004**: Covered by Tasks 3, 4, 8, and 9.
- **FR-005..FR-010**: Covered by Tasks 2, 6, 8, and 9.
- **FR-011..FR-015**: Covered by Tasks 2, 3, 6, 8, and 9.
- **FR-016..FR-019**: Covered by Tasks 7, 10, and 11.
- **FR-020..FR-021**: Covered by Tasks 5, 8, 11, and source scans.
- **FR-022..FR-023**: Covered by Tasks 5 and 6.
- **FR-024..FR-025**: Covered by Tasks 4, 7, 10, and 14.
- **FR-026**: Covered by Task 13 manual smoke test and Task 8 capture timing
  metadata.
- **FR-027**: Covered by Tasks 1 through 14.

No API contracts are needed. The plan intentionally avoids adding
`webRequest`, local servers, remote proxies, or broad network observation to
the main extension.
