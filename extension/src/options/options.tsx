import '@mantine/core/styles.css';

import {
    Alert,
    Box,
    Button,
    Group,
    MantineProvider,
    Paper,
    Stack,
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
import { PROVIDER_ID } from '@/shared/providers';
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
import { translator } from '@/shared/i18n/translator';
import { ChromeBuiltinInlineStatus } from '@/options/ChromeBuiltinInlineStatus';
import { OpenRouterConfigPanel } from '@/options/OpenRouterConfigPanel';
import {
    HomeIcon,
    InfoIcon,
    KeyboardIcon,
    PaletteIcon,
    TargetIcon,
    TopSkipLogoIcon,
} from '@/shared/topskip-icons';

type OpenRouterGetOkPayload = Extract<
    GetOpenRouterConfigResponse,
    { ok: true }
>;

type ActiveProviderGetOkPayload = Extract<
    GetActiveProviderResponse,
    { ok: true }
>;

type ProviderListGetOkPayload = Extract<GetProviderListResponse, { ok: true }>;

export type OptionsSectionId =
    | 'general'
    | 'detection'
    | 'appearance'
    | 'shortcuts'
    | 'about';

const OPTIONS_SECTIONS: { id: OptionsSectionId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'detection', label: 'Detection' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'about', label: 'About' },
];

const OPTIONS_BLUE = '#2563eb';
const OPTIONS_BLUE_SOFT = '#eff6ff';
const OPTIONS_BORDER = '#dbe3ee';
const OPTIONS_TEXT = '#0f172a';
const OPTIONS_MUTED = '#64748b';

/**
 * Sidebar icons keep navigation recognizable without adding an icon package.
 *
 * @param props - Section identity plus active state.
 * @returns SVG icon for the section.
 */
function OptionsSectionIcon(props: {
    sectionId: OptionsSectionId;
    active: boolean;
}): ReactElement {
    const color = props.active ? OPTIONS_BLUE : '#94a3b8';

    switch (props.sectionId) {
        case 'general':
            return <HomeIcon size={16} color={color} />;
        case 'detection':
            return <TargetIcon size={16} color={color} />;
        case 'appearance':
            return <PaletteIcon size={16} color={color} />;
        case 'shortcuts':
            return <KeyboardIcon size={16} color={color} />;
        case 'about':
            return <InfoIcon size={16} color={color} />;
    }
}

/**
 * Sidebar navigation for the options page sections.
 *
 * @param props - Active section and navigation callback.
 * @returns Options sidebar navigation.
 */
export function OptionsSidebar(props: {
    activeSection: OptionsSectionId;
    onSectionChange(sectionId: OptionsSectionId): void;
}): ReactElement {
    return (
        <Stack gap="xl" p="md" data-testid="options-sidebar" h="100%">
            <Group gap="sm" wrap="nowrap">
                <TopSkipLogoIcon size={26} />
                <Text c={OPTIONS_TEXT} fw={800} size="md" aria-hidden="true">
                    TopSkip
                </Text>
            </Group>
            <Stack gap={4} component="nav" aria-label="Settings sections">
                {OPTIONS_SECTIONS.map((section) => {
                    const active = section.id === props.activeSection;
                    return (
                        <Button
                            key={section.id}
                            variant={active ? 'light' : 'subtle'}
                            justify="flex-start"
                            color={active ? 'blue' : 'gray'}
                            radius="sm"
                            aria-current={active ? 'page' : undefined}
                            onClick={() => props.onSectionChange(section.id)}
                            leftSection={
                                <OptionsSectionIcon
                                    sectionId={section.id}
                                    active={active}
                                />
                            }
                            styles={{
                                root: {
                                    height: '2.25rem',
                                    paddingInline: '0.75rem',
                                },
                                label: {
                                    fontSize: '0.8125rem',
                                    fontWeight: 600,
                                },
                            }}
                        >
                            {section.label}
                        </Button>
                    );
                })}
            </Stack>
            <Box style={{ flex: 1 }} />
        </Stack>
    );
}

/**
 * Safe placeholder for future settings sections.
 *
 * @param props - Future section id to describe.
 * @returns Placeholder settings content.
 */
