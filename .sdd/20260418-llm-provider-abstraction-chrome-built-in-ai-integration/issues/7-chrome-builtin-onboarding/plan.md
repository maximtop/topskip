# Implementation Plan: Chrome Built-in onboarding widget

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/7-chrome-builtin-onboarding/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: Claude Opus 4.6 (copilot) high
**User Input**: None

## Summary

Replace the placeholder `ChromeBuiltinPanel` with a multi-state onboarding widget covering the full Gemini Nano lifecycle: unavailable → downloadable → downloading → available. Add `GET_CHROME_PROMPT_API_STATUS` and `TRIGGER_CHROME_MODEL_DOWNLOAD` runtime messages so the options page can query status and initiate model downloads. The background handler delegates to `ChromePromptApiAdapter.availability()` and manages download sessions with `LanguageModel.create({ monitor })` for progress tracking.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM
**Primary Dependencies**: React 19.2+, Mantine 9.x (`Paper`, `Stack`, `Text`, `Title`, `Badge`, `Button`, `Progress`), `@types/dom-chromium-ai` (LanguageModel + CreateMonitor typings)
**Storage**: N/A — Chrome manages model state; download progress is ephemeral in the background
**Testing**: Vitest 4.x; SSR via `renderToStaticMarkup` + `MantineProvider` (existing pattern in `tests/options/provider-panels.test.ts`)
**Target Platform**: Chrome MV3 extension options page

## Research

### Existing options panel pattern

`ChromeBuiltinPanel` currently receives a single `availability` prop of type `ProviderAvailabilityMessage` and renders placeholder text. `OpenRouterConfigPanel` is a pure presentational component receiving all state + callbacks via props. The test pattern uses `renderToStaticMarkup` wrapped in `MantineProvider` + `topskipTheme`. The plan follows this same pattern for the onboarding widget.

### How availability reaches the options page today

`options.tsx` calls `GET_PROVIDER_LIST` on load, which returns `ProviderListItem[]` with `availability` per provider. The `chromeAvailability` useMemo extracts the Chrome provider's availability from this list. The new `GET_CHROME_PROMPT_API_STATUS` message provides a dedicated, lighter query for just Chrome status — used for polling during download.

### Download progress via `LanguageModel.create({ monitor })`

Chrome's Prompt API exposes download progress through the `monitor` callback in `LanguageModel.create()`. The `CreateMonitor` fires `downloadprogress` (standard `ProgressEvent` with `loaded` / `total`). The background handler triggers a download by calling `LanguageModel.create({ monitor })` and tracks the latest progress percentage. The options page polls `GET_CHROME_PROMPT_API_STATUS` at an interval to read the latest progress.

### Message handler pipeline in register-runtime-messages.ts

New message types are inserted into the existing chain in `registerRuntimeMessages()`. Each handler returns `undefined` to pass through or a `Promise<Response>` to handle. The Chrome-specific handler (`ChromePromptApiRuntimeMessages`) follows the same static-class pattern as `ProviderRuntimeMessages`.

## Entities

N/A — no new data entities. The onboarding widget is purely presentational; availability state comes from Chrome's `LanguageModel` API.

## Contracts

N/A — no API endpoints required. Two new runtime messages are added:

| Message | Direction | Shape |
|---------|-----------|-------|
| `GET_CHROME_PROMPT_API_STATUS` | Options → Background | Response: `{ ok: true; availability: ProviderAvailabilityMessage; downloadProgress: number \| null }` |
| `TRIGGER_CHROME_MODEL_DOWNLOAD` | Options → Background | Response: `{ ok: true } \| { ok: false; error: string }` |

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/options/ChromeBuiltinOnboarding.tsx` | Create | Multi-state onboarding component (unavailable / downloadable / downloading / available) |
| `src/options/ChromeBuiltinPanel.tsx` | Modify | Replace placeholder with `ChromeBuiltinOnboarding`, add `onDownload` callback prop, add `downloadProgress` prop |
| `src/shared/messages.ts` | Modify | Add `GET_CHROME_PROMPT_API_STATUS`, `TRIGGER_CHROME_MODEL_DOWNLOAD` message types + response types |
| `src/background/messaging/chrome-prompt-api-runtime-messages.ts` | Create | Handle `GET_CHROME_PROMPT_API_STATUS` and `TRIGGER_CHROME_MODEL_DOWNLOAD` |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Insert `ChromePromptApiRuntimeMessages.handle()` into the listener chain |
| `src/options/options.tsx` | Modify | Add download trigger callback + polling for Chrome status, pass new props to `ChromeBuiltinPanel` |
| `tests/options/provider-panels.test.ts` | Modify | Replace placeholder test with per-state onboarding tests |
| `tests/background/messaging/chrome-prompt-api-runtime-messages.test.ts` | Create | Unit tests for new message handlers |

## Tasks

### [ ] Task 1: Add message types to `src/shared/messages.ts`

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add message constants and response types**

In `src/shared/messages.ts`, add to `TOPSKIP_MESSAGE`:

```ts
  GET_CHROME_PROMPT_API_STATUS: 'TOPSKIP_GET_CHROME_PROMPT_API_STATUS',
  TRIGGER_CHROME_MODEL_DOWNLOAD: 'TOPSKIP_TRIGGER_CHROME_MODEL_DOWNLOAD',
```

Add response types after the existing `GetProviderListResponse`:

```ts
export type GetChromePromptApiStatusResponse =
  | {
      ok: true;
      availability: ProviderAvailabilityMessage;
      downloadProgress: number | null;
    }
  | { ok: false; error: string };

export type TriggerChromeModelDownloadResponse =
  | { ok: true }
  | { ok: false; error: string };
```

Add the union members to `TopSkipRuntimeMessage`:

```ts
  | { type: typeof TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS }
  | { type: typeof TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD }
```

- [ ] **Step 2: Run lint to verify types are correct**

Run: `pnpm run lint`
Expected: PASS

**Verification**: `GetChromePromptApiStatusResponse` and `TriggerChromeModelDownloadResponse` types exist in `messages.ts`. Lint passes.

---

### [ ] Task 2: Background message handler for Chrome status + download

**Files:**
- Create: `src/background/messaging/chrome-prompt-api-runtime-messages.ts`
- Test: `tests/background/messaging/chrome-prompt-api-runtime-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import {
  TOPSKIP_MESSAGE,
  type GetChromePromptApiStatusResponse,
  type TriggerChromeModelDownloadResponse,
} from '@/shared/messages';

const fakeSender: Runtime.MessageSender = {};

const { ChromePromptApiRuntimeMessages } = await import(
  '@/background/messaging/chrome-prompt-api-runtime-messages'
);

describe('ChromePromptApiRuntimeMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('handle', () => {
    it('returns undefined for unrelated messages', () => {
      const result = ChromePromptApiRuntimeMessages.handle(
        { type: 'SOME_OTHER_MSG' },
        fakeSender,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('GET_CHROME_PROMPT_API_STATUS', () => {
    it('returns unavailable when LanguageModel is absent', async () => {
      const result = await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS },
        fakeSender,
      ) as GetChromePromptApiStatusResponse;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.availability).toBe('unavailable');
        expect(result.downloadProgress).toBeNull();
      }
    });

    it('returns current availability from LanguageModel', async () => {
      vi.stubGlobal('LanguageModel', {
        availability: vi.fn().mockResolvedValue('available'),
        create: vi.fn(),
      });

      const result = await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS },
        fakeSender,
      ) as GetChromePromptApiStatusResponse;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.availability).toBe('available');
      }
    });
  });

  describe('TRIGGER_CHROME_MODEL_DOWNLOAD', () => {
    it('returns error when LanguageModel is absent', async () => {
      const result = await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD },
        fakeSender,
      ) as TriggerChromeModelDownloadResponse;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not available');
      }
    });

    it('calls LanguageModel.create with monitor callback', async () => {
      const mockSession = {
        contextWindow: 4096,
        destroy: vi.fn(),
        prompt: vi.fn(),
      };
      vi.stubGlobal('LanguageModel', {
        availability: vi.fn().mockResolvedValue('downloadable'),
        create: vi.fn().mockResolvedValue(mockSession),
      });

      const result = await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD },
        fakeSender,
      ) as TriggerChromeModelDownloadResponse;

      expect(result.ok).toBe(true);
      const lm = Reflect.get(globalThis, 'LanguageModel') as {
        create: ReturnType<typeof vi.fn>;
      };
      expect(lm.create).toHaveBeenCalledWith(
        expect.objectContaining({ monitor: expect.any(Function) }),
      );
      expect(mockSession.destroy).toHaveBeenCalled();
    });

    it('tracks download progress from monitor events', async () => {
      let capturedMonitor: ((m: unknown) => void) | undefined;
      const mockSession = {
        contextWindow: 4096,
        destroy: vi.fn(),
        prompt: vi.fn(),
      };
      vi.stubGlobal('LanguageModel', {
        availability: vi.fn().mockResolvedValue('downloading'),
        create: vi.fn().mockImplementation(
          (opts: { monitor?: (m: unknown) => void }) => {
            capturedMonitor = opts.monitor;
            return Promise.resolve(mockSession);
          },
        ),
      });

      await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD },
        fakeSender,
      );

      /* Simulate a progress event via the captured monitor callback. */
      expect(capturedMonitor).toBeDefined();
      const fakeMonitor = {
        addEventListener: vi.fn(),
      };
      capturedMonitor!(fakeMonitor);

      /* Extract the downloadprogress listener and fire it. */
      const [eventName, listener] = fakeMonitor.addEventListener
        .mock.calls[0] as [string, (ev: { loaded: number; total: number }) => void];
      expect(eventName).toBe('downloadprogress');
      listener({ loaded: 50, total: 100 });

      /* Query status to verify progress was recorded. */
      const statusResult = await ChromePromptApiRuntimeMessages.handle(
        { type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS },
        fakeSender,
      ) as GetChromePromptApiStatusResponse;

      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.downloadProgress).toBe(50);
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/background/messaging/chrome-prompt-api-runtime-messages.test.ts`
Expected: FAIL — module `@/background/messaging/chrome-prompt-api-runtime-messages` not found

- [ ] **Step 3: Write the implementation**

Create `src/background/messaging/chrome-prompt-api-runtime-messages.ts`:

```ts
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { getErrorMessage } from '@/shared/error';
import {
  TOPSKIP_MESSAGE,
  type GetChromePromptApiStatusResponse,
  type ProviderAvailabilityMessage,
  type TriggerChromeModelDownloadResponse,
} from '@/shared/messages';

/**
 * Maps a raw Chrome availability string to the shared message type.
 *
 * @param raw - Value from `LanguageModel.availability()`
 * @returns Mapped availability or `'unavailable'` for unknown values
 */
function mapAvailability(raw: unknown): ProviderAvailabilityMessage {
  switch (raw) {
    case 'available':
      return 'available';
    case 'downloadable':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default:
      return 'unavailable';
  }
}

/**
 * Handles Chrome Prompt API status queries and model download triggers.
 * Tracks ephemeral download progress percentage in module-level state.
 */
export class ChromePromptApiRuntimeMessages {
  private constructor() {}

  /**
   * Last observed download progress (0–100), or `null` when no
   * download is active.
   */
  private static downloadProgress: number | null = null;

