import { observer } from 'mobx-react-lite';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Box,
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
import {
    formatPromoBlocksSummary,
    formatSecondsAsTimecode,
} from '@/shared/promo-range-format';
import { translator } from '@/shared/i18n/translator';
import {
    POPUP_DETECTION_POLL_INTERVAL_MS,
    MIN_PROMO_BLOCK_WIDTH_SEC,
} from '@/popup/constants';
import {
    ANALYSIS_MODE,
    PERCENT_SCALE,
    type AnalysisMode,
} from '@/shared/constants';
import { PROVIDER_ID } from '@/shared/providers';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import {
    CheckIcon,
    PromoBlocksIcon,
    SettingsIcon,
    TopSkipLogoIcon,
} from '@/shared/topskip-icons';

const POPUP_BLUE = '#2563eb';
const POPUP_BLUE_DARK = '#1d4ed8';
const POPUP_BLUE_SOFT = '#eff6ff';
const POPUP_SUCCESS = '#10b981';
const POPUP_SUCCESS_SOFT = '#ecfdf5';
const POPUP_WARNING = '#f59e0b';
const POPUP_WARNING_SOFT = '#fffbeb';
const POPUP_DANGER = '#ef4444';
const POPUP_DANGER_SOFT = '#fef2f2';
const POPUP_SLATE_BORDER = '#dbe3ee';
const ACTIVITY_LABEL_ACTIVE = 'Promo detection active';
const ACTIVITY_LABEL_PAUSED = 'Promo detection paused';
const ACTIVITY_LABEL_UNAVAILABLE = 'Status unavailable';

const POPUP_TONE_STYLES: Record<
    PopupTone,
    {
        surface: string;
        icon: string;
        iconText: string;
        title: string;
        dot: string;
    }
> = {
    brand: {
        surface: POPUP_BLUE_SOFT,
        icon: POPUP_BLUE,
        iconText: '#ffffff',
        title: POPUP_BLUE_DARK,
        dot: POPUP_BLUE,
    },
    success: {
        surface: POPUP_SUCCESS_SOFT,
        icon: POPUP_SUCCESS,
        iconText: '#ffffff',
        title: '#15803d',
        dot: '#16a34a',
    },
    warning: {
        surface: POPUP_WARNING_SOFT,
        icon: POPUP_WARNING,
        iconText: '#ffffff',
        title: '#b45309',
        dot: POPUP_WARNING,
    },
    danger: {
        surface: POPUP_DANGER_SOFT,
        icon: POPUP_DANGER,
        iconText: '#ffffff',
        title: '#b91c1c',
        dot: POPUP_DANGER,
    },
    neutral: {
        surface: POPUP_SUCCESS_SOFT,
        icon: POPUP_SUCCESS,
        iconText: '#ffffff',
        title: '#15803d',
        dot: '#16a34a',
    },
    paused: {
        surface: POPUP_WARNING_SOFT,
        icon: POPUP_WARNING,
        iconText: '#ffffff',
        title: '#b45309',
        dot: POPUP_WARNING,
    },
};

/**
 * Type guard for successful GET_DETECTION_STATUS responses.
 *
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
 * Localized short label for a promo detection status chip.
 *
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

/**
 * Visual tone names used to map popup states to stable colors.
 */
type PopupTone =
    | 'brand'
    | 'success'
    | 'warning'
    | 'danger'
    | 'neutral'
    | 'paused';

/**
 * Fully resolved display state consumed by the popup component.
 */
type PopupStatusViewModel = {
    tone: PopupTone;
    badgeLabel: string;
    badgeColor: string;
    title: string;
    description: string;
    activityLabel: string;
    statusHeadline: string;
    statusBody: string | null;
    settingsLabel: string;
    providerLabel: string;
};

/**
 * Fully resolved popup state with the selected route shown independently.
 */
type PopupViewModel = PopupStatusViewModel & {
    modeLabel: string;
};

/**
 * Inputs needed to derive popup mode and detection status copy.
 */
type PopupViewModelArgs = {
    enabled: boolean;
    analysisMode: AnalysisMode;
    detectionState: PromoDetectionStatePayload | null;
    prefsError: string | null;
    detectionError: string | null;
    providerId: string;
    providerDisplayName: string;
    modelDisplayName: string;
    chromeModelAvailability: ProviderAvailabilityMessage | null;
};

