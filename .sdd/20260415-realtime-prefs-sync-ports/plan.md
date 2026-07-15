# Implementation Plan: Real-time Preference Sync via Long-lived Connections

**Created**: 2026-04-15
**Status**: Validated
**Input**: Feature specification from `.sdd/.current/spec.md`
**Model**: claude-opus-4.6
**User Input**: None

## Summary

The popup and options page both manage an "enabled" toggle, but neither
receives live updates when the other page changes it. This plan adds
`browser.runtime.connect`-based long-lived ports so the background can push
`UserPreferences` updates to all connected extension pages instantly. The
existing one-shot `tabs.sendMessage` broadcast to content scripts is
unchanged.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM
**Primary Dependencies**: React 19, Mantine 9, MobX 6, webextension-polyfill,
Valibot, Rspack
**Storage**: `browser.storage.local` (background only)
**Testing**: Vitest 4.x (unit), Playwright (E2E)
**Target Platform**: Chrome MV3 extension
**Project Type**: Single-package repo
**Performance Goals**: N/A (UI sync < 500 ms per SC-001)
**Constraints**: No new permissions; port listeners must register
synchronously at service-worker top level (MV3 requirement)
**Scale/Scope**: Single user, two extension pages (popup + options)

## Research

### Long-lived connections in MV3

`browser.runtime.connect({ name })` returns a `Port`. The background
receives connections via `browser.runtime.onConnect.addListener(port => …)`.
Key behaviors:

- The `onConnect` listener **must be registered synchronously** at the
  top level of the service worker (before any async gap) so the worker
  wakes and handles connections correctly.
- `port.onDisconnect` fires automatically when the connecting page
  (popup or tab) is destroyed.
- `port.postMessage(obj)` on a disconnected port is a silent no-op.
- The popup is destroyed every time it closes; a new port is created on
  each open. This is the expected lifecycle.
- `webextension-polyfill` exposes `browser.runtime.connect` and
  `browser.runtime.onConnect` with the same semantics as the Chrome API.

### Port message typing

The port `onMessage` listener receives untyped `unknown`. We define a
`PrefsPortMessage` type for the messages flowing over this channel and
use a type guard at the receiver side. We reuse the existing
`TOPSKIP_MESSAGE.PREFS_UPDATED` discriminator string so the port message
shape is consistent with the runtime-message broadcast.

### MobX integration (popup)

`PreferencesStore` is a MobX observable. Incoming port messages must
update `this.enabled` inside `runInAction` so React re-renders. The
port listener is set up inside `PreferencesStore` itself (alongside
`load`/`setEnabled`) so the store owns its own lifecycle.

### React integration (options page)

The options page uses plain `useState`. A `useEffect` hook opens the
port on mount, listens for messages, and disconnects on cleanup. When
a `PREFS_UPDATED` message arrives, `setEnabled(prefs.enabled)` is called.

## Entities

### PrefsPort (new concept, not a persisted entity)

- **Fields**:
    - `name`: `"topskip:prefs"` — well-known port name constant
    - `port`: `browser.runtime.Port` — the connected port object
- **Relationships**: Background maintains a `Set<Port>` of all connected
  ports; popup and options each hold one port reference.
- **Validation**: Port name must match `PREFS_PORT_NAME` constant;
  messages must pass `isPrefsPortMessage` type guard.
- **States**: connected → disconnected (terminal; cannot reconnect a
  closed port).

### UserPreferences (existing)

- **Fields**:
    - `enabled`: `boolean`
- No changes to this entity.

## Contracts

