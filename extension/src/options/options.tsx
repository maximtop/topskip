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
import { PREFS_PORT_NAME } from '@/shared/constants';
import { PROVIDER_ID } from '@/shared/providers';
import {
    TOPSKIP_MESSAGE,
    type ConnectionEntryMessage,
    type ConnectionProviderId,
    type DetectionModelMessage,
    type GetActiveProviderResponse,
    type GetModelSettingsResponse,
    type GetOpenRouterConfigResponse,
    type GetProviderListResponse,
    type MutateOpenRouterCustomModelResponse,
    type ProviderAvailabilityMessage,
    type ProviderListItem,
    type SaveConnectionKeyResponse,
    type SetOpenRouterConfigResponse,
    type TestConnectionKeyResponse,
    type ValidateOpenRouterModelResponse,
    isPrefsPortMessage,
} from '@/shared/messages';
import { topskipTheme } from '@/shared/theme';
import { ErrorBoundary } from '@/shared/ErrorBoundary';
import { i18n } from '@/shared/i18n/i18n';
import { translator } from '@/shared/i18n/translator';
import { AddModelPanel } from '@/options/AddModelPanel';
import {
    ConnectionsPanel,
    type ConnectionTestState,
} from '@/options/ConnectionsPanel';
import { ModelSelectionPanel } from '@/options/ModelSelectionPanel';
import {
    HomeIcon,
    InfoIcon,
    KeyboardIcon,
    PaletteIcon,
    TargetIcon,
    TopSkipLogoIcon,
} from '@/shared/topskip-icons';

/**
 * Successful OpenRouter config response used after runtime shape narrowing.
 */
type OpenRouterGetOkPayload = Extract<
    GetOpenRouterConfigResponse,
    { ok: true }
>;

/**
 * Successful active-provider response used by legacy options helpers.
 */
type ActiveProviderGetOkPayload = Extract<
    GetActiveProviderResponse,
    { ok: true }
>;

/**
 * Successful provider-list response used by legacy options helpers.
 */
type ProviderListGetOkPayload = Extract<GetProviderListResponse, { ok: true }>;

/**
 * Section identifiers used by the options sidebar and content switcher.
 */
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
    sectionId: Exclude<OptionsSectionId, 'general' | 'about'>;
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
 * About content keeps extension metadata out of the compact popup.
 *
 * @param props - Runtime extension metadata.
 * @returns Minimal About settings content.
 */