export function PlaceholderSettingsSection(props: {
    sectionId: Exclude<OptionsSectionId, 'general'>;
}): ReactElement {
    const title =
        OPTIONS_SECTIONS.find((section) => section.id === props.sectionId)
            ?.label ?? 'Settings';
    return (
        <Stack gap="md" maw={640} data-testid="options-placeholder-section">
            <Title order={2}>{title}</Title>
            <Alert color="slate" role="status">
                {`${title} settings are visible for navigation preview, but not configurable yet.`}
            </Alert>
        </Stack>
    );
}

/**
 * Accessible provider selection cards.
 *
 * @param props - Provider list, active id, and selection callback.
 * @returns Provider choice card group.
 */
export function ProviderChoiceCards(props: {
    providers: ProviderListItem[];
    activeProviderId: string;
    onProviderChange(providerId: string): void;
}): ReactElement {
    return (
        <Group
            data-testid="provider-selector"
            role="radiogroup"
            gap="md"
            align="stretch"
            wrap="wrap"
        >
            {props.providers.map((provider) => {
                const selected = provider.id === props.activeProviderId;
                const isOpenRouter = provider.id === PROVIDER_ID.OpenRouter;
                const title = isOpenRouter
                    ? 'OpenRouter BYOK'
                    : 'Chrome Built-in Prompt API';
                const description = isOpenRouter
                    ? 'Use OpenRouter with your own API key. Supports many leading models.'
                    : 'Use Chrome built-in on-device Prompt API. No external key required.';
                return (
                    <Paper
                        key={provider.id}
                        component="button"
                        type="button"
                        role="radio"
                        aria-label={title}
                        aria-checked={selected}
                        onClick={() => props.onProviderChange(provider.id)}
                        p="md"
                        radius="md"
                        style={{
                            flex: '1 1 14.5rem',
                            textAlign: 'left',
                            border: selected
                                ? `2px solid ${OPTIONS_BLUE}`
                                : `1px solid ${OPTIONS_BORDER}`,
                            background: selected ? OPTIONS_BLUE_SOFT : '#fff',
                            cursor: 'pointer',
                        }}
                    >
                        <Group align="flex-start" wrap="nowrap" gap="sm">
                            <Box
                                aria-hidden="true"
                                style={{
                                    width: '0.875rem',
                                    height: '0.875rem',
                                    borderRadius: '999px',
                                    border: selected
                                        ? `4px solid ${OPTIONS_BLUE}`
                                        : `1px solid ${OPTIONS_BORDER}`,
                                    marginTop: '0.15rem',
                                    background: '#fff',
                                    flex: '0 0 auto',
                                }}
                            />
                            <Stack gap={3} style={{ minWidth: 0 }}>
                                <Text fw={700} size="sm" c={OPTIONS_TEXT}>
                                    {title}
                                </Text>
                                <Text size="xs" c={OPTIONS_MUTED}>
                                    {description}
                                </Text>
                            </Stack>
                        </Group>
                    </Paper>
                );
            })}
        </Group>
    );
}

/**
 * Detects errors where retrying `sendMessage` after SW wake-up may succeed.
 *
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
            // FIXME rely on typed background responses; narrow errors at boundary.
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
    throw new Error(translator.getMessage('options_error_bg_no_response'));
}

// FIXME use valibot at the options↔background boundary; document in AGENTS.md.
/**
 * Narrows GET_OPENROUTER_CONFIG responses to the success payload shape.
 *
 * @param res - Untyped runtime response
 * @returns Parsed success payload, or `null` if shape is unusable
 */
function parseGetOpenRouterConfigOk(
    res: unknown,
): OpenRouterGetOkPayload | null {
    if (typeof res !== 'object' || res === null || !('ok' in res)) {
        return null;
    }
    if (Reflect.get(res, 'ok') !== true) {
        return null;
    }
    const model: unknown = Reflect.get(res, 'model');
    if (typeof model !== 'string') {
        return null;
    }
    if (!('apiKeyMasked' in res)) {
        return null;
    }
    const masked: unknown = Reflect.get(res, 'apiKeyMasked');
    if (masked !== null && typeof masked !== 'string') {
        return null;
    }
    let customModels: string[] = [];
    const rawCustomModels: unknown = Reflect.get(res, 'customModels');
    if (Array.isArray(rawCustomModels)) {
        customModels = rawCustomModels.filter(
            (x): x is string => typeof x === 'string',
        );
    }
    return {
        ok: true,
        model,
        apiKeyMasked: masked,
        customModels,
    };
}