N/A — no API endpoints required. Communication uses extension port
messaging.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/constants.ts` | Modify | Add `PREFS_PORT_NAME` constant |
| `src/shared/messages.ts` | Modify | Add `PrefsPortMessage` type and `isPrefsPortMessage` type guard |
| `src/background/messaging/prefs-port-hub.ts` | Create | `PrefsPortHub` static class: `onConnect` listener, port set management, `broadcastPrefsUpdate` |
| `src/background/background.ts` | Modify | Call `PrefsPortHub.register()` inside `Background.init()` (synchronous, before async work) |
| `src/background/messaging/runtime-messages.ts` | Modify | Call `PrefsPortHub.broadcastPrefsUpdate(prefs)` after successful `SET_PREFS` |
| `src/background/messaging/openrouter-runtime-messages.ts` | Modify | Call `PrefsPortHub.broadcastPrefsUpdate(newPrefs)` after successful `SET_OPENROUTER_CONFIG` with changed enabled |
| `src/popup/preferences-store.ts` | Modify | Open port on construction, listen for `PREFS_UPDATED`, update `enabled` via `runInAction`, disconnect method |
| `src/options/options.tsx` | Modify | `useEffect` to open port, listen for `PREFS_UPDATED`, update `enabled` state, disconnect on cleanup |
| `tests/background/messaging/prefs-port-hub.test.ts` | Create | Unit tests for `PrefsPortHub`: connect, disconnect, broadcast, multiple ports |
| `tests/popup/preferences-store.test.ts` | Modify | Add tests for port-based live updates |

## Tasks

### [x] Task 1: Add `PREFS_PORT_NAME` constant

**Files:**

- Modify: `src/shared/constants.ts:51`

- [x] **Step 1: Add the constant**

Add after line 51 (`CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK`):

```typescript
/**
 * Well-known port name for long-lived preference-sync connections
 * between extension pages (popup, options) and the background service
 * worker.
 */
export const PREFS_PORT_NAME = 'topskip:prefs';
```

- [x] **Step 2: Verify the build still compiles**

Run: `pnpm run lint:types`
Expected: PASS (exit 0, no errors)

**Verification**: `PREFS_PORT_NAME` is exported from `src/shared/constants.ts`
and available for import via `@/shared/constants`.

---

### [x] Task 2: Add `PrefsPortMessage` type and type guard

**Files:**

- Modify: `src/shared/messages.ts:151`

- [x] **Step 1: Add type and guard at end of file**

Append after line 151 (after `CaptionsFromContentAck`):

```typescript
/**
 * Message sent over the long-lived prefs port from the background to
 * connected extension pages.
 */
export type PrefsPortMessage = {
  type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED;
  prefs: UserPreferences;
};

/**
 * Type guard for messages received on a prefs port.
 *
 * @param msg Unknown value from `port.onMessage`.
 * @returns Whether `msg` is a valid {@link PrefsPortMessage}.
 */