export function AboutSettingsSection(props: {
    extensionVersion: string;
}): ReactElement {
    return (
        <Stack gap="md" maw={640} data-testid="options-about-section">
            <Stack gap={4}>
                <Title order={2}>About TopSkip</Title>
                <Text size="sm" c={OPTIONS_MUTED}>
                    Automatically skip detected sponsor and promo segments on
                    YouTube.
                </Text>
            </Stack>
            <Group gap="sm" wrap="nowrap">
                <Text size="sm" fw={700} c={OPTIONS_TEXT}>
                    Version
                </Text>
                <Text size="sm" c={OPTIONS_MUTED}>
                    {`v${props.extensionVersion}`}
                </Text>
            </Group>
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
export function isTransientSendMessageFailure(err: unknown): boolean {
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
export async function sendGetOpenRouterConfigWithRetry(): Promise<unknown> {
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
export function parseGetOpenRouterConfigOk(
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
export function parseGetActiveProviderOk(
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
export function parseGetProviderListOk(
    res: unknown,
): ProviderListGetOkPayload | null {
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
export function isSetOpenRouterOk(
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
export function isMutateOpenRouterCustomModelOk(
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
export function isValidateOpenRouterModelOk(
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
    const extensionVersion = browser.runtime.getManifest().version;
    const [, setLoading] = useState(true);
    const [activeModelId, setActiveModelId] = useState('');
    const [models, setModels] = useState<DetectionModelMessage[]>([]);
    const [connections, setConnections] = useState<ConnectionEntryMessage[]>(
        [],
    );
    const [customModels, setCustomModels] = useState<string[]>([]);
    const [newModelDraft, setNewModelDraft] = useState('');
    const [connectionDrafts, setConnectionDrafts] = useState<
        Record<ConnectionProviderId, string>
    >({ openrouter: '', openai: '' });
    const [busyProviderId, setBusyProviderId] =
        useState<ConnectionProviderId | null>(null);
    const [testStates, setTestStates] = useState<
        Partial<Record<ConnectionProviderId, ConnectionTestState>>
    >({});
    const [addBusy, setAddBusy] = useState(false);
    const [removeBusySlug, setRemoveBusySlug] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeSection, setActiveSection] =
        useState<OptionsSectionId>('general');

    const missingConnectionProviderId = useMemo(() => {
        const activeModel = models.find((model) => model.id === activeModelId);
        if (!activeModel?.requiresConnection) {
            return null;
        }
        const connection = connections.find(
            (entry) => entry.providerId === activeModel.providerId,
        );
        if (connection?.status === 'missing') {
            return connection.providerId;
        }
        return null;
    }, [activeModelId, connections, models]);

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            const res: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.GET_MODEL_SETTINGS,
            });
            if (
                typeof res !== 'object' ||
                res === null ||
                Reflect.get(res, 'ok') !== true
            ) {
                const rawError: unknown =
                    typeof res === 'object' && res !== null
                        ? Reflect.get(res, 'error')
                        : undefined;
                setError(
                    typeof rawError === 'string'
                        ? rawError
                        : translator.getMessage('options_error_load_failed'),
                );
                return;
            }
            const data = res as Extract<GetModelSettingsResponse, { ok: true }>;
            setActiveModelId(data.activeModelId);
            setModels(data.models);
            setConnections(data.connections);
            setCustomModels(data.customOpenRouterModels);
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
                void load();
            }
        });
        return () => {
            port.disconnect();
        };
    }, [load]);

    const onModelChange = async (modelId: string): Promise<void> => {
        setError(null);
        const previousModelId = activeModelId;
        setActiveModelId(modelId);
        try {
            const res: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.SET_ACTIVE_MODEL,
                modelId,
            });
            if (
                typeof res !== 'object' ||
                res === null ||
                Reflect.get(res, 'ok') !== true
            ) {
                const rawError: unknown =
                    typeof res === 'object' && res !== null
                        ? Reflect.get(res, 'error')
                        : null;
                setActiveModelId(previousModelId);
                setError(
                    typeof rawError === 'string'
                        ? rawError
                        : 'Failed to switch model',
                );
                return;
            }
            await load();
        } catch (e) {
            setActiveModelId(previousModelId);
            setError(getErrorMessage(e));
        }
    };

    const onConnectionDraftChange = (
        providerId: ConnectionProviderId,
        value: string,
    ): void => {
        setConnectionDrafts((current) => ({ ...current, [providerId]: value }));
        setTestStates((current) => ({
            ...current,
            [providerId]: { kind: 'idle' },
        }));
    };

    const onSaveConnection = async (
        providerId: ConnectionProviderId,
    ): Promise<void> => {
        setError(null);
        setBusyProviderId(providerId);
        try {
            const res: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.SAVE_CONNECTION_KEY,
                providerId,
                apiKey: connectionDrafts[providerId],
            });
            if (
                typeof res !== 'object' ||
                res === null ||
                Reflect.get(res, 'ok') !== true
            ) {
                const rawError: unknown =
                    typeof res === 'object' && res !== null
                        ? Reflect.get(res, 'error')
                        : null;
                setError(
                    typeof rawError === 'string'
                        ? rawError
                        : translator.getMessage('options_error_save_failed'),
                );
                return;
            }
            const saved = res as Extract<
                SaveConnectionKeyResponse,
                { ok: true }
            >;
            setConnectionDrafts((current) => ({
                ...current,
                [providerId]: '',
            }));
            setConnections((current) =>
                current.map((entry) =>
                    entry.providerId === providerId
                        ? {
                              ...entry,
                              apiKeyMasked: saved.apiKeyMasked,
                              status:
                                  saved.apiKeyMasked === null
                                      ? 'missing'
                                      : 'saved',
                          }
                        : entry,
                ),
            );
            await load();
        } catch (e) {
            setError(getErrorMessage(e));
        } finally {
            setBusyProviderId(null);
        }
    };

    const onTestConnection = async (
        providerId: ConnectionProviderId,
    ): Promise<void> => {
        setError(null);
        setBusyProviderId(providerId);
        try {
            const res: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.TEST_CONNECTION_KEY,
                providerId,
                apiKey: connectionDrafts[providerId],
            });
            if (
                typeof res !== 'object' ||
                res === null ||
                Reflect.get(res, 'ok') !== true
            ) {
                const rawError: unknown =
                    typeof res === 'object' && res !== null
                        ? Reflect.get(res, 'error')
                        : null;
                setTestStates((current) => ({
                    ...current,
                    [providerId]: {
                        kind: 'error',
                        error:
                            typeof rawError === 'string'
                                ? rawError
                                : 'Connection test failed',
                    },
                }));
                return;
            }
            const data = res as Extract<
                TestConnectionKeyResponse,
                { ok: true }
            >;
            setTestStates((current) => ({
                ...current,
                [providerId]: data.valid
                    ? { kind: 'valid' }
                    : { kind: 'invalid', error: data.error },
            }));
        } catch (e) {
            setTestStates((current) => ({
                ...current,
                [providerId]: { kind: 'error', error: getErrorMessage(e) },
            }));
        } finally {
            setBusyProviderId(null);
        }
    };

    const onAddCustomModel = async (): Promise<void> => {
        setError(null);
        setAddBusy(true);
        try {
            const validationRes: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
                slug: newModelDraft.trim(),
                apiKey: connectionDrafts.openrouter,
            });
            if (!isValidateOpenRouterModelOk(validationRes)) {
                setError('Validation failed');
                return;
            }
            if (!validationRes.valid) {
                setError(
                    validationRes.error ??
                        translator.getMessage('options_error_add_model'),
                );
                return;
            }

            const addRes: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
                slug: newModelDraft,
            });
            if (!isMutateOpenRouterCustomModelOk(addRes)) {
                setError(translator.getMessage('options_error_add_model'));
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

    const onRemoveCustomModel = async (slug: string): Promise<void> => {
        setError(null);
        setRemoveBusySlug(slug);
        try {
            const res: unknown = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL,
                slug,
            });
            if (!isMutateOpenRouterCustomModelOk(res)) {
                setError(translator.getMessage('options_error_remove_model'));
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
                            <ModelSelectionPanel
                                activeModelId={activeModelId}
                                models={models}
                                missingConnectionProviderId={
                                    missingConnectionProviderId
                                }
                                onModelChange={(modelId) => {
                                    void onModelChange(modelId);
                                }}
                                onOpenConnection={(_providerId) => {
                                    setActiveSection('general');
                                }}
                            />
                            <ConnectionsPanel
                                connections={connections}
                                drafts={connectionDrafts}
                                busyProviderId={busyProviderId}
                                testStates={testStates}
                                onDraftChange={onConnectionDraftChange}
                                onSave={(providerId) => {
                                    void onSaveConnection(providerId);
                                }}
                                onTest={(providerId) => {
                                    void onTestConnection(providerId);
                                }}
                            />
                            <AddModelPanel
                                customModels={customModels}
                                newModelDraft={newModelDraft}
                                addBusy={addBusy}
                                removeBusySlug={removeBusySlug}
                                onNewModelDraftChange={setNewModelDraft}
                                onAddCustomModel={() => {
                                    void onAddCustomModel();
                                }}
                                onRemoveCustomModel={(slug) => {
                                    void onRemoveCustomModel(slug);
                                }}
                            />
                        </Stack>
                    ) : activeSection === 'about' ? (
                        <AboutSettingsSection
                            extensionVersion={extensionVersion}
                        />
                    ) : (
                        <PlaceholderSettingsSection sectionId={activeSection} />
                    )}
                </Box>
            </Box>
        </Box>
    );
}