/**
 * Narrows GET_ACTIVE_PROVIDER responses to the success payload shape.
 *
 * @param res - Untyped runtime response
 * @returns Parsed active provider payload, or `null` if shape is unusable
 */
function parseGetActiveProviderOk(
    res: unknown,
): ActiveProviderGetOkPayload | null {
    if (typeof res !== 'object' || res === null || !('ok' in res)) {
        return null;
    }
    if (Reflect.get(res, 'ok') !== true) {
        return null;
    }
    const providerId: unknown = Reflect.get(res, 'providerId');
    const displayName: unknown = Reflect.get(res, 'displayName');
    if (typeof providerId !== 'string' || typeof displayName !== 'string') {
        return null;
    }
    const modelName: unknown = Reflect.get(res, 'modelName');
    return {
        ok: true,
        providerId,
        displayName,
        modelName: typeof modelName === 'string' ? modelName : '',
    };
}

/**
 * Narrows GET_PROVIDER_LIST responses to the success payload shape.
 *
 * @param res - Untyped runtime response
 * @returns Parsed provider list payload, or `null` if shape is unusable
 */
function parseGetProviderListOk(res: unknown): ProviderListGetOkPayload | null {
    if (typeof res !== 'object' || res === null || !('ok' in res)) {
        return null;
    }
    if (Reflect.get(res, 'ok') !== true) {
        return null;
    }
    const rawProviders: unknown = Reflect.get(res, 'providers');
    if (!Array.isArray(rawProviders)) {
        return null;
    }
    const providers = rawProviders.flatMap((item) => {
        if (typeof item !== 'object' || item === null) {
            return [];
        }
        const id: unknown = Reflect.get(item, 'id');
        const displayName: unknown = Reflect.get(item, 'displayName');
        const availability: unknown = Reflect.get(item, 'availability');
        if (
            typeof id !== 'string' ||
            typeof displayName !== 'string' ||
            typeof availability !== 'string'
        ) {
            return [];
        }
        return [
            {
                id,
                displayName,
                availability: availability as ProviderAvailabilityMessage,
            } satisfies ProviderListItem,
        ];
    });
    return {
        ok: true,
        providers,
    };
}

