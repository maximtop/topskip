import { observer } from 'mobx-react-lite';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
} from '@mantine/core';

import { PreferencesStore } from '@/popup/preferences-store';
import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type GetDetectionStatusResponse,
  type ProviderAvailabilityMessage,
  type PromoDetectionStatePayload,
} from '@/shared/messages';
import type { PromoBlock, PromoDetectionStatus } from '@/shared/promo-types';
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
    // FIXME why not enums are used here? or map?
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

/**
 * Derives the effective end time for a promo block,
 * falling back to startSec + 30 when absent.
 *
 * @param block - The promo block to inspect.
 * @returns End time in seconds.
 */
function getPromoBlockEndSec(block: PromoBlock): number {
  if (block.endSec !== undefined && block.endSec > block.startSec) {
    return block.endSec;
  }
  return block.startSec + 30;
}

type PopupTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral';

type PopupViewModel = {
  tone: PopupTone;
  badgeLabel: string;
  badgeColor: string;
  title: string;
  description: string;
  statusHeadline: string;
  statusBody: string | null;
  settingsLabel: string;
  providerLabel: string;
};

/**
 * Builds the view-model that drives the popup's UI,
 * based on extension state and detection results.
 *
 * @param args - Current prefs and detection state.
 * @returns The resolved view-model.
 */
