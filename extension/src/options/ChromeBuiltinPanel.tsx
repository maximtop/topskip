/**
 * @file Chrome Built-in provider panel: thin wrapper delegating to the
 * onboarding widget.
 */

import { ChromeBuiltinOnboarding } from '@/options/ChromeBuiltinOnboarding';

import type { ProviderAvailabilityMessage } from '@/shared/messages';
import type { ReactElement } from 'react';

/**
 * Chrome Prompt API readiness state and download action.
 */
interface ChromeBuiltinPanelProps {
    /**
     * Current Chrome Prompt API model availability.
     */
    availability: ProviderAvailabilityMessage;

    /**
     * Download progress percentage (0-100), or `null` when not downloading.
     */
    downloadProgress: number | null;

    /**
     * Starts the Chrome built-in model download.
     */
    onDownload: () => void;
}

/**
 * Chrome Built-in provider panel for the options page.
 * Delegates to the multi-state onboarding widget.
 *
 * @param props - Availability, download progress, and download trigger
 *
 * @returns Chrome Built-in provider panel
 */
export function ChromeBuiltinPanel(
    props: ChromeBuiltinPanelProps,
): ReactElement {
    return (
        <ChromeBuiltinOnboarding
            availability={props.availability}
            downloadProgress={props.downloadProgress}
            onDownload={props.onDownload}
        />
    );
}