/**
 * Type guard for successful SET_OPENROUTER_CONFIG responses.
 *
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
 * Type guard for successful custom model add/remove responses.
 *
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
 * Type guard for successful VALIDATE_OPENROUTER_MODEL responses.
 *
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
    const [, setLoading] = useState(true);
    const [providers, setProviders] = useState<ProviderListItem[]>([]);
    const [activeProviderId, setActiveProviderId] =
        useState<string>(DEFAULT_PROVIDER_ID);
    const [activeProviderDisplayName, setActiveProviderDisplayName] =
        useState('OpenRouter');
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
    const [saving, setSaving] = useState(false);
    const [removeBusySlug, setRemoveBusySlug] = useState<string | null>(null);
    const [editingModelSlug, setEditingModelSlug] = useState<string | null>(
        null,
    );
    const [editingModelDraft, setEditingModelDraft] = useState('');
    const [updateBusySlug, setUpdateBusySlug] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, setSaved] = useState(false);
    const [savedApiKeyMasked, setSavedApiKeyMasked] = useState<string | null>(
        null,
    );
    const [apiKeyVisible, { toggle: toggleApiKeyVisibility }] =
        useDisclosure(false);
    const [activeSection, setActiveSection] =
        useState<OptionsSectionId>('general');

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
            // FIXME batch provider state into one background message.
            const [providerListRes, activeProviderRes, res] = await Promise.all(
                [
                    browser.runtime.sendMessage({
                        type: TOPSKIP_MESSAGE.GET_PROVIDER_LIST,
                    }),
                    browser.runtime.sendMessage({
                        type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
                    }),
                    sendGetOpenRouterConfigWithRetry(),
                ],
            );

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
                data.model.length > 0
                    ? data.model
                    : OPENROUTER_DEFAULT_MODEL_SLUG;
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
                Reflect.get(res, 'ok') !== true
            ) {
                const rawError: unknown =
                    res && typeof res === 'object'
                        ? Reflect.get(res, 'error')
                        : undefined;
                const err =
                    typeof rawError === 'string'
                        ? rawError
                        : 'Failed to switch provider';
                setActiveProviderId(previousProviderId);
                setActiveProviderDisplayName(
                    providers.find(
                        (provider) => provider.id === previousProviderId,
                    )?.displayName ?? activeProviderDisplayName,
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
        setSaving(true);
        if (activeProviderId !== PROVIDER_ID.OpenRouter) {
            setSaved(true);
            setSaving(false);
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
        } finally {
            setSaving(false);
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
                    typeof (validationRes as { error: unknown }).error ===
                        'string'
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
                    validation.error ??
                        translator.getMessage('options_error_add_model'),
                );
                return;
            }

            // Track unverified models
            if (validation.unverified) {
                setUnverifiedModels(
                    (prev) => new Set([...prev, newModelDraft.trim()]),
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

    /**
     * Starts inline editing for a saved custom model row.
     *
     * @param slug - Existing model id to edit.
     * @returns Nothing.
     */
    const onStartCustomModelEdit = (slug: string): void => {
        setError(null);
        setEditingModelSlug(slug);
        setEditingModelDraft(slug);
    };

    /**
     * Cancels inline custom model editing without mutating storage.
     *
     * @returns Nothing.
     */
    const onCancelCustomModelEdit = (): void => {
        setEditingModelSlug(null);
        setEditingModelDraft('');
    };

    /**
     * Replaces a custom model by validating and adding the new slug first.
     *
     * @param slug - Existing model id to replace.
     * @returns Promise that resolves when the edit attempt finishes.
     */
    const onSaveCustomModelEdit = async (slug: string): Promise<void> => {
        const nextSlug = editingModelDraft.trim();
        setError(null);
        setSaved(false);

        if (nextSlug.length === 0) {
            setError(translator.getMessage('options_error_add_model'));
            return;
        }

        if (nextSlug === slug) {
            onCancelCustomModelEdit();
            return;
        }

        setUpdateBusySlug(slug);
        try {
            const validationRes: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
                slug: nextSlug,
                apiKey,
            });

            if (!isValidateOpenRouterModelOk(validationRes)) {
                const err =
                    validationRes &&
                    typeof validationRes === 'object' &&
                    'error' in validationRes &&
                    typeof (validationRes as { error: unknown }).error ===
                        'string'
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
                    validation.error ??
                        translator.getMessage('options_error_add_model'),
                );
                return;
            }

            if (validation.unverified) {
                setUnverifiedModels((prev) => new Set([...prev, nextSlug]));
            }

            if (!customModels.includes(nextSlug)) {
                const addRes: unknown = await browser.runtime.sendMessage({
                    type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
                    slug: nextSlug,
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
            }

            const removeRes: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL,
                slug,
            });
            if (!isMutateOpenRouterCustomModelOk(removeRes)) {
                const err =
                    removeRes &&
                    typeof removeRes === 'object' &&
                    'error' in removeRes &&
                    typeof (removeRes as { error: unknown }).error === 'string'
                        ? (removeRes as { error: string }).error
                        : translator.getMessage('options_error_remove_model');
                setError(err);
                return;
            }

            setModelChoice(nextSlug);
            setEditingModelSlug(null);
            setEditingModelDraft('');
            await load();
        } catch (e) {
            setError(getErrorMessage(e));
        } finally {
            setUpdateBusySlug(null);
        }
    };

    return (
        <Box
            data-testid="options-shell"
            style={{
                minHeight: '100vh',
                background: '#f3f7fc',
                color: OPTIONS_TEXT,
                padding: '1.5rem 1rem',
            }}
        >
            <style>
                {`
                    .topskip-options-frame {
                        display: grid;
                        grid-template-columns: 180px minmax(0, 1fr);
                    }
                    @media (max-width: 720px) {
                        .topskip-options-frame {
                            grid-template-columns: minmax(0, 1fr);
                        }
                        .topskip-options-sidebar {
                            border-right: 0 !important;
                            border-bottom: 1px solid var(--mantine-color-slate-2);
                        }
                    }
                `}
            </style>
            <Box
                className="topskip-options-frame"
                style={{
                    maxWidth: '52rem',
                    margin: '0 auto',
                    background: '#fff',
                    border: `1px solid ${OPTIONS_BORDER}`,
                    borderRadius: '0.75rem',
                    overflow: 'hidden',
                    boxShadow: '0 14px 36px rgba(15, 23, 42, 0.1)',
                }}
            >
                <Box
                    className="topskip-options-sidebar"
                    style={{
                        borderRight: `1px solid ${OPTIONS_BORDER}`,
                        background: '#fbfdff',
                    }}
                >
                    <OptionsSidebar
                        activeSection={activeSection}
                        onSectionChange={setActiveSection}
                    />
                </Box>
                <Box p="lg" style={{ minWidth: 0 }}>
                    {activeSection === 'general' ? (
                        <Stack gap="md">
                            <Stack gap={4}>
                                <Title order={1} size="h3" c={OPTIONS_TEXT}>
                                    TopSkip Settings
                                </Title>
                                <Text size="xs" c={OPTIONS_MUTED}>
                                    Configure how TopSkip detects and skips
                                    promo segments on YouTube.
                                </Text>
                            </Stack>

                            {error ? (
                                <Alert color="error" role="alert">
                                    {error}
                                </Alert>
                            ) : null}
                            <Stack gap="sm">
                                <Title order={2} size="h4">
                                    1. Promo-detection provider
                                </Title>
                                <ProviderChoiceCards
                                    providers={providers}
                                    activeProviderId={activeProviderId}
                                    onProviderChange={(nextId) => {
                                        void onProviderChange(nextId);
                                    }}
                                />
                                {activeProviderId ===
                                    PROVIDER_ID.ChromePromptApi && (
                                    <ChromeBuiltinInlineStatus />
                                )}
                            </Stack>

                            {activeProviderId === PROVIDER_ID.OpenRouter && (
                                <OpenRouterConfigPanel
                                    apiKey={apiKey}
                                    apiKeyVisible={apiKeyVisible}
                                    savedApiKeyMasked={savedApiKeyMasked}
                                    modelChoice={modelChoice}
                                    modelSelectData={modelSelectData}
                                    customModels={customModels}
                                    newModelDraft={newModelDraft}
                                    addBusy={addBusy}
                                    saveBusy={saving}
                                    removeBusySlug={removeBusySlug}
                                    editingModelSlug={editingModelSlug}
                                    editingModelDraft={editingModelDraft}
                                    updateBusySlug={updateBusySlug}
                                    validationError={error}
                                    unverifiedModels={unverifiedModels}
                                    onApiKeyChange={setApiKey}
                                    onToggleApiKeyVisibility={
                                        toggleApiKeyVisibility
                                    }
                                    onModelChoiceChange={(value) => {
                                        setModelChoice(
                                            value ??
                                                OPENROUTER_DEFAULT_MODEL_SLUG,
                                        );
                                    }}
                                    onNewModelDraftChange={setNewModelDraft}
                                    onSave={() => {
                                        void onSave();
                                    }}
                                    onAddCustomModel={() => {
                                        void onAddCustomModel();
                                    }}
                                    onEditCustomModel={(slug) => {
                                        onStartCustomModelEdit(slug);
                                    }}
                                    onEditCustomModelDraftChange={
                                        setEditingModelDraft
                                    }
                                    onSaveCustomModelEdit={(slug) => {
                                        void onSaveCustomModelEdit(slug);
                                    }}
                                    onCancelCustomModelEdit={() => {
                                        onCancelCustomModelEdit();
                                    }}
                                    onRemoveCustomModel={(slug) => {
                                        void onRemoveCustomModel(slug);
                                    }}
                                />
                            )}
                        </Stack>
                    ) : (
                        <PlaceholderSettingsSection sectionId={activeSection} />
                    )}
                </Box>
            </Box>
        </Box>
    );
}
