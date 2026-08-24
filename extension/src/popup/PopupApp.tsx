import { observer } from 'mobx-react-lite';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Box,
    Button,
    Group,
    Paper,
    Skeleton,
    Stack,
    Switch,
    Text,
} from '@mantine/core';

import { PreferencesStore } from '@/popup/preferences-store';
import { DetectionRefreshGuard } from '@/popup/detection-refresh-guard';
import {
    DETECTION_REFRESH_OUTCOME,
    DETECTION_PUSH_ACTION,
    DETECTION_TRANSPORT_STATUS,
    INITIAL_DETECTION_TRANSPORT_STATE,
    applyDetectionTransportFailure,
    applyDetectionTransportSuccess,
    getDetectionRefreshDelay,
    getDetectionPushAction,
    isDetectionReadCurrent,
    isDetectionTransportKnown,
    type DetectionTransportState,
} from '@/popup/detection-transport-state';
import { DebugLoggingIndicator } from '@/popup/DebugLoggingIndicator';
import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
    PROMO_DETECTION_SOURCE,
    SERVER_ANALYSIS_PHASE,
    TOPSKIP_MESSAGE,
    pickMessage,
    type GetDetectionStatusResponse,
    type ProviderAvailabilityMessage,
    type PromoDetectionStatePayload,
} from '@/shared/messages';
import {
    PROMO_DETECTION_STATUS,
    type PromoBlock,
    type PromoDetectionStatus,
} from '@topskip/common/promo-types';
import {
    formatPromoBlocksSummary,
    formatSecondsAsTimecode,
} from '@/shared/promo-range-format';
import { translator } from '@/shared/i18n/translator';
import {
    POPUP_STATE_FAILURE_RETRY_MS,
    MIN_PROMO_BLOCK_WIDTH_SEC,
} from '@/popup/constants';
import { requestDetectionStatusWithTimeout } from '@/popup/detection-status-request';
import { requestContentScriptReattachWithTimeout } from '@/popup/content-script-reattach-request';
import {
    ANALYSIS_MODE,
    PERCENT_SCALE,
    type AnalysisMode,
} from '@/shared/constants';
import {
    SERVER_FAILURE_CATEGORY,
    SERVER_FAILURE_REPORT_ACTION,
    classifyServerFailure,
    getServerFailureReportAction,
    type ServerFailureReportAction,
} from '@/shared/server-analysis-failure';
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

/**
 * Keeps unavailable activity copy aligned with the selected popup locale.
 *
 * @returns Localized unavailable activity label.
 */
function getUnavailableActivityLabel(): string {
    return translator.getMessage('popup_status_unavailable_activity');
}

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
 * Type guard for successful GET_DETECTION_STATUS responses. The debug-logging
 * flag is mandatory so the popup indicator never renders from a default.
 *
 * @param res - Untyped runtime response
 * @returns Whether the payload is a successful detection status response
 */
