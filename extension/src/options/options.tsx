import '@mantine/core/styles.css';

import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  MantineProvider,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  type ReactElement,
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';

import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type GetOpenRouterConfigResponse,
  type MutateOpenRouterCustomModelResponse,
  type SetOpenRouterConfigResponse,
} from '@/shared/messages';
import {
  OPENROUTER_DEFAULT_MODEL_SLUG,
  OPENROUTER_MODEL_PRESETS,
} from '@/shared/openrouter-model-presets';
import { topskipTheme } from '@/shared/theme';
import { ErrorBoundary } from '@/shared/ErrorBoundary';

type OpenRouterGetOkPayload = Extract<
  GetOpenRouterConfigResponse,
  { ok: true }
>;

/**
 * @param err - Error from `runtime.sendMessage`
 * @returns Whether another attempt may help (cold MV3 service worker).
 */
function isTransientSendMessageFailure(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  return (
    msg.includes('receiving end does not exist') ||
    msg.includes('could not establish connection') ||
    msg.includes('extension context invalidated')
  );
}

/**
 * GET OpenRouter config, retrying when the service worker is not ready yet.
 *
 * @returns Raw message result from the background script
 */
async function sendGetOpenRouterConfigWithRetry(): Promise<unknown> {
  const maxAttempts = 10;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG,
      });
      if (res !== undefined && res !== null) {
        return res;
      }
    } catch (e) {
      lastErr = e;
      if (
        !isTransientSendMessageFailure(e) ||
        attempt === maxAttempts - 1
      ) {
        throw new Error(getErrorMessage(e));
      }
    }
    await new Promise((r) => {
      setTimeout(r, 40 * (attempt + 1));
    });
  }
  if (lastErr !== undefined) {
    throw new Error(getErrorMessage(lastErr));
  }
  throw new Error(
    [
      'Extension background did not respond.',
      'Click Reload or reload the extension on chrome://extensions.',
    ].join(' '),
  );
}

/**
 * @param res - Untyped runtime response
 * @returns Parsed success payload, or `null` if shape is unusable
 */
function parseGetOpenRouterConfigOk(
  res: unknown,
): OpenRouterGetOkPayload | null {
  if (typeof res !== 'object' || res === null || !('ok' in res)) {
    return null;
  }
  if ((res as { ok: boolean }).ok !== true) {
    return null;
  }
  const o = res as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || typeof o.model !== 'string') {
    return null;
  }
  if (!('apiKeyMasked' in o)) {
    return null;
  }
  const masked = o.apiKeyMasked;
  if (masked !== null && typeof masked !== 'string') {
    return null;
  }
  let customModels: string[] = [];
  if (Array.isArray(o.customModels)) {
    customModels = o.customModels.filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return {
    ok: true,
    enabled: o.enabled,
    model: o.model,
    apiKeyMasked: masked,
    customModels,
  };
}

/**
 * @param res - Untyped runtime response
 * @returns Whether the payload is a successful OpenRouter SET response
 */
function isSetOpenRouterOk(
  res: unknown,
): res is Extract<SetOpenRouterConfigResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true
  );
}

/**
 * @param res - Untyped runtime response
 * @returns Whether the payload is a successful add/remove custom model response
 */
function isMutateOpenRouterCustomModelOk(
  res: unknown,
): res is Extract<MutateOpenRouterCustomModelResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true &&
    'customModels' in res &&
    Array.isArray((res as { customModels: unknown }).customModels)
  );
}

/**
 * Options page root; not instantiable.
 */
export class Options {
  private constructor() {}

  /**
   * Mounts the options React app under `#root`.
   */
  static init(): void {
    const rootEl = document.getElementById('root');
    if (!rootEl) {
      throw new Error('Missing #root');
    }

    createRoot(rootEl).render(
      <StrictMode>
        <MantineProvider theme={topskipTheme} defaultColorScheme="auto">
          <ErrorBoundary>
            <OptionsApp />
          </ErrorBoundary>
        </MantineProvider>
      </StrictMode>,
    );
  }
}

/**
 * OpenRouter settings form.
 *
 * @returns Options page React tree
 */
