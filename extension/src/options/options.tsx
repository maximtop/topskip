import '@mantine/core/styles.css';

import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  MantineProvider,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
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
import { DEFAULT_PROVIDER_ID, PREFS_PORT_NAME } from '@/shared/constants';
import {
  TOPSKIP_MESSAGE,
  type GetActiveProviderResponse,
  type GetOpenRouterConfigResponse,
  type GetProviderListResponse,
  type MutateOpenRouterCustomModelResponse,
  type ProviderAvailabilityMessage,
  type ProviderListItem,
  type SetOpenRouterConfigResponse,
  type ValidateOpenRouterModelResponse,
  isPrefsPortMessage,
} from '@/shared/messages';
import {
  OPENROUTER_DEFAULT_MODEL_SLUG,
  OPENROUTER_MODEL_PRESETS,
} from '@/shared/openrouter-model-presets';
import { topskipTheme } from '@/shared/theme';
import { ErrorBoundary } from '@/shared/ErrorBoundary';
import { i18n } from '@/shared/i18n/i18n';
import { reactTranslator } from '@/shared/i18n/react-translator';
import { translator } from '@/shared/i18n/translator';
import { ChromeBuiltinInlineStatus } from '@/options/ChromeBuiltinInlineStatus';
import { OpenRouterConfigPanel } from '@/options/OpenRouterConfigPanel';

type OpenRouterGetOkPayload = Extract<
  GetOpenRouterConfigResponse,
  { ok: true }
>;

type ActiveProviderGetOkPayload = Extract<
  GetActiveProviderResponse,
  { ok: true }
>;

type ProviderListGetOkPayload = Extract<
  GetProviderListResponse,
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
      // FIXME we should rely more on the messages from background page, catch errors with types
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
    translator.getMessage('options_error_bg_no_response'),
  );
}

// FIXME why not using valibot for validation types? improve also agents.md about this
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
  if (typeof o.model !== 'string') {
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
    model: o.model,
    apiKeyMasked: masked,
    customModels,
  };
}

/**
 * @param res - Untyped runtime response
 * @returns Parsed active provider payload, or `null` if shape is unusable
 */
function parseGetActiveProviderOk(
  res: unknown,
): ActiveProviderGetOkPayload | null {
  if (typeof res !== 'object' || res === null || !('ok' in res)) {
    return null;
  }
  if ((res as { ok: boolean }).ok !== true) {
    return null;
  }
  const payload = res as Record<string, unknown>;
  if (
    typeof payload.providerId !== 'string' ||
    typeof payload.displayName !== 'string'
  ) {
    return null;
  }
  return {
    ok: true,
    providerId: payload.providerId,
    displayName: payload.displayName,
    modelName:
      typeof payload.modelName === 'string' ? payload.modelName : '',
  };
}

/**
 * @param res - Untyped runtime response
 * @returns Parsed provider list payload, or `null` if shape is unusable
 */
function parseGetProviderListOk(
  res: unknown,
): ProviderListGetOkPayload | null {
  if (typeof res !== 'object' || res === null || !('ok' in res)) {
    return null;
  }
  if ((res as { ok: boolean }).ok !== true) {
    return null;
  }
  const payload = res as Record<string, unknown>;
  if (!Array.isArray(payload.providers)) {
    return null;
  }
  const providers = payload.providers.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.displayName !== 'string' ||
      typeof row.availability !== 'string'
    ) {
      return [];
    }
    return [{
      id: row.id,
      displayName: row.displayName,
      availability: row.availability as ProviderAvailabilityMessage,
    } satisfies ProviderListItem];
  });
  return {
    ok: true,
    providers,
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
 * @param res - Untyped runtime response
 * @returns Whether the payload is a successful validation response
 */
function isValidateOpenRouterModelOk(
  res: unknown,
): res is Extract<ValidateOpenRouterModelResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true &&
    'valid' in res &&
    typeof (res as { valid: unknown }).valid === 'boolean'
  );
}

/**
 * Options page root; not instantiable.
 */
export class Options {
  private constructor() {}