export function isPrefsPortMessage(msg: unknown): msg is PrefsPortMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type: unknown }).type === TOPSKIP_MESSAGE.PREFS_UPDATED &&
    'prefs' in msg &&
    typeof (msg as { prefs: unknown }).prefs === 'object' &&
    (msg as { prefs: object | null }).prefs !== null &&
    'enabled' in (msg as { prefs: Record<string, unknown> }).prefs &&
    typeof (msg as { prefs: { enabled: unknown } }).prefs.enabled === 'boolean'
  );
}
```

- [x] **Step 2: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: `PrefsPortMessage` and `isPrefsPortMessage` are exported from
`src/shared/messages.ts`.

---

### [x] Task 3: Write failing tests for `PrefsPortHub`

**Files:**

- Create: `tests/background/messaging/prefs-port-hub.test.ts`

- [x] **Step 1: Write the test file**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFS_PORT_NAME } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

/** Minimal Port mock that mirrors `browser.runtime.Port`. */
function createMockPort(name: string = PREFS_PORT_NAME) {
  const onDisconnectListeners: Array<(port: unknown) => void> = [];
  const onMessageListeners: Array<(msg: unknown, port: unknown) => void> = [];
  const port = {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onDisconnect: {
      addListener: vi.fn((fn: (port: unknown) => void) => {
        onDisconnectListeners.push(fn);
      }),
      removeListener: vi.fn(),
    },
    onMessage: {
      addListener: vi.fn((fn: (msg: unknown, port: unknown) => void) => {
        onMessageListeners.push(fn);
      }),
      removeListener: vi.fn(),
    },
  };
  return {
    port,
    /** Simulate the port disconnecting. */
    simulateDisconnect: () => {
      for (const fn of onDisconnectListeners) {
        fn(port);
      }
    },
    /** Simulate a message arriving on the port. */
    simulateMessage: (msg: unknown) => {
      for (const fn of onMessageListeners) {
        fn(msg, port);
      }
    },
  };
}

const onConnectListeners: Array<(port: unknown) => void> = [];

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: {
      onConnect: {
        addListener: vi.fn((fn: (port: unknown) => void) => {
          onConnectListeners.push(fn);
        }),
      },
    },
  },
}));

// Must import after mock setup
import { PrefsPortHub } from
  '@/background/messaging/prefs-port-hub';

describe('PrefsPortHub', () => {
  beforeEach(() => {
    onConnectListeners.length = 0;
    PrefsPortHub.register();
  });

  afterEach(() => {
    // Reset internal state for isolation
    PrefsPortHub.disconnectAll();
    vi.clearAllMocks();
  });

  it('register() adds an onConnect listener', () => {
    expect(onConnectListeners.length).toBe(1);
  });

  it('accepts a port with the correct name', () => {
    const { port } = createMockPort(PREFS_PORT_NAME);
    // Simulate connection
    onConnectListeners[0](port);
    expect(port.onDisconnect.addListener).toHaveBeenCalledOnce();
    expect(PrefsPortHub.connectedCount()).toBe(1);
  });

  it('ignores a port with the wrong name', () => {
    const { port } = createMockPort('some-other-port');
    onConnectListeners[0](port);
    expect(port.onDisconnect.addListener).not.toHaveBeenCalled();
    expect(PrefsPortHub.connectedCount()).toBe(0);
  });

  it('removes a port on disconnect', () => {
    const { port, simulateDisconnect } = createMockPort();
    onConnectListeners[0](port);
    expect(PrefsPortHub.connectedCount()).toBe(1);
    simulateDisconnect();
    expect(PrefsPortHub.connectedCount()).toBe(0);
  });

  it('broadcastPrefsUpdate posts to all connected ports', () => {
    const m1 = createMockPort();
    const m2 = createMockPort();
    onConnectListeners[0](m1.port);
    onConnectListeners[0](m2.port);

    PrefsPortHub.broadcastPrefsUpdate({ enabled: false });

    const expected = {
      type: TOPSKIP_MESSAGE.PREFS_UPDATED,
      prefs: { enabled: false },
    };
    expect(m1.port.postMessage).toHaveBeenCalledWith(expected);
    expect(m2.port.postMessage).toHaveBeenCalledWith(expected);
  });

  it('broadcastPrefsUpdate skips disconnected ports gracefully', () => {
    const m1 = createMockPort();
    const m2 = createMockPort();
    onConnectListeners[0](m1.port);
    onConnectListeners[0](m2.port);
    m2.simulateDisconnect();

    PrefsPortHub.broadcastPrefsUpdate({ enabled: true });
    expect(m1.port.postMessage).toHaveBeenCalledOnce();
    expect(m2.port.postMessage).not.toHaveBeenCalled();
  });

  it('disconnectAll clears all ports', () => {
    const m1 = createMockPort();
    const m2 = createMockPort();
    onConnectListeners[0](m1.port);
    onConnectListeners[0](m2.port);
    expect(PrefsPortHub.connectedCount()).toBe(2);

    PrefsPortHub.disconnectAll();
    expect(PrefsPortHub.connectedCount()).toBe(0);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- tests/background/messaging/prefs-port-hub.test.ts`
Expected: FAIL — module `@/background/messaging/prefs-port-hub` does not exist

**Verification**: All tests fail because the implementation file does not exist.

---

### [x] Task 4: Implement `PrefsPortHub`

**Files:**

- Create: `src/background/messaging/prefs-port-hub.ts`

- [x] **Step 1: Write the implementation**

