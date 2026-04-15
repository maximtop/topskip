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
import { reactTranslator } from '@/shared/i18n/react-translator';
import { translator } from '@/shared/i18n/translator';

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
      return translator.getMessage('popup_detection_not_configured');
    case 'unavailable':
      return translator.getMessage('popup_detection_unavailable');
    case 'analyzing':
      return translator.getMessage('popup_detection_analyzing');
    case 'detected':
      return translator.getMessage('popup_detection_detected');
    case 'no_promo':
      return translator.getMessage('popup_detection_no_promo');
    case 'error':
      return translator.getMessage('popup_detection_error');
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
        {reactTranslator.getMessage('popup_heading')}
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          {reactTranslator.getMessage(
            'popup_enable_promo_skip',
          )}
        </Text>
        <Switch
          checked={store.enabled}
          onChange={(e) => {
            void store.setEnabled(e.currentTarget.checked);
          }}
          aria-label={translator.getMessage('popup_enable_auto_skip_aria')}
        />
      </Group>
      {detectionLine ? (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
          {translator.getMessage('popup_active_tab_prefix')}{detectionLine}
        </Text>
      ) : null}
      <Button
        variant="light"
        size="xs"
        onClick={() => {
          void browser.runtime.openOptionsPage();
        }}
      >
        {reactTranslator.getMessage('popup_open_settings')}
      </Button>
      <Alert
        color="yellow"
        title={translator.getMessage(
          'popup_reliability_notice_title',
        )}
        variant="light"
      >
        <Text size="xs">
          {reactTranslator.getMessage('popup_reliability_notice_body_1')}
        </Text>
        <Text size="xs" mt="xs">
          {reactTranslator.getMessage('popup_reliability_notice_body_2')}
        </Text>
      </Alert>
    </Stack>
  );
});