/**
 * Builds the view-model that drives the popup's UI,
 * based on extension state and detection results.
 *
 * @param args - Current prefs and detection state.
 * @returns The resolved view-model.
 */
function buildPopupStatusViewModel(
    args: PopupViewModelArgs,
): PopupStatusViewModel {
    const {
        enabled,
        detectionState,
        prefsError,
        detectionError,
        providerId,
        providerDisplayName,
        modelDisplayName,
        chromeModelAvailability,
        analysisMode,
    } = args;

    const providerLabel = modelDisplayName
        ? `${modelDisplayName} · ${providerDisplayName}`
        : providerDisplayName;

    if (prefsError !== null || detectionError !== null) {
        const message = prefsError ?? detectionError ?? 'Status unavailable';
        return {
            tone: 'danger',
            badgeLabel: 'Error',
            badgeColor: 'error',
            title: 'Status unavailable',
            description: 'TopSkip could not refresh its current state.',
            activityLabel: ACTIVITY_LABEL_UNAVAILABLE,
            statusHeadline: message,
            statusBody: null,
            settingsLabel: 'Open settings',
            providerLabel,
        };
    }

    if (!enabled) {
        return {
            tone: 'paused',
            badgeLabel: 'Off',
            badgeColor: 'gray',
            title: 'TopSkip is paused',
            description:
                'Auto-skip is disabled for YouTube ' +
                'until you turn it back on.',
            activityLabel: ACTIVITY_LABEL_PAUSED,
            statusHeadline: 'Automatic sponsor skipping is currently off.',
            statusBody:
                'You can still open settings and ' + 'review your model setup.',
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
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: 'Waiting for a supported watch page.',
            statusBody:
                'Detection details will appear here ' +
                'when a video is available.',
            settingsLabel: 'Open settings',
            providerLabel,
        };
    }

    if (
        detectionState.status === 'analyzing' &&
        detectionState.source === 'server'
    ) {
        return {
            tone: 'brand',
            badgeLabel: translator.getMessage(
                'popup_detection_server_pending_badge',
            ),
            badgeColor: 'brand',
            title: translator.getMessage(
                'popup_detection_server_pending_title',
            ),
            description: translator.getMessage(
                'popup_detection_server_pending_description',
            ),
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: translator.getMessage(
                'popup_detection_server_pending_headline',
            ),
            statusBody: translator.getMessage(
                'popup_detection_server_pending_body',
            ),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        detectionState.status === 'error' &&
        detectionState.source === 'server'
    ) {
        return {
            tone: 'danger',
            badgeLabel: translator.getMessage(
                'popup_detection_server_error_badge',
            ),
            badgeColor: 'error',
            title: translator.getMessage('popup_detection_server_error_title'),
            description: translator.getMessage(
                'popup_detection_server_error_description',
            ),
            activityLabel: ACTIVITY_LABEL_UNAVAILABLE,
            statusHeadline:
                detectionState.error ??
                translator.getMessage('popup_detection_server_error_headline'),
            statusBody: translator.getMessage(
                'popup_detection_server_error_body',
            ),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        detectionState.status === 'detected' &&
        detectionState.source === 'server_cache'
    ) {
        return {
            tone: 'brand',
            badgeLabel: translator.getMessage(
                'popup_detection_server_cache_badge',
            ),
            badgeColor: 'brand',
            title: translator.getMessage('popup_detection_server_cache_title'),
            description: translator.getMessage(
                'popup_detection_server_cache_description',
            ),
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: translator.getMessage(
                'popup_detection_server_cache_headline',
            ),
            statusBody:
                detectionState.promoBlocks !== undefined &&
                detectionState.promoBlocks.length > 0
                    ? formatPromoBlocksSummary(detectionState.promoBlocks)
                    : null,
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        detectionState.status === 'no_promo' &&
        detectionState.source === 'server'
    ) {
        return {
            tone: 'success',
            badgeLabel: translator.getMessage(
                'popup_detection_server_no_promo_badge',
            ),
            badgeColor: 'success',
            title: translator.getMessage(
                'popup_detection_server_no_promo_title',
            ),
            description: translator.getMessage(
                'popup_detection_server_no_promo_description',
            ),
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: translator.getMessage(
                'popup_detection_server_no_promo_headline',
            ),
            statusBody: translator.getMessage(
                'popup_detection_server_no_promo_body',
            ),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        detectionState.status === 'unavailable' &&
        detectionState.source === 'server'
    ) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage(
                'popup_detection_server_unavailable_badge',
            ),
            badgeColor: 'warning',
            title: translator.getMessage(
                'popup_detection_server_unavailable_title',
            ),
            description: translator.getMessage(
                'popup_detection_server_unavailable_description',
            ),
            activityLabel: ACTIVITY_LABEL_UNAVAILABLE,
            statusHeadline:
                detectionState.error ??
                translator.getMessage(
                    'popup_detection_server_unavailable_headline',
                ),
            statusBody: translator.getMessage(
                'popup_detection_server_unavailable_body',
            ),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        analysisMode === ANALYSIS_MODE.Byok &&
        detectionState.status === 'not_configured' &&
        detectionState.source === 'local_provider'
    ) {
        const providerName =
            providerDisplayName ??
            translator.getMessage('popup_analysis_mode_byok');
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage('popup_byok_setup_badge'),
            badgeColor: 'warning',
            title: translator.getMessage('popup_byok_setup_title'),
            description: translator.getMessage('popup_byok_setup_description', {
                provider: providerName,
            }),
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: translator.getMessage('popup_byok_setup_badge'),
            statusBody: translator.getMessage('popup_byok_setup_body'),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        providerId === PROVIDER_ID.ChromePromptApi &&
        chromeModelAvailability !== null &&
        chromeModelAvailability !== PROVIDER_AVAILABILITY.AVAILABLE
    ) {
        if (chromeModelAvailability === PROVIDER_AVAILABILITY.DOWNLOADING) {
            return {
                tone: 'brand',
                badgeLabel: 'Downloading',
                badgeColor: 'brand',
                title: 'Preparing Chrome Built-in model',
                description: 'Gemini Nano is downloading on this device.',
                activityLabel: ACTIVITY_LABEL_ACTIVE,
                statusHeadline: 'Model downloading...',
                statusBody:
                    'Keep this popup open or check settings for progress.',
                settingsLabel: 'Open settings',
                providerLabel,
            };
        }

        if (chromeModelAvailability === PROVIDER_AVAILABILITY.UNAVAILABLE) {
            return {
                tone: 'warning',
                badgeLabel: 'Unavailable',
                badgeColor: 'warning',
                title: 'Chrome model unavailable',
                description:
                    'This device does not currently meet Chrome Built-in requirements.',
                activityLabel: ACTIVITY_LABEL_ACTIVE,
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
            activityLabel: ACTIVITY_LABEL_ACTIVE,
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
                activityLabel: ACTIVITY_LABEL_ACTIVE,
                statusHeadline: 'LLM detection is not configured yet.',
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
                activityLabel: ACTIVITY_LABEL_ACTIVE,
                statusHeadline: 'No detection snapshot is available.',
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
                activityLabel: ACTIVITY_LABEL_ACTIVE,
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
                title: `${count} promo ${count === 1 ? 'block' : 'blocks'} found`,
                description:
                    'TopSkip has marked the current ' +
                    'sponsor windows for this video.',
                activityLabel: ACTIVITY_LABEL_ACTIVE,
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
                activityLabel: ACTIVITY_LABEL_ACTIVE,
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
                    'TopSkip could not analyze the ' + 'current transcript.',
                activityLabel: ACTIVITY_LABEL_UNAVAILABLE,
                statusHeadline:
                    detectionState.error ?? 'Detection failed for this tab.',
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
                    'TopSkip reported a state update ' + 'for the current tab.',
                activityLabel: ACTIVITY_LABEL_ACTIVE,
                statusHeadline: detectionLabel(detectionState.status),
                statusBody: null,
                settingsLabel: 'Open settings',
                providerLabel,
            };
    }
}

/**
 * Adds the persisted mode label to every popup status branch.
 *
 * @param args - Current preferences, provider details, and detection state.
 * @returns Status copy with an explicit selected analysis mode.
 */
export function buildPopupViewModel(args: PopupViewModelArgs): PopupViewModel {
    return {
        ...buildPopupStatusViewModel(args),
        modeLabel: translator.getMessage(
            args.analysisMode === ANALYSIS_MODE.Byok
                ? 'popup_analysis_mode_byok'
                : 'popup_analysis_mode_server',
        ),
    };
}

/**
 * Renders a visual timeline bar of detected promo blocks.
 *
 * @param props - Contains the blocks to display.
 * @returns The timeline element, or null when empty.
 */
function PromoTimeline({
    blocks,
}: {
    blocks: readonly PromoBlock[];
}): ReactElement | null {
    if (blocks.length === 0) {
        return null;
    }

    const maxEnd = blocks.reduce((max, block) => {
        return Math.max(max, getPromoBlockEndSec(block));
    }, 60);

    return (
        <Stack gap={6} mt="sm">
            <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed">
                    0:00
                </Text>
                <Text size="xs" c="dimmed">
                    {formatSecondsAsTimecode(maxEnd)}
                </Text>
            </Group>
            <Box
                aria-hidden="true"
                style={{
                    position: 'relative',
                    height: '0.625rem',
                    borderRadius: '999px',
                    background:
                        'repeating-linear-gradient(90deg, ' +
                        'var(--mantine-color-slate-3) 0 1px, ' +
                        'var(--mantine-color-slate-1) 1px 20%), ' +
                        'var(--mantine-color-slate-1)',
                    overflow: 'hidden',
                }}
            >
                {blocks.map((block, index) => {
                    const end = getPromoBlockEndSec(block);
                    const left = `${(block.startSec / maxEnd) * PERCENT_SCALE}%`;
                    const barSpan = Math.max(
                        end - block.startSec,
                        MIN_PROMO_BLOCK_WIDTH_SEC,
                    );
                    const width = `${(barSpan / maxEnd) * PERCENT_SCALE}%`;
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
        }, POPUP_DETECTION_POLL_INTERVAL_MS);

        const onRuntimeMessage = (message: unknown): void => {
            if (
                message &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED
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
        analysisMode: store.analysisMode,
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
    const toneStyle = POPUP_TONE_STYLES[view.tone];

    return (
        <Stack
            data-testid="popup-shell"
            gap={0}
            w={320}
            maw="100vw"
            style={{
                background: '#ffffff',
                overflowX: 'hidden',
                border: `1px solid ${POPUP_SLATE_BORDER}`,
                borderRadius: 0,
                boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)',
            }}
        >
            <Paper
                data-testid="popup-current-video"
                p={0}
                radius={0}
                style={{
                    background: '#ffffff',
                    borderBottom: `1px solid ${POPUP_SLATE_BORDER}`,
                }}
            >
                <Group
                    justify="space-between"
                    align="center"
                    wrap="nowrap"
                    gap="sm"
                    px="md"
                    py={12}
                >
                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                        <TopSkipLogoIcon size={28} />
                        <Text c="#0f172a" fw={800} size="lg" aria-hidden="true">
                            TopSkip
                        </Text>
                    </Group>
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="lg"
                        aria-label={view.settingsLabel}
                        onClick={() => {
                            void browser.runtime.openOptionsPage();
                        }}
                    >
                        <SettingsIcon size={18} color="currentColor" />
                    </ActionIcon>
                </Group>

                <Group
                    justify="space-between"
                    wrap="nowrap"
                    gap="sm"
                    px="md"
                    py={8}
                    style={{ borderTop: `1px solid ${POPUP_SLATE_BORDER}` }}
                >
                    <Text size="xs" c="dimmed">
                        {translator.getMessage('popup_analysis_mode_label')}
                    </Text>
                    <Badge variant="light" color="blue" size="sm">
                        {view.modeLabel}
                    </Badge>
                </Group>

                <Group
                    gap="sm"
                    wrap="nowrap"
                    align="flex-start"
                    px="md"
                    py={14}
                    style={{ background: toneStyle.surface }}
                >
                    <Box
                        aria-hidden="true"
                        style={{
                            width: '1.125rem',
                            height: '1.125rem',
                            borderRadius: '999px',
                            background: toneStyle.icon,
                            color: toneStyle.iconText,
                            display: 'grid',
                            placeItems: 'center',
                            flex: '0 0 auto',
                            fontWeight: 900,
                        }}
                    >
                        {view.tone === 'danger' ? (
                            '!'
                        ) : view.tone === 'paused' ? (
                            'i'
                        ) : view.tone === 'warning' ? (
                            'i'
                        ) : (
                            <CheckIcon size={12} color={toneStyle.iconText} />
                        )}
                    </Box>
                    <Stack gap={3} style={{ minWidth: 0 }}>
                        <Text size="sm" fw={700} c={toneStyle.title}>
                            {view.title}
                        </Text>
                        <Text size="xs" c="#64748b">
                            {view.description}
                        </Text>
                        <Group gap={6} wrap="nowrap">
                            <Box
                                aria-hidden="true"
                                style={{
                                    width: '0.35rem',
                                    height: '0.35rem',
                                    borderRadius: '999px',
                                    background: toneStyle.dot,
                                }}
                            />
                            <Text size="xs" c="#334155">
                                {view.activityLabel}
                            </Text>
                        </Group>
                    </Stack>
                </Group>
            </Paper>

            <Paper
                data-testid="popup-auto-skip"
                p="md"
                radius={0}
                style={{
                    borderBottom: `1px solid ${POPUP_SLATE_BORDER}`,
                }}
            >
                <Group
                    justify="space-between"
                    wrap="nowrap"
                    align="center"
                    gap="md"
                >
                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text fw={700} size="sm">
                            Auto-skip promo segments
                        </Text>
                        <Text size="xs" c="dimmed">
                            Automatically skip detected sponsor & promo segments
                        </Text>
                    </Stack>
                    <Stack gap={4} align="center">
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
                            color="blue"
                            size="md"
                        />
                        <Text
                            size="xs"
                            c={store.enabled ? POPUP_BLUE_DARK : 'dimmed'}
                            fw={700}
                        >
                            {store.enabled ? 'ON' : 'OFF'}
                        </Text>
                    </Stack>
                </Group>
            </Paper>

            <Paper
                data-testid="popup-promo-blocks"
                p="md"
                radius={0}
                style={{
                    borderBottom: `1px solid ${POPUP_SLATE_BORDER}`,
                }}
            >
                <div role="status" aria-live="polite">
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                        <Stack gap={2} style={{ minWidth: 0 }}>
                            <Group gap="xs" wrap="nowrap">
                                <PromoBlocksIcon size={16} color="#475569" />
                                <Text fw={700} size="sm">
                                    Promo blocks detected
                                </Text>
                            </Group>
                            <Text size="xs" c="dimmed">
                                {view.statusHeadline}
                            </Text>
                        </Stack>
                        <Badge
                            color="blue"
                            variant="light"
                            style={{
                                flex: '0 0 auto',
                                textTransform: 'none',
                            }}
                        >
                            {`${detectedBlocks.length} ${
                                detectedBlocks.length === 1 ? 'block' : 'blocks'
                            }`}
                        </Badge>
                    </Group>
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
                {detectedBlocks.length > 0 ? (
                    <Stack gap="sm" mt="md">
                        {detectedBlocks.map((block, index) => {
                            const end = getPromoBlockEndSec(block);
                            const duration = Math.max(0, end - block.startSec);
                            return (
                                <Group
                                    key={`${block.startSec}-${end}-${index}`}
                                    justify="space-between"
                                    wrap="nowrap"
                                    gap="sm"
                                >
                                    <Group
                                        gap="sm"
                                        wrap="nowrap"
                                        style={{ minWidth: 0 }}
                                    >
                                        <Badge
                                            radius="xl"
                                            variant="filled"
                                            color="blue"
                                        >
                                            {index + 1}
                                        </Badge>
                                        <Text
                                            size="sm"
                                            fw={600}
                                            style={{ whiteSpace: 'nowrap' }}
                                        >
                                            {`${formatSecondsAsTimecode(
                                                block.startSec,
                                            )} - ${formatSecondsAsTimecode(end)}`}
                                        </Text>
                                    </Group>
                                    <Text
                                        size="xs"
                                        c="dimmed"
                                        style={{ whiteSpace: 'nowrap' }}
                                    >
                                        {`${Math.round(duration)}s`}
                                    </Text>
                                </Group>
                            );
                        })}
                    </Stack>
                ) : null}
            </Paper>
        </Stack>
    );
});