```typescript
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';
import { PREFS_PORT_NAME, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

/**
 * Manages long-lived port connections from extension pages (popup, options)
 * for real-time preference synchronisation. Not instantiable.
 */
export class PrefsPortHub {
  private constructor() {}

  /** Connected ports. */
  private static ports = new Set<Runtime.Port>();

  /**
   * Registers the `runtime.onConnect` listener. Must be called
   * **synchronously** during service-worker startup (MV3 requirement).
   */
  static register(): void {
    browser.runtime.onConnect.addListener((port: Runtime.Port) => {
      if (port.name !== PREFS_PORT_NAME) {
        return;
      }
      PrefsPortHub.ports.add(port);
      port.onDisconnect.addListener(() => {
        PrefsPortHub.ports.delete(port);
      });
    });
  }

  /**
   * Posts a `PREFS_UPDATED` message to every connected extension-page port.
   *
   * @param prefs Current preferences to broadcast.
   */
  static broadcastPrefsUpdate(prefs: UserPreferences): void {
    const msg = {
      type: TOPSKIP_MESSAGE.PREFS_UPDATED,
      prefs,
    };
    for (const port of PrefsPortHub.ports) {
      try {
        port.postMessage(msg);
      } catch {
        /* Port may have disconnected between iteration start and postMessage;
           onDisconnect will clean it up. */
      }
    }
  }

  /**
   * Returns the number of currently connected ports (testing/diagnostics).
   *
   * @returns Port count.
   */
  static connectedCount(): number {
    return PrefsPortHub.ports.size;
  }

  /**
   * Disconnects and removes all ports (used by tests for isolation).
   */
  static disconnectAll(): void {
    PrefsPortHub.ports.clear();
  }
}
```

- [x] **Step 2: Run tests to verify they pass**

Run: `pnpm run test -- tests/background/messaging/prefs-port-hub.test.ts`
Expected: PASS — all 7 tests pass

**Verification**: `PrefsPortHub` is importable, handles connect/disconnect, and
broadcasts to all connected ports.

---

### [x] Task 5: Wire `PrefsPortHub.register()` into `Background.init()`

**Files:**

- Modify: `src/background/background.ts:1-7` (imports), `src/background/background.ts:59` (inside `init()`)

- [x] **Step 1: Add import**

Add to the imports at the top of `src/background/background.ts`:

```typescript
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
```

- [x] **Step 2: Register ports synchronously in `init()`**

In `Background.init()`, add `PrefsPortHub.register()` as the **first
statement** inside the method body (before `console.info` — the `onConnect`
listener must be registered synchronously at the top level of the service
worker, and `init()` is called synchronously from `index.ts`):

Change `src/background/background.ts` `init()` from:

```typescript
  static init(): void {
    console.info('[TopSkip] Service worker started');
    void PrefsSyncStorage.ready().then(async () => {
```

to:

```typescript
  static init(): void {
    PrefsPortHub.register();
    console.info('[TopSkip] Service worker started');
    void PrefsSyncStorage.ready().then(async () => {
```

- [x] **Step 3: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: `PrefsPortHub.register()` is called synchronously before any
async operations in `Background.init()`.

---

### [x] Task 6: Add port broadcast to `PrefsRuntimeMessages.handleSet`

**Files:**

- Modify: `src/background/messaging/runtime-messages.ts:15` (import), `src/background/messaging/runtime-messages.ts:103` (broadcast call)

- [x] **Step 1: Add import**

Add to the existing imports in `src/background/messaging/runtime-messages.ts`:

```typescript
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
```

- [x] **Step 2: Add port broadcast after existing tab broadcast**

In `handleSet()`, after line 103 (`await PrefsBroadcast.sendUpdatedToAllTabs(prefs);`),
add:

```typescript
      PrefsPortHub.broadcastPrefsUpdate(prefs);
```

The full block (lines 102–104 in the original) becomes:

```typescript
      await ContentScriptsRegistration.syncFromPrefs();
      await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
      PrefsPortHub.broadcastPrefsUpdate(prefs);
      return { ok: true };
```

- [x] **Step 3: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: When the popup calls `SET_PREFS`, connected ports receive
the update.

---

### [x] Task 7: Add port broadcast to `OpenRouterRuntimeMessages.handleSet`

**Files:**

- Modify: `src/background/messaging/openrouter-runtime-messages.ts:6-9` (imports), `src/background/messaging/openrouter-runtime-messages.ts:114` (broadcast call)

- [x] **Step 1: Add import**

Add to the existing imports in
`src/background/messaging/openrouter-runtime-messages.ts`:

```typescript
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
```

- [x] **Step 2: Add port broadcast inside the FR-015 block**