function OptionsApp(): ReactElement {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState<string>(
    OPENROUTER_DEFAULT_MODEL_SLUG,
  );
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [newModelDraft, setNewModelDraft] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [removeBusySlug, setRemoveBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedApiKeyMasked, setSavedApiKeyMasked] = useState<string | null>(
    null,
  );
  const [apiKeyVisible, { toggle: toggleApiKeyVisibility }] =
    useDisclosure(false);

  const setupReady = savedApiKeyMasked !== null;

  const modelSelectData = useMemo(() => {
    const seen = new Set<string>();
    const rows: { value: string; label: string }[] = [];
    for (const p of OPENROUTER_MODEL_PRESETS) {
      rows.push({ value: p.value, label: p.label });
      seen.add(p.value);
    }
    for (const slug of customModels) {
      if (!seen.has(slug)) {
        rows.push({ value: slug, label: slug });
        seen.add(slug);
      }
    }
    if (modelChoice.length > 0 && !seen.has(modelChoice)) {
      rows.push({ value: modelChoice, label: modelChoice });
    }
    return rows;
  }, [customModels, modelChoice]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res: unknown = await sendGetOpenRouterConfigWithRetry();
      if (
        res &&
        typeof res === 'object' &&
        'ok' in res &&
        (res as { ok: boolean }).ok === false
      ) {
        const hasErr =
          'error' in res &&
          typeof (res as { error: unknown }).error === 'string';
        const err = hasErr
          ? (res as { error: string }).error
          : 'Failed to load settings';
        setError(err);
        return;
      }
      const data = parseGetOpenRouterConfigOk(res);
      if (!data) {
        setError('Failed to load settings');
        return;
      }
      setEnabled(data.enabled);
      setCustomModels([...data.customModels]);
      const nextModel =
        data.model.length > 0 ? data.model : OPENROUTER_DEFAULT_MODEL_SLUG;
      setModelChoice(nextModel);
      setApiKey('');
      setSavedApiKeyMasked(data.apiKeyMasked);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Persists OpenRouter settings via the background service worker.
   *
   * @returns Promise that resolves when save attempt finishes
   */
  const onSave = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG,
        enabled,
        apiKey: apiKey.trim(),
        model: modelChoice,
      });
      if (!isSetOpenRouterOk(res)) {
        const err =
          res &&
          typeof res === 'object' &&
          'error' in res &&
          typeof (res as { error: unknown }).error === 'string'
            ? (res as { error: string }).error
            : 'Save failed';
        setError(err);
        return;
      }
      setSaved(true);
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  /**
   * Adds a custom model slug to storage (separate from Save).
   *
   * @returns Promise that resolves when the add attempt finishes
   */
  const onAddCustomModel = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    setAddBusy(true);
    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
        slug: newModelDraft,
      });
      if (!isMutateOpenRouterCustomModelOk(res)) {
        const err =
          res &&
          typeof res === 'object' &&
          'error' in res &&
          typeof (res as { error: unknown }).error === 'string'
            ? (res as { error: string }).error
            : 'Could not add model';
        setError(err);
        return;
      }
      setNewModelDraft('');
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setAddBusy(false);
    }
  };

  /**
   * Removes a custom model slug from storage.
   *
   * @param slug - Model id to remove
   * @returns Promise that resolves when the remove attempt finishes
   */
  const onRemoveCustomModel = async (slug: string): Promise<void> => {
    setError(null);
    setSaved(false);
    setRemoveBusySlug(slug);
    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL,
        slug,
      });
      if (!isMutateOpenRouterCustomModelOk(res)) {
        const err =
          res &&
          typeof res === 'object' &&
          'error' in res &&
          typeof (res as { error: unknown }).error === 'string'
            ? (res as { error: string }).error
            : 'Could not remove model';
        setError(err);
        return;
      }
      await load();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setRemoveBusySlug(null);
    }
  };

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #f8fafc 0%, #f5f8fb 100%)',
      }}
    >
      <Stack gap="lg" p="lg" maw={880} mx="auto">
        <Paper
          p="xl"
          radius="xl"
          style={{ background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)' }}
        >
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Stack gap={4} maw={560}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                TopSkip settings
              </Text>
              <Title order={2} size="h2">
                Transcript detection control room
              </Title>
              <Text size="sm" c="dimmed">
                Configure OpenRouter for transcript analysis. The API key is stored only in this browser profile (extension local storage).
              </Text>
            </Stack>
            <Group gap="xs">
              <Badge color={enabled ? 'brand' : 'gray'}>
                {enabled ? 'Detection enabled' : 'Detection paused'}
              </Badge>
              <Badge color={setupReady ? 'success' : 'warning'}>
                {setupReady ? 'API key saved' : 'Setup needed'}
              </Badge>
            </Group>
          </Group>
        </Paper>

        <Group align="stretch" wrap="wrap" gap="md">
          <Paper p="md" radius="xl" style={{ flex: '1 1 180px', minWidth: 180 }}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Current state
            </Text>
            <Text fw={700} mt={6}>
              {enabled ? 'Ready to analyze' : 'Paused'}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              The popup will show a quick status card for the current YouTube tab.
            </Text>
          </Paper>
          <Paper p="md" radius="xl" style={{ flex: '1 1 180px', minWidth: 180 }}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Connection
            </Text>
            <Text fw={700} mt={6}>
              {setupReady ? savedApiKeyMasked : 'No API key saved'}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Keep the field blank below if you want to preserve the saved key.
            </Text>
          </Paper>
          <Paper p="md" radius="xl" style={{ flex: '1 1 180px', minWidth: 180 }}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Default model
            </Text>
            <Text fw={700} mt={6} ff="monospace">
              {modelChoice}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              This is the starting model the popup will use for transcript analysis.
            </Text>
          </Paper>
        </Group>

        {error ? (
          <Alert color="error" role="alert">
            {error}
          </Alert>
        ) : null}
        {saved ? (
          <Alert color="success" role="status">
            Settings saved successfully.
          </Alert>
        ) : null}

        <Paper p="lg" radius="xl">
          <Stack gap="md">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Core controls
              </Text>
              <Title order={3} size="h3">
                Detection behavior
              </Title>
              <Text size="sm" c="dimmed">
                The popup stays intentionally simple. Enable or pause transcript analysis here, then choose the default model it should use.
              </Text>
            </Stack>
            <Paper p="md" radius="lg" style={{ background: '#fbfdff' }}>
              <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
                <Stack gap={2} style={{ flex: 1 }}>
                  <Text fw={600}>Enable LLM promo detection</Text>
                  <Text size="xs" c="dimmed">
                    When enabled, TopSkip analyzes available captions and marks promo windows for skipping.
                  </Text>
                </Stack>
                <Switch
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.currentTarget.checked);
                  }}
                />
              </Group>
            </Paper>
            <Select
              label="Default model"
              description="Built-in presets and models you added below."
              data={modelSelectData}
              value={modelChoice}
              onChange={(v) => {
                setModelChoice(v ?? OPENROUTER_DEFAULT_MODEL_SLUG);
              }}
            />
          </Stack>
        </Paper>

        <Paper p="lg" radius="xl">
          <Stack gap="md">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Secure connection
              </Text>
              <Title order={3} size="h3">
                OpenRouter API key
              </Title>
            </Stack>
            <TextInput
              label="API key"
              placeholder="sk-or-…"
              type={apiKeyVisible ? 'text' : 'password'}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.currentTarget.value);
              }}
              description={
                savedApiKeyMasked !== null
                  ? `Saved key: ${savedApiKeyMasked} - leave blank to keep it.`
                  : 'No key saved yet.'
              }
              rightSection={
                <ActionIcon
                  variant="subtle"
                  aria-label={apiKeyVisible ? 'Hide API key' : 'Show API key'}
                  onClick={toggleApiKeyVisibility}
                >
                  {apiKeyVisible ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </ActionIcon>
              }
            />
          </Stack>
        </Paper>

        <Paper p="lg" radius="xl">
          <Stack gap="md">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Model inventory
              </Text>
              <Title order={3} size="h3">
                Custom models
              </Title>
              <Text size="sm" c="dimmed">
                Add OpenRouter model ids for quick reuse. This inventory is separate from Save and updates immediately.
              </Text>
            </Stack>
            <Group align="flex-end" wrap="nowrap" gap="sm">
              <TextInput
                style={{ flex: 1 }}
                label="Custom model id"
                placeholder="vendor/model"
                value={newModelDraft}
                onChange={(e) => {
                  setNewModelDraft(e.currentTarget.value);
                }}
              />
              <Button
                loading={addBusy}
                disabled={newModelDraft.trim().length === 0}
                onClick={() => void onAddCustomModel()}
              >
                Add
              </Button>
            </Group>
            {customModels.length > 0 ? (
              <Stack gap="xs">
                {customModels.map((slug) => (
                  <Paper
                    key={slug}
                    p="sm"
                    radius="lg"
                    style={{ background: '#fbfdff' }}
                  >
                    <Group justify="space-between" wrap="nowrap" gap="md">
                      <Stack gap={1} style={{ flex: 1 }}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                          Saved model
                        </Text>
                        <Text size="sm" ff="monospace">
                          {slug}
                        </Text>
                      </Stack>
                      <Button
                        size="xs"
                        variant="light"
                        color="error"
                        loading={removeBusySlug === slug}
                        disabled={
                          removeBusySlug !== null && removeBusySlug !== slug
                        }
                        onClick={() => void onRemoveCustomModel(slug)}
                      >
                        Remove
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                No custom models saved yet.
              </Text>
            )}
          </Stack>
        </Paper>

        <Paper p="lg" radius="xl">
          <Stack gap="sm">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              What the popup will show
            </Text>
            <Title order={3} size="h3">
              Status-first behavior
            </Title>
            <Text size="sm" c="dimmed">
              The popup now favors quick control and context. It shows a dominant status card, adapts its message when setup is incomplete or the tab is unsupported, and renders a lightweight detection timeline when promo blocks exist.
            </Text>
            <Text size="sm" c="dimmed">
              Save applies the detection toggle, API key (if changed), and the selected model. Use Add only for storing extra model ids in your reusable list.
            </Text>
          </Stack>
        </Paper>

        <Group>
          <Button loading={loading} onClick={() => void onSave()}>
            Save
          </Button>
          <Button variant="default" onClick={() => void load()}>
            Reload
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