  /**
   * Mounts the options React app under `#root`.
   *
   * @returns Promise resolving after i18n init and render
   */
  static async init(): Promise<void> {
    await i18n.init();
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
  // FIXME why this states are not handled in the mobx?
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [activeProviderId, setActiveProviderId] = useState(
    DEFAULT_PROVIDER_ID,
  );
  const [activeProviderDisplayName, setActiveProviderDisplayName] = useState(
    'OpenRouter',
  );
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState<string>(
    OPENROUTER_DEFAULT_MODEL_SLUG,
  );
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [newModelDraft, setNewModelDraft] = useState('');
  const [unverifiedModels, setUnverifiedModels] = useState<Set<string>>(
    new Set(),
  );
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
  const activeProviderLabel = useMemo(
    () =>
      providers.find((provider) => provider.id === activeProviderId)
        ?.displayName ?? activeProviderDisplayName,
    [activeProviderDisplayName, activeProviderId, providers],
  );
  const chromeAvailability = useMemo(
    () =>
      providers.find(
        (provider) => provider.id === 'chrome-prompt-api',
      )?.availability ?? 'unavailable',
    [providers],
  );

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
      const [prefsRes, providerListRes, activeProviderRes, res] =
      // FIXME I prefer sending less messages, this could be wrapped in one message
        await Promise.all([
          browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_PREFS,
          }),
          browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_PROVIDER_LIST,
          }),
          browser.runtime.sendMessage({
            type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
          }),
          sendGetOpenRouterConfigWithRetry(),
        ]);
      if (
        prefsRes &&
        typeof prefsRes === 'object' &&
        'ok' in prefsRes &&
        (prefsRes as { ok: boolean }).ok === true &&
        'prefs' in prefsRes
      ) {
        const prefs = (prefsRes as { prefs: { enabled?: boolean } }).prefs;
        if (typeof prefs.enabled === 'boolean') {
          setEnabled(prefs.enabled);
        }
      }

      const providerList = parseGetProviderListOk(providerListRes);
      if (!providerList) {
        setError('Failed to load provider list');
        return;
      }
      setProviders(providerList.providers);

      const activeProvider = parseGetActiveProviderOk(activeProviderRes);
      if (!activeProvider) {
        setError('Failed to load active provider');
        return;
      }
      setActiveProviderId(activeProvider.providerId);
      setActiveProviderDisplayName(activeProvider.displayName);

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
          : translator.getMessage('options_error_load_failed');
        setError(err);
        return;
      }
      const data = parseGetOpenRouterConfigOk(res);
      if (!data) {
        setError(translator.getMessage('options_error_load_failed'));
        return;
      }
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

  useEffect(() => {
    const port = browser.runtime.connect({ name: PREFS_PORT_NAME });
    port.onMessage.addListener((msg: unknown) => {
      if (isPrefsPortMessage(msg)) {
        setEnabled(msg.prefs.enabled);
        if (typeof msg.prefs.providerId === 'string') {
          setActiveProviderId(msg.prefs.providerId);
        }
      }
    });
    return () => {
      port.disconnect();
    };
  }, []);

  /**
   * Persists the active provider choice immediately when the segmented control
   * changes.
   *
   * @param nextProviderId - Newly selected provider identifier
   * @returns Promise that resolves when the switch attempt finishes
   */
  const onProviderChange = async (nextProviderId: string): Promise<void> => {
    const previousProviderId = activeProviderId;
    const nextProvider = providers.find(
      (provider) => provider.id === nextProviderId,
    );

    setError(null);
    setSaved(false);
    setActiveProviderId(nextProviderId);
    if (nextProvider) {
      setActiveProviderDisplayName(nextProvider.displayName);
    }

    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER,
        providerId: nextProviderId,
      });
      if (
        !res ||
        typeof res !== 'object' ||
        !('ok' in res) ||
        (res as { ok: boolean }).ok !== true
      ) {
        const err =
          res &&
          typeof res === 'object' &&
          'error' in res &&
          typeof (res as { error: unknown }).error === 'string'
            ? (res as { error: string }).error
            : 'Failed to switch provider';
        setActiveProviderId(previousProviderId);
        setActiveProviderDisplayName(
          providers.find((provider) => provider.id === previousProviderId)
            ?.displayName ?? activeProviderDisplayName,
        );
        setError(err);
        return;
      }
      setSaved(true);
    } catch (e) {
      setActiveProviderId(previousProviderId);
      setActiveProviderDisplayName(
        providers.find((provider) => provider.id === previousProviderId)
          ?.displayName ?? activeProviderDisplayName,
      );
      setError(getErrorMessage(e));
    }
  };

  /**
   * Persists OpenRouter settings via the background service worker.
   *
   * @returns Promise that resolves when save attempt finishes
   */
  const onSave = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    if (activeProviderId !== 'openrouter') {
      setSaved(true);
      return;
    }
    try {
      const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG,
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
            : translator.getMessage('options_error_save_failed');
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
   * First validates the slug format and (if API key present) existence.
   *
   * @returns Promise that resolves when the add attempt finishes
   */
  const onAddCustomModel = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    setAddBusy(true);
    try {
      // Validate slug first
      const validationRes: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: newModelDraft.trim(),
        apiKey,
      });

      if (!isValidateOpenRouterModelOk(validationRes)) {
        const err =
          validationRes &&
          typeof validationRes === 'object' &&
          'error' in validationRes &&
          typeof (validationRes as { error: unknown }).error === 'string'
            ? (validationRes as { error: string }).error
            : 'Validation failed';
        setError(err);
        return;
      }

      const validation = validationRes as {
        ok: true;
        valid: boolean;
        error?: string;
        unverified?: boolean;
      };

      if (!validation.valid) {
        setError(
          validation.error ?? translator.getMessage('options_error_add_model'),
        );
        return;
      }

      // Track unverified models
      if (validation.unverified) {
        setUnverifiedModels(
          (prev) =>
            new Set([...prev, newModelDraft.trim()]),
        );
      }

      // Proceed with adding the model
      const addRes: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
        slug: newModelDraft,
      });
      if (!isMutateOpenRouterCustomModelOk(addRes)) {
        const err =
          addRes &&
          typeof addRes === 'object' &&
          'error' in addRes &&
          typeof (addRes as { error: unknown }).error === 'string'
            ? (addRes as { error: string }).error
            : translator.getMessage('options_error_add_model');
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
            : translator.getMessage('options_error_remove_model');
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
          style={{
            background:
              'linear-gradient(180deg, #fff 0%, #f8fafc 100%)',
          }}
        >
          <Group
            justify="space-between"
            align="flex-start"
            wrap="wrap"
            gap="md"
          >
            <Stack gap={4} maw={560}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                TopSkip settings
              </Text>
              <Title order={2} size="h2">
                {reactTranslator.getMessage('options_heading')}
              </Title>
              <Text size="sm" c="dimmed">
                {reactTranslator.getMessage('options_description')}
              </Text>
            </Stack>
            <Group gap="xs">
              <Badge
                color={enabled ? 'brand' : 'gray'}
              >
                {enabled
                  ? 'Detection enabled'
                  : 'Detection paused'}
              </Badge>
              <Badge
                color={
                  activeProviderId === 'openrouter'
                    ? setupReady
                      ? 'success'
                      : 'warning'
                    : chromeAvailability === 'available'
                      ? 'success'
                      : 'gray'
                }
              >
                {activeProviderLabel}
              </Badge>
            </Group>
          </Group>
        </Paper>

        <Group align="stretch" wrap="wrap" gap="md">
          <Paper
            p="md"
            radius="xl"
            style={{
              flex: '1 1 180px',
              minWidth: 180,
            }}
          >
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Current state
            </Text>
            <Text fw={700} mt={6}>
              {enabled ? 'Ready to analyze' : 'Paused'}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              The popup will show a quick status card
              for the current YouTube tab.
            </Text>
          </Paper>
          <Paper
            p="md"
            radius="xl"
            style={{
              flex: '1 1 180px',
              minWidth: 180,
            }}
          >
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Connection
            </Text>
            <Text fw={700} mt={6}>
              {activeProviderId === 'openrouter'
                ? setupReady
                  ? savedApiKeyMasked
                  : 'No API key saved'
                : 'Runs on your device'}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              {activeProviderId === 'openrouter'
                ? 'Keep the field blank below if you want to preserve the '
                  + 'saved key.'
                : 'Chrome Built-in uses the local browser model instead of '
                  + 'a cloud API key.'}
            </Text>
          </Paper>
          <Paper
            p="md"
            radius="xl"
            style={{
              flex: '1 1 180px',
              minWidth: 180,
            }}
          >
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Active provider
            </Text>
            <Text fw={700} mt={6}>
              {activeProviderLabel}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              {activeProviderId === 'openrouter'
                ? `Model: ${modelChoice}`
                : `Availability: ${chromeAvailability}`}
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
            {reactTranslator.getMessage('options_saved')}
          </Alert>
        ) : null}

        <Paper p="lg" radius="xl">
          <Stack gap="md">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                LLM provider
              </Text>
              <Title order={3} size="h3">
                Choose the analysis backend
              </Title>
              <Text size="sm" c="dimmed">
                Switch between the existing OpenRouter flow and the upcoming
                Chrome Built-in provider. The selected provider takes effect as
                soon as you switch tabs.
              </Text>
            </Stack>
            <SegmentedControl
              data-testid="provider-selector"
              fullWidth
              value={activeProviderId}
              onChange={(nextId) => {
                void onProviderChange(nextId);
              }}
              data={providers.map((provider) => ({
                value: provider.id,
                label: provider.displayName,
              }))}
            />
            <Group gap="xs">
              {providers.map((provider) => (
                <Badge
                  key={provider.id}
                  color={
                    provider.availability === 'available'
                      ? 'success'
                      : provider.availability === 'unavailable'
                        ? 'gray'
                        : 'brand'
                  }
                  variant={
                    provider.id === activeProviderId ? 'filled' : 'light'
                  }
                >
                  {provider.displayName}: {provider.availability}
                </Badge>
              ))}
            </Group>
            {activeProviderId === 'chrome-prompt-api' && (
              <ChromeBuiltinInlineStatus />
            )}
          </Stack>
        </Paper>

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
                The popup stays intentionally simple.
                Enable or pause transcript analysis
                here. Provider-specific settings live
                below.
              </Text>
            </Stack>
            <Paper
              p="md"
              radius="lg"
              style={{ background: '#fbfdff' }}
            >
              <Group
                justify="space-between"
                wrap="nowrap"
                gap="md"
                align="flex-start"
              >
                <Stack gap={2} style={{ flex: 1 }}>
                  <Text fw={600}>
                    {translator.getMessage(
                      'options_enable_detection',
                    )}
                  </Text>
                  <Text size="xs" c="dimmed">
                    When enabled, TopSkip analyzes
                    available captions and marks promo
                    windows for skipping.
                  </Text>
                </Stack>
                <Switch
                  checked={enabled}
                  onChange={(e) => {
                    const val = e.currentTarget.checked;
                    setEnabled(val);
                    void browser.runtime.sendMessage({
                      type: TOPSKIP_MESSAGE.SET_PREFS,
                      enabled: val,
                    });
                  }}
                  aria-label={translator.getMessage(
                    'options_enable_detection',
                  )}
                />
              </Group>
            </Paper>
          </Stack>
        </Paper>

        {activeProviderId === 'openrouter' && (
          <OpenRouterConfigPanel
            apiKey={apiKey}
            apiKeyVisible={apiKeyVisible}
            savedApiKeyMasked={savedApiKeyMasked}
            modelChoice={modelChoice}
            modelSelectData={modelSelectData}
            customModels={customModels}
            newModelDraft={newModelDraft}
            addBusy={addBusy}
            removeBusySlug={removeBusySlug}
            validationError={error}
            unverifiedModels={unverifiedModels}
            onApiKeyChange={setApiKey}
            onToggleApiKeyVisibility={toggleApiKeyVisibility}
            onModelChoiceChange={(value) => {
              setModelChoice(value ?? OPENROUTER_DEFAULT_MODEL_SLUG);
            }}
            onNewModelDraftChange={setNewModelDraft}
            onAddCustomModel={() => {
              void onAddCustomModel();
            }}
            onRemoveCustomModel={(slug) => {
              void onRemoveCustomModel(slug);
            }}
          />
        )}

        <Paper p="lg" radius="xl">
          <Stack gap="sm">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              What the popup will show
            </Text>
            <Title order={3} size="h3">
              Status-first behavior
            </Title>
            <Text size="sm" c="dimmed">
              {reactTranslator.getMessage('options_save_help')}
            </Text>
          </Stack>
        </Paper>

        <Group>
          <Button loading={loading} onClick={() => void onSave()}>
            {reactTranslator.getMessage('options_save_button')}
          </Button>
          <Button variant="default" onClick={() => void load()}>
            {reactTranslator.getMessage('options_reload_button')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