In `handleSet()`, after line 114 (`await PrefsBroadcast.sendUpdatedToAllTabs(newPrefs);`),
add:

```typescript
          PrefsPortHub.broadcastPrefsUpdate(newPrefs);
```

The FR-015 block (lines 107–118 in the original) becomes:

```typescript
      // FR-015: propagate enabled to prefs storage + broadcast
      try {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (prefs.enabled !== enabledRaw) {
          const newPrefs = { enabled: enabledRaw };
          await PrefsSyncStorage.save(newPrefs);
          await ContentScriptsRegistration.syncFromPrefs();
          await PrefsBroadcast.sendUpdatedToAllTabs(newPrefs);
          PrefsPortHub.broadcastPrefsUpdate(newPrefs);
        }
      } catch {
        /* prefs sync is best-effort; OpenRouter save already succeeded */
      }
```

- [x] **Step 3: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: When the options page calls `SET_OPENROUTER_CONFIG` with a
changed `enabled`, connected ports receive the update.

---

### [x] Task 8: Write failing test for popup port subscription

**Files:**

- Modify: `tests/popup/preferences-store.test.ts`

- [x] **Step 1: Extend the browser mock to include `runtime.connect`**

In the existing mock block at the top of the file (lines 6–16), replace the
mock definition:

```typescript
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  connectPostMessage: vi.fn(),
  connectDisconnect: vi.fn(),
  connectOnDisconnect: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
  connectOnMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
}));

const mockPort = {
  name: 'topskip:prefs',
  postMessage: mocks.connectPostMessage,
  disconnect: mocks.connectDisconnect,
  onDisconnect: mocks.connectOnDisconnect,
  onMessage: mocks.connectOnMessage,
};

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: {
      sendMessage: mocks.sendMessage,
      connect: vi.fn(() => mockPort),
    },
  },
}));
```

- [x] **Step 2: Add test for port subscription**

Add the following test inside the existing `describe('PreferencesStore', …)`:

```typescript
  it('connectPort listens for PREFS_UPDATED on the port', () => {
    const store = new PreferencesStore();
    store.connectPort();
    expect(mocks.connectOnMessage.addListener).toHaveBeenCalledOnce();
  });

  it('updates enabled when a PREFS_UPDATED message arrives on the port', () => {
    const store = new PreferencesStore();
    store.connectPort();

    // Grab the listener that was registered
    const listener = mocks.connectOnMessage.addListener.mock
      .calls[0][0] as (msg: unknown) => void;

    // Simulate a message from the background
    listener({
      type: 'TOPSKIP_PREFS_UPDATED',
      prefs: { enabled: false },
    });

    expect(store.enabled).toBe(false);

    listener({
      type: 'TOPSKIP_PREFS_UPDATED',
      prefs: { enabled: true },
    });

    expect(store.enabled).toBe(true);
  });

  it('ignores invalid messages on the port', () => {
    const store = new PreferencesStore();
    store.enabled = true;
    store.connectPort();

    const listener = mocks.connectOnMessage.addListener.mock
      .calls[0][0] as (msg: unknown) => void;

    listener({ type: 'UNKNOWN_TYPE' });
    expect(store.enabled).toBe(true);

    listener(null);
    expect(store.enabled).toBe(true);
  });

  it('disconnectPort calls port.disconnect', () => {
    const store = new PreferencesStore();
    store.connectPort();
    store.disconnectPort();
    expect(mocks.connectDisconnect).toHaveBeenCalledOnce();
  });
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm run test -- tests/popup/preferences-store.test.ts`
Expected: FAIL — `store.connectPort` is not a function

**Verification**: Tests fail because `connectPort` / `disconnectPort` do not
exist on `PreferencesStore` yet.

---

### [x] Task 9: Implement port subscription in `PreferencesStore`

**Files:**

- Modify: `src/popup/preferences-store.ts`

- [x] **Step 1: Add imports**

Add to the existing imports:

```typescript
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import { PREFS_PORT_NAME } from '@/shared/constants';
import { isPrefsPortMessage } from '@/shared/messages';
```

- [x] **Step 2: Add port field and methods to `PreferencesStore`**