  /**
   * Routes incoming messages or returns `undefined` for unrelated ones.
   *
   * @param message - Opaque runtime message
   * @param _sender - Extension sender (unused)
   * @returns Response promise, or `undefined` when not handled
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ):
    | Promise<GetChromePromptApiStatusResponse>
    | Promise<TriggerChromeModelDownloadResponse>
    | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeof typeRaw !== 'string') {
      return undefined;
    }

    if (typeRaw === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
      return ChromePromptApiRuntimeMessages.handleGetStatus();
    }
    if (typeRaw === TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD) {
      return ChromePromptApiRuntimeMessages.handleTriggerDownload();
    }
    return undefined;
  }

  /**
   * Queries the Chrome Prompt API availability and returns the current
   * download progress if a download is active.
   *
   * @returns Current Chrome AI status
   */
  private static async handleGetStatus():
    Promise<GetChromePromptApiStatusResponse> {
    try {
      const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
      if (!lm || typeof lm !== 'object') {
        return {
          ok: true,
          availability: 'unavailable',
          downloadProgress: null,
        };
      }

      const availFn: unknown = Reflect.get(lm, 'availability');
      if (typeof availFn !== 'function') {
        return {
          ok: true,
          availability: 'unavailable',
          downloadProgress: null,
        };
      }

      const raw: unknown = await (availFn as () => Promise<unknown>)
        .call(lm);
      return {
        ok: true,
        availability: mapAvailability(raw),
        downloadProgress: ChromePromptApiRuntimeMessages.downloadProgress,
      };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * Triggers a model download by calling `LanguageModel.create({ monitor })`
   * and tracking progress events. Destroys the session immediately after
   * creation — the download continues in the background.
   *
   * @returns Success or error
   */
  private static async handleTriggerDownload():
    Promise<TriggerChromeModelDownloadResponse> {
    const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
    if (!lm || typeof lm !== 'object') {
      return { ok: false, error: 'Chrome Built-in AI is not available' };
    }

    const createFn: unknown = Reflect.get(lm, 'create');
    if (typeof createFn !== 'function') {
      return { ok: false, error: 'Chrome Built-in AI is not available' };
    }

    try {
      ChromePromptApiRuntimeMessages.downloadProgress = 0;

      const session = await (createFn as (
        opts: { monitor?: (m: unknown) => void },
      ) => Promise<{ destroy(): void }>).call(lm, {
        monitor(m: unknown) {
          if (m && typeof m === 'object' && 'addEventListener' in m) {
            const monitor = m as {
              addEventListener(
                type: string,
                listener: (ev: { loaded: number; total: number }) => void,
              ): void;
            };
            monitor.addEventListener(
              'downloadprogress',
              (ev: { loaded: number; total: number }) => {
                if (ev.total > 0) {
                  ChromePromptApiRuntimeMessages.downloadProgress =
                    Math.round((ev.loaded / ev.total) * 100);
                }
              },
            );
          }
        },
      });

      session.destroy();
      ChromePromptApiRuntimeMessages.downloadProgress = null;
      return { ok: true };
    } catch (e) {
      ChromePromptApiRuntimeMessages.downloadProgress = null;
      return { ok: false, error: getErrorMessage(e) };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/background/messaging/chrome-prompt-api-runtime-messages.test.ts`
Expected: PASS

**Verification**: Status returns availability + download progress. Download trigger calls `LanguageModel.create({ monitor })` and tracks progress.

---

### [ ] Task 3: Wire handler into the message listener chain

**Files:**
- Modify: `src/background/messaging/register-runtime-messages.ts`

- [ ] **Step 1: Add import and handler call**

In `src/background/messaging/register-runtime-messages.ts`, add the import:

```ts
import {
  ChromePromptApiRuntimeMessages,
} from '@/background/messaging/chrome-prompt-api-runtime-messages';
```

Inside the `browser.runtime.onMessage.addListener` callback, after the `ProviderRuntimeMessages.handle()` block and before the `OpenRouterRuntimeMessages.handle()` block, add:

```ts
      const chromePromptApi = ChromePromptApiRuntimeMessages.handle(
        message,
        sender,
      );
      if (chromePromptApi !== undefined) {
        return chromePromptApi;
      }
```

- [ ] **Step 2: Run lint to verify wiring is correct**

Run: `pnpm run lint`
Expected: PASS

**Verification**: `GET_CHROME_PROMPT_API_STATUS` and `TRIGGER_CHROME_MODEL_DOWNLOAD` messages are handled in the runtime listener chain.

---

### [ ] Task 4: Create the `ChromeBuiltinOnboarding` component

**Files:**
- Create: `src/options/ChromeBuiltinOnboarding.tsx`
- Modify: `tests/options/provider-panels.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the existing `ChromeBuiltinPanel` test in `tests/options/provider-panels.test.ts` and add per-state onboarding tests:

```ts
  it('renders unavailable state with requirements text', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'unavailable',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('not available');
    expect(html).toContain('Chrome 138');
  });

  it('renders downloadable state with download button', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloadable',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Download model');
    expect(html).toContain('Gemini Nano');
    expect(html).toContain('no data leaves');
  });

  it('renders downloading state with progress', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloading',
        downloadProgress: 42,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('42%');
  });

  it('renders downloading state with retry when progress is null', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloading',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Retry');
  });

  it('renders available state with Ready badge', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'available',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Ready');
    expect(html).toContain('ready to use');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/options/provider-panels.test.ts`
Expected: FAIL — `ChromeBuiltinOnboarding` module not found

- [ ] **Step 3: Write the component**

Create `src/options/ChromeBuiltinOnboarding.tsx`:

```tsx
import {
  Badge,
  Button,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import type { ProviderAvailabilityMessage } from '@/shared/messages';

type ChromeBuiltinOnboardingProps = {
  availability: ProviderAvailabilityMessage;
  downloadProgress: number | null;
  onDownload: () => void;
};

/**
 * Multi-state onboarding widget for the Chrome Built-in AI provider.
 * Renders a different card depending on the model lifecycle state.
 *
 * @param props - Current availability, download progress, and callback
 * @returns Onboarding UI for Chrome Built-in
 */
export function ChromeBuiltinOnboarding(
  props: ChromeBuiltinOnboardingProps,
): ReactElement {
  const { availability, downloadProgress, onDownload } = props;

  if (availability === 'unavailable') {
    return (
      <Paper p="lg" radius="xl" style={{ opacity: 0.6 }}>
        <Stack gap="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Chrome Built-in
          </Text>
          <Title order={3} size="h3">
            Chrome Built-in AI is not available on this device
          </Title>
          <Text size="sm" c="dimmed">
            Requires Chrome 138+, 22 GB free storage, 4 GB+ VRAM or 16 GB RAM.
          </Text>
        </Stack>
      </Paper>
    );
  }

  if (availability === 'downloadable') {
    return (
      <Paper p="lg" radius="xl">
        <Stack gap="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Chrome Built-in
          </Text>
          <Title order={3} size="h3">
            Gemini Nano
          </Title>
          <Text size="sm" c="dimmed">
            Approximate download size: ~2 GB. The model runs entirely on your
            device — no data leaves your computer.
          </Text>
          <Button onClick={onDownload}>
            Download model
          </Button>
        </Stack>
      </Paper>
    );
  }

  if (availability === 'downloading') {
    const hasProgress = downloadProgress !== null && downloadProgress >= 0;
    return (
      <Paper p="lg" radius="xl">
        <Stack gap="sm">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Chrome Built-in
          </Text>
          {hasProgress ? (
            <>
              <Title order={3} size="h3">
                Downloading Gemini Nano… {downloadProgress}%
              </Title>
              <Progress value={downloadProgress ?? 0} size="lg" radius="xl" />
            </>
          ) : (
            <>
              <Title order={3} size="h3">
                Download interrupted
              </Title>
              <Text size="sm" c="dimmed">
                The download was interrupted. Click below to retry.
              </Text>
              <Button onClick={onDownload}>
                Retry
              </Button>
            </>
          )}
        </Stack>
      </Paper>
    );
  }

  /* availability === 'available' */
  return (
    <Paper p="lg" radius="xl">
      <Stack gap="sm">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
          Chrome Built-in
        </Text>
        <Title order={3} size="h3">
          Gemini Nano is ready to use
        </Title>
        <Badge color="green" variant="filled" size="lg">
          Ready
        </Badge>
      </Stack>
    </Paper>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/options/provider-panels.test.ts`
Expected: PASS

**Verification**: All four availability states render correct content. Download interrupted shows retry. Ready shows badge.

---

### [ ] Task 5: Update `ChromeBuiltinPanel` to use the onboarding widget

**Files:**
- Modify: `src/options/ChromeBuiltinPanel.tsx`

- [ ] **Step 1: Rewrite `ChromeBuiltinPanel` to wrap `ChromeBuiltinOnboarding`**

Replace the contents of `src/options/ChromeBuiltinPanel.tsx`:

```tsx
import type { ReactElement } from 'react';

import { ChromeBuiltinOnboarding } from
  '@/options/ChromeBuiltinOnboarding';
import type { ProviderAvailabilityMessage } from '@/shared/messages';

type ChromeBuiltinPanelProps = {
  availability: ProviderAvailabilityMessage;
  downloadProgress: number | null;
  onDownload: () => void;
};

/**
 * Chrome Built-in provider panel for the options page.
 * Delegates to the multi-state onboarding widget.
 *
 * @param props - Current availability, progress, and download callback
 * @returns Chrome Built-in provider panel
 */
export function ChromeBuiltinPanel(
  props: ChromeBuiltinPanelProps,
): ReactElement {
  return (
    <ChromeBuiltinOnboarding
      availability={props.availability}
      downloadProgress={props.downloadProgress}
      onDownload={props.onDownload}
    />
  );
}
```

- [ ] **Step 2: Run lint to verify no type errors**

Run: `pnpm run lint`
Expected: FAIL — `options.tsx` still passes old props to `ChromeBuiltinPanel`. This is fixed in Task 6.

**Verification**: `ChromeBuiltinPanel` signature now includes `downloadProgress` and `onDownload`.

---

### [ ] Task 6: Wire options page to poll status and trigger download

**Files:**
- Modify: `src/options/options.tsx`

- [ ] **Step 1: Add download state and polling to `OptionsApp`**

In `src/options/options.tsx`, add state variables near the existing `chromeAvailability` memo:

```ts
const [chromeDownloadProgress, setChromeDownloadProgress] =
  useState<number | null>(null);
```

Add a polling effect for Chrome status when the active provider is `chrome-prompt-api`:

```ts
useEffect(() => {
  if (activeProviderId !== 'chrome-prompt-api') {
    return;
  }

  let cancelled = false;

  const poll = async (): Promise<void> => {
    try {
      const resp = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
      }) as { ok: boolean; availability?: string; downloadProgress?: number | null };
      if (!cancelled && resp.ok) {
        setChromeDownloadProgress(
          resp.downloadProgress ?? null,
        );
      }
    } catch {
      /* Service worker may be restarting — ignore. */
    }
  };

  void poll();
  const id = setInterval(() => void poll(), 2000);

  return () => {
    cancelled = true;
    clearInterval(id);
  };
}, [activeProviderId]);
```

Add the download trigger callback:

```ts
const onTriggerChromeDownload = useCallback(async () => {
  try {
    await browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD,
    });
  } catch {
    /* Ignore — polling will update status. */
  }
}, []);
```

Update the `ChromeBuiltinPanel` render call to pass new props:

```tsx
<ChromeBuiltinPanel
  availability={chromeAvailability}
  downloadProgress={chromeDownloadProgress}
  onDownload={() => { void onTriggerChromeDownload(); }}
/>
```

- [ ] **Step 2: Run lint + build to verify everything compiles**

Run: `pnpm run lint && pnpm run build`
Expected: PASS

- [ ] **Step 3: Update the existing `ChromeBuiltinPanel` test**

In `tests/options/provider-panels.test.ts`, update the existing `ChromeBuiltinPanel` placeholder test to match the new props:

```ts
  it('renders the Chrome Built-in placeholder copy', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinPanel, {
        availability: 'unavailable',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Chrome Built-in');
    expect(html).toContain('not available');
  });
```

- [ ] **Step 4: Run full test suite**

Run: `pnpm vitest run`
Expected: PASS

**Verification**: Options page polls for Chrome status, passes download callback and progress to `ChromeBuiltinPanel`, which delegates to `ChromeBuiltinOnboarding`.

---

### [ ] Task 7: Final validation

- [ ] **Step 1: Run full CI-equivalent suite**

Run: `pnpm run lint && pnpm run build && pnpm run test && pnpm run test:e2e`
Expected: All pass — no regressions, new handler and component tests green.

**Verification**: All acceptance criteria from the issue are satisfied:
- Unavailable state renders greyed card with requirements text ✓
- Downloadable state renders card with "Download model" button ✓
- Downloading state renders progress bar with percentage ✓
- Download interrupted renders retry action (no stuck spinner) ✓
- Available state renders "Ready" badge with save enabled ✓
- Re-opening options page shows current state (polling resumes from background state) ✓
- `pnpm run lint` passes ✓
