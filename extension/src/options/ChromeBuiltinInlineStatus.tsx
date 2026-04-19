import {
  Alert,
  Badge,
  Button,
  Group,
  Progress,
  Stack,
  Text,
} from '@mantine/core';
import { useMachine } from '@xstate/react';
import type { ReactElement } from 'react';

import {
  chromeDownloadMachine,
} from '@/options/chrome-download-machine';

/**
 * Compact inline status for Chrome Built-in, rendered inside the
 * provider selector card. Driven by an XState machine that calls
 * `LanguageModel` APIs directly for real-time progress feedback.
 *
 * Follows the official Chrome pattern from
 * https://developer.chrome.com/docs/ai/inform-users-of-model-download
 *
 * @returns Inline status element for Chrome Built-in
 */
export function ChromeBuiltinInlineStatus(): ReactElement {
  const [state, send] = useMachine(chromeDownloadMachine);

  const { progress, extracting, error } = state.context;

  /* ── ready ── */
  if (state.matches('ready')) {
    return (
      <Alert color="success" variant="light">
        <Group gap="xs" align="center">
          <Badge color="green" variant="filled" size="sm">Ready</Badge>
          <Text size="sm">
            Gemini Nano is ready — analysis runs entirely on your device.
          </Text>
        </Group>
      </Alert>
    );
  }

  /* ── downloading ── */
  if (state.matches('downloading')) {
    /* When loaded reaches 1, Chrome extracts and loads the model into
     * memory. Show indeterminate progress per the official Chrome pattern. */
    if (extracting) {
      return (
        <Alert color="blue" variant="light">
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Preparing model…
            </Text>
            <Progress size="lg" radius="xl" animated value={100} />
          </Stack>
        </Alert>
      );
    }
    const pct = progress;
    const displayPct = pct < 1 && pct > 0
      ? pct.toFixed(1)
      : Math.round(pct).toString();
    return (
      <Alert color="blue" variant="light">
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            Downloading Gemini Nano… {displayPct}%
          </Text>
          <Progress
            value={pct}
            size="lg"
            radius="xl"
            animated={pct < 100}
          />
        </Stack>
      </Alert>
    );
  }

  /* ── error ── */
  if (state.matches('error')) {
    return (
      <Alert color="red" variant="light">
        <Group gap="xs" justify="space-between" align="center">
          <Text size="sm">
            {error ?? 'Something went wrong.'}
          </Text>
          <Button
            size="xs"
            variant="light"
            onClick={() => send({ type: 'RETRY' })}
          >
            Retry
          </Button>
        </Group>
      </Alert>
    );
  }

  /* ── downloadable ── */
  if (state.matches('downloadable')) {
    return (
      <Alert color="blue" variant="light">
        <Group gap="xs" justify="space-between" align="center">
          <Text size="sm">
            Gemini Nano (~2 GB) needs to download first.
            Runs on-device — no data leaves your computer.
          </Text>
          <Button
            size="xs"
            onClick={() => send({ type: 'DOWNLOAD' })}
          >
            Download
          </Button>
        </Group>
      </Alert>
    );
  }

  /* ── unavailable ── */
  if (state.matches('unavailable')) {
    return (
      <Alert color="gray" variant="light">
        <Text size="sm">
          Not available on this device.
          Requires Chrome 138+, 22 GB storage, 4 GB+ VRAM or 16 GB RAM.
        </Text>
      </Alert>
    );
  }

  /* ── checking (initial load) ── */
  return (
    <Alert color="gray" variant="light">
      <Text size="sm">Checking model availability…</Text>
    </Alert>
  );
}
