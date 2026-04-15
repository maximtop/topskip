import '@mantine/core/styles.css';

import {
  Button,
  Checkbox,
  Group,
  MantineProvider,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
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
        <MantineProvider defaultColorScheme="auto">
          <OptionsApp />
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
    <Stack gap="md" p="lg" maw={520}>
      <Text fw={600}>TopSkip — LLM promo detection</Text>
      <Text size="sm" c="dimmed">
        Configure OpenRouter for transcript analysis. The API key is stored only
        in this browser profile (extension local storage).
      </Text>
      <Checkbox
        label="Enable LLM promo detection"
        checked={enabled}
        onChange={(e) => {
          setEnabled(e.currentTarget.checked);
        }}
      />
      <TextInput
        label="OpenRouter API key"
        placeholder="sk-or-…"
        type="password"
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
      />
      <Select
        label="Model"
        description="Built-in presets and models you added below."
        data={modelSelectData}
        value={modelChoice}
        onChange={(v) => {
          setModelChoice(v ?? OPENROUTER_DEFAULT_MODEL_SLUG);
        }}
      />
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          Add a model
        </Text>
        <Text size="xs" c="dimmed">
          Type an OpenRouter model id (for example vendor/model), then Add to
          keep it for later sessions. This is not the same as Save below.
        </Text>
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
      </Stack>
      {customModels.length > 0 ? (
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Your added models
          </Text>
          {customModels.map((slug) => (
            <Group key={slug} justify="space-between" wrap="nowrap">
              <Text size="sm" ff="monospace">
                {slug}
              </Text>
              <Button
                size="xs"
                variant="light"
                color="red"
                loading={removeBusySlug === slug}
                disabled={removeBusySlug !== null && removeBusySlug !== slug}
                onClick={() => void onRemoveCustomModel(slug)}
              >
                Remove
              </Button>
            </Group>
          ))}
        </Stack>
      ) : null}
      {error ? (
        <Text size="sm" c="red">
          {error}
        </Text>
      ) : null}
      {saved ? (
        <Text size="sm" c="green">
          Saved.
        </Text>
      ) : null}
      <Group>
        <Button loading={loading} onClick={() => void onSave()}>
          Save
        </Button>
        <Button variant="default" onClick={() => void load()}>
          Reload
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Save applies the detection toggle, API key (if changed), and the
        selected model. Use Add to store extra model ids in your list.
      </Text>
    </Stack>
  );
}
