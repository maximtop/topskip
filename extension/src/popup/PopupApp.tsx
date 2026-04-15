import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Group, Stack, Switch, Text } from '@mantine/core';

import { PreferencesStore } from '@/popup/preferences-store';
import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type GetDetectionStatusResponse,
} from '@/shared/messages';
import type { PromoDetectionStatus } from '@/shared/promo-types';
import { formatPromoBlocksSummary } from '@/shared/promo-range-format';

/**
 * @param res - Untyped runtime response
 * @returns Whether the payload is a successful detection status response
 */
function isGetDetectionOk(
  res: unknown,
): res is Extract<GetDetectionStatusResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true
  );
}

/**
 * @param s - Status enum
 * @returns Short label
 */
function detectionLabel(s: PromoDetectionStatus): string {
  switch (s) {
    case 'not_configured':
      return 'LLM not configured';
    case 'unavailable':
      return 'Unavailable';
    case 'analyzing':
      return 'Analyzing…';
    case 'detected':
      return 'Promo blocks detected';
    case 'no_promo':
      return 'No promo found';
    case 'error':
      return 'Detection error';
    default:
      return s;
  }
}

export const PopupApp = observer(function PopupApp() {
  const store = useMemo(() => new PreferencesStore(), []);
  const [detectionLine, setDetectionLine] = useState<string | null>(null);

  useEffect(() => {
    void store.load();
  }, [store]);

  useEffect(() => {
    let cancelled = false;

    const refreshDetection = async (): Promise<void> => {
      try {
        const res: unknown = await browser.runtime.sendMessage({
          type: TOPSKIP_MESSAGE.GET_DETECTION_STATUS,
        });
        if (cancelled) {
          return;
        }
        if (!isGetDetectionOk(res)) {
          setDetectionLine(null);
          return;
        }
        if (res.state === null) {
          setDetectionLine(null);
          return;
        }
        const base = detectionLabel(res.state.status);
        const err = res.state.error ? ` (${res.state.error})` : '';
        let line = `${base}${err}`;
        if (
          res.state.status === 'detected' &&
          res.state.promoBlocks !== undefined &&
          res.state.promoBlocks.length > 0
        ) {
          line += `\n${formatPromoBlocksSummary(res.state.promoBlocks)}`;
        }
        setDetectionLine(line);
      } catch (e) {
        if (!cancelled) {
          setDetectionLine(getErrorMessage(e));
        }
      }
    };

    void refreshDetection();
    const id = window.setInterval(() => {
      void refreshDetection();
    }, 2000);

    const onRuntimeMessage = (message: unknown): void => {
      if (
        message &&
        typeof message === 'object' &&
        Reflect.get(message, 'type') === TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED
      ) {
        void refreshDetection();
      }
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, []);

  return (
    <Stack gap="sm" p="md" maw={320}>
      <Text fw={600} size="sm">
        TopSkip
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">Enable promo skip (YouTube)</Text>
        <Switch
          checked={store.enabled}
          onChange={(e) => {
            void store.setEnabled(e.currentTarget.checked);
          }}
          aria-label="Enable auto-skip"
        />
      </Group>
      {detectionLine ? (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
          Active tab: {detectionLine}
        </Text>
      ) : null}
      <Button
        variant="light"
        size="xs"
        onClick={() => {
          void browser.runtime.openOptionsPage();
        }}
      >
        Open settings (OpenRouter)
      </Button>
      <Alert color="yellow" title="Reliability notice" variant="light">
        <Text size="xs">
          TopSkip may rely on parts of YouTube’s site that are not a documented
          public API—the same general area the YouTube web client uses. There is
          no guarantee that auto-skip will keep working if YouTube changes how
          the page behaves.
        </Text>
        <Text size="xs" mt="xs">
          If it stops working, please report it where you installed this
          extension (for example the Chrome Web Store support options, if you
          installed it from there).
        </Text>
      </Alert>
    </Stack>
  );
});