Add a private field and two public methods inside the class body (after the
`constructor`):

```typescript
  /** Long-lived port to the background for live preference updates. */
  private port: Runtime.Port | null = null;

  /**
   * Opens a long-lived port to the background and listens for preference
   * updates. Call once on mount; call {@link disconnectPort} on unmount.
   */
  connectPort(): void {
    this.port = browser.runtime.connect({ name: PREFS_PORT_NAME });
    this.port.onMessage.addListener((msg: unknown) => {
      if (isPrefsPortMessage(msg)) {
        runInAction(() => {
          this.enabled = msg.prefs.enabled;
        });
      }
    });
  }

  /**
   * Disconnects the live-update port. Safe to call if not connected.
   */
  disconnectPort(): void {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
  }
```

- [x] **Step 3: Run tests to verify they pass**

Run: `pnpm run test -- tests/popup/preferences-store.test.ts`
Expected: PASS — all tests pass (existing + new)

**Verification**: `PreferencesStore` can connect, receive preference updates,
and disconnect.

---

### [x] Task 10: Wire port lifecycle into `PopupApp`

**Files:**

- Modify: `src/popup/PopupApp.tsx:57-59`

- [x] **Step 1: Extend the existing store-load `useEffect`**

Change the existing `useEffect` that loads the store (lines 57–59):

From:

```typescript
  useEffect(() => {
    void store.load();
  }, [store]);
```

To:

```typescript
  useEffect(() => {
    void store.load();
    store.connectPort();
    return () => {
      store.disconnectPort();
    };
  }, [store]);
```

- [x] **Step 2: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: The popup opens a port on mount and disconnects on unmount.

---

### [x] Task 11: Wire port lifecycle into `OptionsApp`

**Files:**

- Modify: `src/options/options.tsx:24-30` (imports), `src/options/options.tsx:270-272`
  (inside `OptionsApp`, after the existing load `useEffect`)

- [x] **Step 1: Add imports**

Add to the existing imports in `src/options/options.tsx`:

```typescript
import { PREFS_PORT_NAME } from '@/shared/constants';
import { isPrefsPortMessage } from '@/shared/messages';
```

The `browser` import (`import browser from '@/shared/browser';`) already exists
at line 24.

- [x] **Step 2: Add port `useEffect` after the load effect**

After the existing `useEffect` block (lines 270–272), add a new `useEffect`:

```typescript
  useEffect(() => {
    const port = browser.runtime.connect({ name: PREFS_PORT_NAME });
    port.onMessage.addListener((msg: unknown) => {
      if (isPrefsPortMessage(msg)) {
        setEnabled(msg.prefs.enabled);
      }
    });
    return () => {
      port.disconnect();
    };
  }, []);
```

- [x] **Step 3: Verify types compile**

Run: `pnpm run lint:types`
Expected: PASS

**Verification**: The options page opens a port on mount, updates `enabled`
state from incoming messages, and disconnects on unmount.

---

### [x] Task 12: Run full lint and unit test suite

**Files:** (none — verification only)

- [x] **Step 1: Run lint**

Run: `pnpm run lint`
Expected: PASS — no ESLint, markdownlint, or TypeScript errors

- [x] **Step 2: Run all unit tests**

Run: `pnpm run test`
Expected: PASS — all existing tests plus the new
`prefs-port-hub.test.ts` tests pass

- [x] **Step 3: Run coverage**

Run: `pnpm run test:coverage`
Expected: PASS — coverage thresholds met (the new `PrefsPortHub` is not in
the coverage `include` list, but `preferences-store.ts` is, and the new
tests increase its coverage)

**Verification**: No regressions. All existing and new tests pass.

---

### [x] Task 13: Build and run E2E tests

**Files:** (none — verification only)

- [x] **Step 1: Build**

Run: `pnpm run build`
Expected: PASS — `dist/` contains updated bundles

- [x] **Step 2: Run E2E**

Run: `pnpm run test:e2e`
Expected: PASS — existing E2E tests pass (the port feature adds no new E2E
scenarios in this plan; manual verification covers the cross-page sync)

**Verification**: The extension builds and existing E2E tests are not broken
by the port changes.