export function isGetDetectionOk(
    res: unknown,
): res is Extract<GetDetectionStatusResponse, { ok: true }> {
    if (typeof res !== 'object' || res === null) {
        return false;
    }
    const tabId: unknown = Reflect.get(res, 'tabId');
    return (
        Reflect.get(res, 'ok') === true &&
        (tabId === null || typeof tabId === 'number') &&
        'state' in res &&
        typeof Reflect.get(res, 'debugLoggingEnabled') === 'boolean'
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
        case PROMO_DETECTION_STATUS.NotConfigured:
            return translator.getMessage('popup_detection_not_configured');
        case PROMO_DETECTION_STATUS.Unavailable:
            return translator.getMessage('popup_detection_unavailable');
        case PROMO_DETECTION_STATUS.Analyzing:
            return translator.getMessage('popup_detection_analyzing');
        case PROMO_DETECTION_STATUS.Detected:
            return translator.getMessage('popup_detection_detected');
        case PROMO_DETECTION_STATUS.NoPromo:
            return translator.getMessage('popup_detection_no_promo');
        case PROMO_DETECTION_STATUS.Error:
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
    reportAction?: ServerFailureReportAction;
    reportLabel?: string;
};

/**
 * Fully resolved popup state with the selected route shown independently and
 * the debug-logging indicator text (`null` when nothing should render).
 */
type PopupViewModel = PopupStatusViewModel & {
    modeLabel: string;
    debugLoggingLabel: string | null;
};

/**
 * Inputs needed to derive popup mode and detection status copy.
 * `debugLoggingEnabled` is `null` while the background status is unknown.
 */
type PopupViewModelArgs = {
    enabled: boolean;
    analysisMode: AnalysisMode;
    detectionState: PromoDetectionStatePayload | null;
    prefsError: string | null;
    detectionError: string | null;
    detectionStale: boolean;
    providerId: string;
    providerDisplayName: string;
    modelDisplayName: string;
    chromeModelAvailability: ProviderAvailabilityMessage | null;
    debugLoggingEnabled: boolean | null;
};

/**
 * Builds localized public-server failure copy from stable codes only.
 *
 * @param input - Typed failure state and provider label used by the popup.
 * @returns Safe popup view model without raw backend text.
 */
function buildServerFailureViewModel(input: {
    state: PromoDetectionStatePayload;
    providerLabel: string;
}): PopupStatusViewModel {
    const failure = input.state.serverFailure;
    if (failure === undefined) {
        throw new Error('Expected typed server failure.');
    }
    const category = classifyServerFailure(failure.code);
    const reportAction = getServerFailureReportAction(failure.code);
    const settingsLabel = translator.getMessage('popup_open_settings');
    const reportState =
        reportAction === SERVER_FAILURE_REPORT_ACTION.None
            ? {}
            : {
                    reportAction,
                    reportLabel: translator.getMessage(
                        reportAction === SERVER_FAILURE_REPORT_ACTION.Primary
                            ? 'popup_server_report_primary'
                            : 'popup_server_report_secondary',
                    ),
                };

    if (category === SERVER_FAILURE_CATEGORY.VideoLimitation) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage(
                'popup_detection_server_unavailable_badge',
            ),
            badgeColor: 'warning',
            title: translator.getMessage('popup_server_limitation_title'),
            description: translator.getMessage(
                'popup_server_limitation_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_server_limitation_headline',
            ),
            statusBody: translator.getMessage('popup_server_limitation_body'),
            settingsLabel,
            providerLabel: input.providerLabel,
            ...reportState,
        };
    }
    if (category === SERVER_FAILURE_CATEGORY.CaptureFailure) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage('popup_capture_failure_badge'),
            badgeColor: 'warning',
            title: translator.getMessage('popup_capture_failure_title'),
            description: translator.getMessage(
                'popup_capture_failure_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_capture_failure_headline',
            ),
            statusBody: translator.getMessage('popup_capture_failure_body'),
            settingsLabel,
            providerLabel: input.providerLabel,
            ...reportState,
        };
    }
    if (category === SERVER_FAILURE_CATEGORY.TemporaryCapacity) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage(
                'popup_detection_server_unavailable_badge',
            ),
            badgeColor: 'warning',
            title: translator.getMessage('popup_server_temporary_title'),
            description: translator.getMessage(
                'popup_server_temporary_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_server_temporary_headline',
            ),
            statusBody:
                failure.retryAfterSec === undefined
                    ? translator.getMessage('popup_server_temporary_body')
                    : translator.getMessage('popup_server_temporary_retry', {
                            seconds: String(failure.retryAfterSec),
                        }),
            settingsLabel,
            providerLabel: input.providerLabel,
        };
    }
    if (category === SERVER_FAILURE_CATEGORY.UpgradeRequired) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage(
                'popup_detection_server_unavailable_badge',
            ),
            badgeColor: 'warning',
            title: translator.getMessage('popup_server_upgrade_title'),
            description: translator.getMessage(
                'popup_server_upgrade_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_server_upgrade_headline',
            ),
            statusBody: translator.getMessage('popup_server_upgrade_body'),
            settingsLabel,
            providerLabel: input.providerLabel,
        };
    }
    if (category === SERVER_FAILURE_CATEGORY.ExtensionFailure) {
        return {
            tone: 'warning',
            badgeLabel: translator.getMessage('popup_extension_failure_badge'),
            badgeColor: 'warning',
            title: translator.getMessage('popup_extension_failure_title'),
            description: translator.getMessage(
                'popup_extension_failure_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_extension_failure_headline',
            ),
            statusBody: translator.getMessage('popup_extension_failure_body'),
            settingsLabel,
            providerLabel: input.providerLabel,
        };
    }
    return {
        tone: 'danger',
        badgeLabel: translator.getMessage('popup_detection_server_error_badge'),
        badgeColor: 'error',
        title: translator.getMessage('popup_server_failure_title'),
        description: translator.getMessage('popup_server_failure_description'),
        activityLabel: getUnavailableActivityLabel(),
        statusHeadline: translator.getMessage('popup_server_failure_headline'),
        statusBody: translator.getMessage('popup_server_failure_body'),
        settingsLabel,
        providerLabel: input.providerLabel,
        ...reportState,
    };
}

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
        return {
            tone: 'danger',
            badgeLabel: translator.getMessage('popup_status_unavailable_badge'),
            badgeColor: 'error',
            title: translator.getMessage('popup_status_unavailable_title'),
            description: translator.getMessage(
                'popup_status_unavailable_description',
            ),
            activityLabel: getUnavailableActivityLabel(),
            statusHeadline: translator.getMessage(
                'popup_status_unavailable_headline',
            ),
            statusBody: null,
            settingsLabel: translator.getMessage('popup_open_settings'),
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
        detectionState.source === PROMO_DETECTION_SOURCE.Server &&
        detectionState.serverFailure !== undefined
    ) {
        return buildServerFailureViewModel({
            state: detectionState,
            providerLabel,
        });
    }

    if (
        detectionState.status === PROMO_DETECTION_STATUS.Analyzing &&
        detectionState.source === PROMO_DETECTION_SOURCE.Server
    ) {
        const isCaptionAcquisition =
            detectionState.serverAnalysisPhase ===
            SERVER_ANALYSIS_PHASE.CaptionAcquisition;
        const keyPrefix = isCaptionAcquisition
            ? 'popup_detection_server_acquisition'
            : 'popup_detection_server_pending';
        return {
            tone: 'brand',
            badgeLabel: translator.getMessage(`${keyPrefix}_badge`),
            badgeColor: 'brand',
            title: translator.getMessage(`${keyPrefix}_title`),
            description: translator.getMessage(`${keyPrefix}_description`),
            activityLabel: ACTIVITY_LABEL_ACTIVE,
            statusHeadline: translator.getMessage(`${keyPrefix}_headline`),
            statusBody: translator.getMessage(`${keyPrefix}_body`),
            settingsLabel: translator.getMessage('popup_open_settings'),
            providerLabel,
        };
    }

    if (
        detectionState.status === PROMO_DETECTION_STATUS.Error &&
        detectionState.source === PROMO_DETECTION_SOURCE.Server
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
            activityLabel: getUnavailableActivityLabel(),
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
        detectionState.status === PROMO_DETECTION_STATUS.Detected &&
        detectionState.source === PROMO_DETECTION_SOURCE.ServerCache
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
        detectionState.status === PROMO_DETECTION_STATUS.NoPromo &&
        detectionState.source === PROMO_DETECTION_SOURCE.Server
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
        detectionState.status === PROMO_DETECTION_STATUS.Unavailable &&
        detectionState.source === PROMO_DETECTION_SOURCE.Server
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
            activityLabel: getUnavailableActivityLabel(),
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
        detectionState.status === PROMO_DETECTION_STATUS.NotConfigured &&
        detectionState.source === PROMO_DETECTION_SOURCE.LocalProvider
    ) {
        const providerName =
            providerDisplayName.trim() ||
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
        case PROMO_DETECTION_STATUS.NotConfigured:
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
        case PROMO_DETECTION_STATUS.Unavailable:
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
        case PROMO_DETECTION_STATUS.Analyzing:
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
        case PROMO_DETECTION_STATUS.Detected: {
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
        case PROMO_DETECTION_STATUS.NoPromo:
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
        case PROMO_DETECTION_STATUS.Error:
            return {
                tone: 'danger',
                badgeLabel: 'Error',
                badgeColor: 'error',
                title: 'Detection error',
                description:
                    'TopSkip could not analyze the ' + 'current transcript.',
                activityLabel: getUnavailableActivityLabel(),
                statusHeadline:
                    detectionState.error ?? 'Detection failed for this tab.',
                statusBody:
                    'Open settings to verify the API key ' +
                    'and selected model.',
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
    const status = buildPopupStatusViewModel(args);
    return {
        ...status,
        ...(args.detectionStale && args.prefsError === null
            ? {
                    activityLabel: translator.getMessage(
                        'popup_status_stale_activity',
                    ),
                }
            : {}),
        modeLabel: translator.getMessage(
            args.analysisMode === ANALYSIS_MODE.Byok
                ? 'popup_analysis_mode_byok'
                : 'popup_analysis_mode_server',
        ),
        debugLoggingLabel:
            args.debugLoggingEnabled === true
                ? translator.getMessage('popup_debug_logging_on')
                : null,
    };
}

/**
 * Renders a visual timeline bar of detected promo blocks.
 *
 * @param props - Contains the blocks and authoritative video duration.
 * @returns The timeline element, or null without safe scale metadata.
 */
function PromoTimeline({
    blocks,
    durationSec,
}: {
    blocks: readonly PromoBlock[];
    durationSec?: number;
}): ReactElement | null {
    if (
        blocks.length === 0 ||
        durationSec === undefined ||
        !Number.isFinite(durationSec) ||
        durationSec <= 0
    ) {
        return null;
    }

    return (
        <Stack data-testid="popup-promo-timeline" gap={6} mt="sm">
            <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed">
                    0:00
                </Text>
                <Text size="xs" c="dimmed">
                    {formatSecondsAsTimecode(durationSec)}
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
                    const start = Math.max(
                        0,
                        Math.min(block.startSec, durationSec),
                    );
                    const end = Math.max(
                        start,
                        Math.min(getPromoBlockEndSec(block), durationSec),
                    );
                    const left = `${(start / durationSec) * PERCENT_SCALE}%`;
                    const barSpan = Math.min(
                        Math.max(end - start, MIN_PROMO_BLOCK_WIDTH_SEC),
                        durationSec - start,
                    );
                    const width = `${(barSpan / durationSec) * PERCENT_SCALE}%`;
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
    const [detectionTransport, setDetectionTransport] =
        useState<DetectionTransportState>(INITIAL_DETECTION_TRANSPORT_STATE);
    // Last switch state read from the background; left untouched on failed
    // reads so a stale popup keeps the last known value.
    const [debugLoggingEnabled, setDebugLoggingEnabled] = useState<
        boolean | null
    >(null);

    useEffect(() => {
        let cancelled = false;
        let retryTimerId: number | null = null;
        const loadPrefs = async (): Promise<void> => {
            try {
                await store.load();
                if (cancelled) {
                    return;
                }
                setPrefsError(null);
            } catch (e) {
                if (cancelled) {
                    return;
                }
                setPrefsError(getErrorMessage(e));
                retryTimerId = window.setTimeout(() => {
                    retryTimerId = null;
                    void loadPrefs();
                }, POPUP_STATE_FAILURE_RETRY_MS);
            }
        };

        void loadPrefs();
        store.connectPort();
        return () => {
            cancelled = true;
            if (retryTimerId !== null) {
                window.clearTimeout(retryTimerId);
            }
            store.disconnectPort();
        };
    }, [store]);

    useEffect(() => {
        // Opening the popup is the user gesture that grants `activeTab`, so
        // this is the moment to re-attach the watch bundles into a tab that an
        // install/update/reload orphaned. The background decides whether the
        // tab needs it; a resulting detection change reaches this popup through
        // the PROMO_DETECTION_UPDATED push, so the reply is not consumed here.
        void requestContentScriptReattachWithTimeout().catch(() => undefined);
    }, []);

    useEffect(() => {
        let cancelled = false;
        let refreshTimerId: number | null = null;
        let pushRevision = 0;
        let activeTabId: number | null | undefined;
        const detectionRefreshGuard = new DetectionRefreshGuard();

        const clearRefreshTimer = (): void => {
            if (refreshTimerId !== null) {
                window.clearTimeout(refreshTimerId);
                refreshTimerId = null;
            }
        };

        const scheduleRefresh = (delayMs: number): void => {
            clearRefreshTimer();
            refreshTimerId = window.setTimeout(() => {
                refreshTimerId = null;
                refreshDetection();
            }, delayMs);
        };

        const handleRefreshCompletion = (
            startedPushRevision: number,
            applyCompletion: () => void,
        ): void => {
            const completion = detectionRefreshGuard.completeRefresh();
            if (cancelled) {
                return;
            }
            if (
                completion.applyCompletion &&
                isDetectionReadCurrent(startedPushRevision, pushRevision)
            ) {
                applyCompletion();
            }
            if (completion.runFollowUp) {
                void runDetectionRefresh();
            }
        };

        const runDetectionRefresh = async (): Promise<void> => {
            const startedPushRevision = pushRevision;
            try {
                const res = await requestDetectionStatusWithTimeout();
                handleRefreshCompletion(startedPushRevision, () => {
                    if (!isGetDetectionOk(res)) {
                        setDetectionTransport((current) =>
                            applyDetectionTransportFailure(
                                current,
                                'Detection status response was invalid.',
                            ),
                        );
                        scheduleRefresh(
                            getDetectionRefreshDelay(
                                DETECTION_REFRESH_OUTCOME.Failure,
                            ),
                        );
                        return;
                    }
                    activeTabId = res.tabId;
                    setDebugLoggingEnabled(res.debugLoggingEnabled);
                    setDetectionTransport((current) =>
                        applyDetectionTransportSuccess(
                            current,
                            res.tabId,
                            res.state,
                        ),
                    );
                    scheduleRefresh(
                        getDetectionRefreshDelay(
                            DETECTION_REFRESH_OUTCOME.Healthy,
                        ),
                    );
                });
            } catch (e) {
                handleRefreshCompletion(startedPushRevision, () => {
                    setDetectionTransport((current) =>
                        applyDetectionTransportFailure(
                            current,
                            getErrorMessage(e),
                        ),
                    );
                    scheduleRefresh(
                        getDetectionRefreshDelay(
                            DETECTION_REFRESH_OUTCOME.Failure,
                        ),
                    );
                });
            }
        };

        const refreshDetection = (): void => {
            if (!detectionRefreshGuard.requestRefresh()) {
                return;
            }
            void runDetectionRefresh();
        };

        const onRuntimeMessage = (message: unknown): void => {
            const pushed = pickMessage(
                TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
                message,
            );
            if (pushed === undefined) {
                return;
            }
            const action = getDetectionPushAction(
                activeTabId,
                pushed.tabId,
            );
            if (action === DETECTION_PUSH_ACTION.Reconcile) {
                clearRefreshTimer();
                refreshDetection();
                return;
            }
            if (action === DETECTION_PUSH_ACTION.Ignore) {
                return;
            }
            pushRevision += 1;
            setDetectionTransport((current) =>
                applyDetectionTransportSuccess(
                    current,
                    pushed.tabId,
                    pushed.payload,
                ),
            );
            scheduleRefresh(
                getDetectionRefreshDelay(DETECTION_REFRESH_OUTCOME.Healthy),
            );
        };
        browser.runtime.onMessage.addListener(onRuntimeMessage);
        refreshDetection();
        return () => {
            cancelled = true;
            clearRefreshTimer();
            browser.runtime.onMessage.removeListener(onRuntimeMessage);
        };
    }, []);

    const detectionState = detectionTransport.snapshot;
    const detectionLoaded =
        detectionTransport.status !== DETECTION_TRANSPORT_STATUS.Loading;
    const detectionError =
        detectionTransport.status === DETECTION_TRANSPORT_STATUS.Unavailable
            ? detectionTransport.error
            : null;

    const view = buildPopupViewModel({
        enabled: store.enabled,
        analysisMode: store.analysisMode,
        detectionState,
        prefsError,
        detectionError,
        detectionStale:
            detectionTransport.status === DETECTION_TRANSPORT_STATUS.Stale,
        providerId: store.providerId,
        providerDisplayName: store.providerDisplayName,
        modelDisplayName: store.modelDisplayName,
        chromeModelAvailability: store.chromeModelAvailability,
        debugLoggingEnabled: isDetectionTransportKnown(detectionTransport)
            ? debugLoggingEnabled
            : null,
    });

    const detectedBlocks =
        detectionState?.status === PROMO_DETECTION_STATUS.Detected &&
        detectionState.promoBlocks !== undefined
            ? detectionState.promoBlocks
            : [];
    const hasDetectedBlocks = detectedBlocks.length > 0;
    const blocksStatusHeading =
        detectionState === null
            ? view.title
            : detectionLabel(detectionState.status);
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

                <DebugLoggingIndicator label={view.debugLoggingLabel} />

                <Group
                    gap="sm"
                    wrap="nowrap"
                    align="flex-start"
                    px="md"
                    py={14}
                    style={{ background: toneStyle.surface }}
                >
                    {detectionLoaded ? (
                        <>
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
                                    <CheckIcon
                                        size={12}
                                        color={toneStyle.iconText}
                                    />
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
                        </>
                    ) : (
                        <Stack
                            data-testid="popup-detection-loading"
                            aria-busy="true"
                            gap={7}
                            style={{ flex: 1 }}
                        >
                            <Skeleton height={14} width="55%" radius="xl" />
                            <Skeleton height={10} width="90%" radius="xl" />
                            <Skeleton height={10} width="70%" radius="xl" />
                        </Stack>
                    )}
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
                {!detectionLoaded ? (
                    <Stack
                        data-testid="popup-blocks-loading"
                        role="status"
                        aria-busy="true"
                        gap={8}
                    >
                        <Skeleton height={14} width="60%" radius="xl" />
                        <Skeleton height={10} width="85%" radius="xl" />
                    </Stack>
                ) : (
                    <div role="status" aria-live="polite">
                        <Group justify="space-between" wrap="nowrap" gap="sm">
                            <Stack gap={2} style={{ minWidth: 0 }}>
                                <Group gap="xs" wrap="nowrap">
                                    <PromoBlocksIcon
                                        size={16}
                                        color="#475569"
                                    />
                                    <Text fw={700} size="sm">
                                        {hasDetectedBlocks
                                            ? translator.getMessage(
                                                    'popup_detection_detected',
                                                )
                                            : blocksStatusHeading}
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
                                {hasDetectedBlocks
                                    ? `${detectedBlocks.length} ${
                                        detectedBlocks.length === 1
                                            ? 'block'
                                            : 'blocks'
                                    }`
                                    : view.badgeLabel}
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
                        {view.reportAction !== undefined &&
                        view.reportLabel !== undefined ? (
                                    <Button
                                        data-testid="popup-report-server-issue"
                                        mt="sm"
                                        size="xs"
                                        variant={
                                            view.reportAction ===
                                    SERVER_FAILURE_REPORT_ACTION.Primary
                                                ? 'filled'
                                                : 'subtle'
                                        }
                                        onClick={() => {
                                            void browser.runtime.sendMessage({
                                                type: TOPSKIP_MESSAGE.OPEN_SERVER_ANALYSIS_ISSUE,
                                            });
                                        }}
                                    >
                                        {view.reportLabel}
                                    </Button>
                                ) : null}
                    </div>
                )}
                <PromoTimeline
                    blocks={detectedBlocks}
                    durationSec={detectionState?.durationSec}
                />
                {hasDetectedBlocks ? (
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
