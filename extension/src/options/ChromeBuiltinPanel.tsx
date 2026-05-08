import type { ReactElement } from 'react';

import { ChromeBuiltinOnboarding } from '@/options/ChromeBuiltinOnboarding';
import type { ProviderAvailabilityMessage } from '@/shared/messages';

type ChromeBuiltinPanelProps = {
    availability: ProviderAvailabilityMessage;
    downloadProgress: number | null;
    onDownload: () => void;
};

/**
 * Chrome Built-in provider panel for the options page.
 * Delegates to the multi-state onboarding widget.
 *
 * @param props - Availability, download progress, and download trigger
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