export function buildPopupViewModel(args: {
  enabled: boolean;
  detectionState: PromoDetectionStatePayload | null;
  prefsError: string | null;
  detectionError: string | null;
  providerId: string;
  providerDisplayName: string;
  modelDisplayName: string;
  chromeModelAvailability: ProviderAvailabilityMessage | null;
}): PopupViewModel {
  const {
    enabled,
    detectionState,
    prefsError,
    detectionError,
    providerId,
    providerDisplayName,
    modelDisplayName,
    chromeModelAvailability,
  } = args;

  const providerLabel = modelDisplayName
    ? `${providerDisplayName} · ${modelDisplayName}`
    : providerDisplayName;

  if (prefsError !== null || detectionError !== null) {
    const message = prefsError ?? detectionError ?? 'Status unavailable';
    return {
      tone: 'danger',
      badgeLabel: 'Error',
      badgeColor: 'error',
      title: 'Status unavailable',
      description: 'TopSkip could not refresh its current state.',
      statusHeadline: message,
      statusBody: null,
      settingsLabel: 'Open settings',
      providerLabel,
    };
  }

  if (!enabled) {
    return {
      tone: 'neutral',
      badgeLabel: 'Off',
      badgeColor: 'gray',
      title: 'TopSkip is paused',
      description:
        'Auto-skip is disabled for YouTube ' +
        'until you turn it back on.',
      statusHeadline:
        'Automatic sponsor skipping is currently off.',
      statusBody:
        'You can still open settings and ' +
        'review your model setup.',
      settingsLabel: 'Open settings',
      providerLabel,
    };
  }

  if (detectionState === null) {
    return {
      tone: 'neutral',
      badgeLabel: 'Idle',
      badgeColor: 'gray',
      title: 'Open a YouTube video',
      description:
        'TopSkip is ready, but this tab does not ' +
        'have an active watch context yet.',
      statusHeadline:
        'Waiting for a supported watch page.',
      statusBody:
        'Detection details will appear here ' +
        'when a video is available.',
      settingsLabel: 'Open settings',
      providerLabel,
    };
  }

  if (
    providerId === 'chrome-prompt-api' &&
    chromeModelAvailability !== null &&
    chromeModelAvailability !== 'available'
  ) {
    if (chromeModelAvailability === 'downloading') {
      return {
        tone: 'brand',
        badgeLabel: 'Downloading',
        badgeColor: 'brand',
        title: 'Preparing Chrome Built-in model',
        description: 'Gemini Nano is downloading on this device.',
        statusHeadline: 'Model downloading...',
        statusBody:
          'Keep this popup open or check settings for progress.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }

    if (chromeModelAvailability === 'unavailable') {
      return {
        tone: 'warning',
        badgeLabel: 'Unavailable',
        badgeColor: 'warning',
        title: 'Chrome model unavailable',
        description:
          'This device does not currently meet Chrome Built-in requirements.',
        statusHeadline: 'Model unavailable - check settings',
        statusBody:
          'Open settings to see compatibility requirements and setup guidance.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }

    return {
      tone: 'neutral',
      badgeLabel: 'Setup',
      badgeColor: 'gray',
      title: 'Download required',
      description:
        'Chrome Built-in is selected but Gemini Nano is not downloaded yet.',
      statusHeadline: 'Model not downloaded yet',
      statusBody:
        'Open settings to download the model and enable on-device analysis.',
      settingsLabel: 'Open settings',
      providerLabel,
    };
  }

  switch (detectionState.status) {
    case 'not_configured':
      return {
        tone: 'warning',
        badgeLabel: 'Setup',
        badgeColor: 'warning',
        title: 'Finish setup',
        description:
          `Configure ${providerDisplayName || 'your LLM provider'} ` +
          'to enable transcript analysis for promo detection.',
        statusHeadline:
          'LLM detection is not configured yet.',
        statusBody:
          'Save an API key and select a default ' +
          'model to activate analysis.',
        settingsLabel: 'Continue setup',
        providerLabel,
      };
    case 'unavailable':
      return {
        tone: 'neutral',
        badgeLabel: 'Unavailable',
        badgeColor: 'gray',
        title: 'Detection unavailable',
        description:
          'TopSkip is enabled, but detection ' +
          'data is not available for this tab ' +
          'right now.',
        statusHeadline:
          'No detection snapshot is available.',
        statusBody:
          'This can happen before captions are ' +
          'ready or outside supported watch states.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    case 'analyzing':
      return {
        tone: 'brand',
        badgeLabel: 'Live',
        badgeColor: 'brand',
        title: 'Analyzing captions',
        description:
          'TopSkip is reading the latest ' +
          'transcript slice for this video.',
        statusHeadline: 'Analysis is in progress.',
        statusBody:
          'Detected sponsor windows will appear ' +
          'here when ready.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    case 'detected': {
      const count = detectionState.promoBlocks?.length ?? 0;
      return {
        tone: 'brand',
        badgeLabel: 'Detected',
        badgeColor: 'brand',
        title:
          `${count} promo ${count === 1 ? 'block' : 'blocks'} found`,
        description:
          'TopSkip has marked the current ' +
          'sponsor windows for this video.',
        statusHeadline: 'Detected windows',
        statusBody:
          detectionState.promoBlocks !== undefined &&
          detectionState.promoBlocks.length > 0
            ? formatPromoBlocksSummary(detectionState.promoBlocks)
            : null,
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }
    case 'no_promo':
      return {
        tone: 'success',
        badgeLabel: 'Clear',
        badgeColor: 'success',
        title: 'Watching clean',
        description:
          'No sponsor segments were found ' +
          'in the current transcript window.',
        statusHeadline: 'No promo blocks detected.',
        statusBody:
          'TopSkip will keep monitoring the ' +
          'video as captions update.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    case 'error':
      return {
        tone: 'danger',
        badgeLabel: 'Error',
        badgeColor: 'error',
        title: 'Detection error',
        description:
          'TopSkip could not analyze the ' +
          'current transcript.',
        statusHeadline:
          detectionState.error ??
          'Detection failed for this tab.',
        statusBody:
          'Open settings to verify the API key ' +
          'and selected model.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    default:
      return {
        tone: 'neutral',
        badgeLabel: detectionLabel(detectionState.status),
        badgeColor: 'gray',
        title: 'Status update',
        description:
          'TopSkip reported a state update ' +
          'for the current tab.',
        statusHeadline:
          detectionLabel(detectionState.status),
        statusBody: null,
        settingsLabel: 'Open settings',
        providerLabel,
      };
  }
}

/**
 * Returns a CSS gradient string matching the popup tone.
 *
 * @param tone - The semantic tone of the popup.
 * @returns CSS linear-gradient value.
 */
function heroBackground(tone: PopupTone): string {
  switch (tone) {
    case 'brand':
      return (
        'linear-gradient(180deg, ' +
        'rgba(230,252,245,0.98) 0%, ' +
        'rgba(243,250,247,0.98) 100%)'
      );
    case 'success':
      return (
        'linear-gradient(180deg, ' +
        'rgba(235,251,238,0.98) 0%, ' +
        'rgba(247,252,248,0.98) 100%)'
      );
    case 'warning':
      return (
        'linear-gradient(180deg, ' +
        'rgba(255,249,219,0.98) 0%, ' +
        'rgba(255,252,241,0.98) 100%)'
      );
    case 'danger':
      return (
        'linear-gradient(180deg, ' +
        'rgba(255,245,245,0.98) 0%, ' +
        'rgba(255,250,250,0.98) 100%)'
      );
    default:
      return (
        'linear-gradient(180deg, ' +
        'rgba(248,250,252,0.98) 0%, ' +
        'rgba(255,255,255,0.98) 100%)'
      );
  }
}

/**
 * Renders a visual timeline bar of detected promo blocks.
 *
 * @param props - Contains the blocks to display.
 * @returns The timeline element, or null when empty.
 */
function PromoTimeline(
  { blocks }: { blocks: readonly PromoBlock[] },
): ReactElement | null {
  if (blocks.length === 0) {
    return null;
  }

  const maxEnd = blocks.reduce((max, block) => {
    return Math.max(max, getPromoBlockEndSec(block));
  }, 60);

  return (
    <Stack gap={6} mt="sm">
      <Box
        aria-hidden="true"
        style={{
          position: 'relative',
          height: '0.625rem',
          borderRadius: '999px',
          background: 'var(--mantine-color-slate-1)',
          overflow: 'hidden',
        }}
      >
        {blocks.map((block, index) => {
          const end = getPromoBlockEndSec(block);
          const left = `${(block.startSec / maxEnd) * 100}%`;
          const width =
            `${(Math.max(end - block.startSec, 4) / maxEnd) * 100}%`;
          return (
            <Box
              key={`${block.startSec}-${end}-${index}`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left,
                width,
                minWidth: '0.35rem',
                borderRadius: '999px',
                background:
                  index % 2 === 0
                    ? 'linear-gradient(90deg, ' +
                      'var(--mantine-color-brand-6), ' +
                      'var(--mantine-color-brand-7))'
                    : 'linear-gradient(90deg, ' +
                      'var(--mantine-color-warning-6), ' +
                      'var(--mantine-color-brand-6))',
              }}
            />
          );
        })}
      </Box>
      <Text size="xs" c="dimmed">
        Visual detection timeline for the current video snapshot.
      </Text>
    </Stack>
  );
}

export const PopupApp = observer(function PopupApp() {
  const store = useMemo(() => new PreferencesStore(), []);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [detectionState, setDetectionState] =
    useState<PromoDetectionStatePayload | null>(null);
  const [detectionError, setDetectionError] = useState<string | null>(null);

  useEffect(() => {
    void store.load().then(
      () => {
        setPrefsError(null);
      },
      (e: unknown) => {
        setPrefsError(getErrorMessage(e));
      },
    );
    store.connectPort();
    return () => {
      store.disconnectPort();
    };
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
          setDetectionState(null);
          setDetectionError('Could not load detection status.');
          return;
        }
        setDetectionError(null);
        setDetectionState(res.state);
      } catch (e) {
        if (!cancelled) {
          setDetectionState(null);
          setDetectionError(getErrorMessage(e));
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

  const view = buildPopupViewModel({
    enabled: store.enabled,
    detectionState,
    prefsError,
    detectionError,
    providerId: store.providerId,
    providerDisplayName: store.providerDisplayName,
    modelDisplayName: store.modelDisplayName,
    chromeModelAvailability: store.chromeModelAvailability,
  });

  const detectedBlocks =
    detectionState?.status === 'detected' &&
    detectionState.promoBlocks !== undefined
      ? detectionState.promoBlocks
      : [];

  return (
    <Stack
      gap="sm"
      p="md"
      maw={320}
      style={{
        background: 'linear-gradient(180deg, #f8fafc 0%, #f2f7f5 100%)',
      }}
    >
      <Paper
        p="md"
        radius="xl"
        style={{ background: heroBackground(view.tone) }}
      >
        <Group
          justify="space-between"
          align="flex-start"
          wrap="nowrap"
          gap="sm"
        >
          <Stack gap={2} style={{ flex: 1 }}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {reactTranslator.getMessage('popup_heading')}
            </Text>
            <Text fw={700} size="lg">
              {view.title}
            </Text>
            <Text size="sm" c="dimmed" maw={220}>
              {view.description}
            </Text>
          </Stack>
          <Badge color={view.badgeColor}>{view.badgeLabel}</Badge>
        </Group>
        <Paper
          mt="md"
          p="sm"
          radius="lg"
          style={{ background: 'rgba(255, 255, 255, 0.88)' }}
        >
          <Group justify="space-between" wrap="nowrap" gap="md">
            <Stack gap={1}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Quick control
              </Text>
              <Text size="sm" fw={600}>
                {reactTranslator.getMessage(
                  'popup_enable_promo_skip',
                )}
              </Text>
            </Stack>
            <Switch
              checked={store.enabled}
              onChange={(e) => {
                setPrefsError(null);
                void store
                  .setEnabled(e.currentTarget.checked)
                  .catch((err: unknown) => {
                    setPrefsError(getErrorMessage(err));
                  });
              }}
              aria-label={translator.getMessage(
                'popup_enable_auto_skip_aria',
              )}
            />
          </Group>
        </Paper>
        {view.providerLabel ? (
          <Group gap={4} mt={8} align="center">
            <Text size="xs" c="dimmed">
              {`⚡ ${view.providerLabel}`}
            </Text>
          </Group>
        ) : null}
      </Paper>

      <Paper p="md" radius="xl">
        <div role="status" aria-live="polite">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            {translator.getMessage('popup_active_tab_prefix')}
          </Text>
          <Text size="sm" fw={600} mt={4}>
            {view.statusHeadline}
          </Text>
          {view.statusBody !== null ? (
            <Text
              size="xs"
              c="dimmed"
              mt={4}
              style={{ whiteSpace: 'pre-line' }}
            >
              {view.statusBody}
            </Text>
          ) : null}
        </div>
        <PromoTimeline blocks={detectedBlocks} />
      </Paper>


      <Button
        variant={
          detectionState?.status === 'not_configured'
            ? 'filled'
            : 'light'
        }
        size="sm"
        onClick={() => {
          void browser.runtime.openOptionsPage();
        }}
      >
        {reactTranslator.getMessage('popup_open_settings')}
      </Button>

      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 'var(--mantine-font-size-xs)',
            color: 'var(--mantine-color-dimmed)',
          }}
        >
          {translator.getMessage(
            'popup_reliability_notice_title',
          )}
        </summary>
        <Alert
          color="warning"
          title={translator.getMessage(
            'popup_reliability_notice_title',
          )}
          mt="xs"
        >
          <Text size="xs">
            {reactTranslator.getMessage(
              'popup_reliability_notice_body_1',
            )}
          </Text>
          <Text size="xs" mt="xs">
            {reactTranslator.getMessage(
              'popup_reliability_notice_body_2',
            )}
          </Text>
        </Alert>
      </details>
    </Stack>
  );
});
