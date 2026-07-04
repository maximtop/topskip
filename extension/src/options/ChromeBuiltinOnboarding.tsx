import {
    Badge,
    Button,
    Paper,
    Progress,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import type { ProviderAvailabilityMessage } from '@/shared/messages';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';

/**
 * Prompt API onboarding state and download action passed from options.
 */
type ChromeBuiltinOnboardingProps = {
    availability: ProviderAvailabilityMessage;
    downloadProgress: number | null;
    onDownload: () => void;
};

/**
 * Multi-state onboarding widget for the Chrome Built-in AI provider.
 * Renders a different card depending on the model lifecycle state:
 * unavailable → downloadable → downloading → available.
 *
 * @param props - Current availability, download progress, and callback
 * @returns Onboarding UI for Chrome Built-in
 */
export function ChromeBuiltinOnboarding(
    props: ChromeBuiltinOnboardingProps,
): ReactElement {
    const { availability, downloadProgress, onDownload } = props;

    if (availability === PROVIDER_AVAILABILITY.UNAVAILABLE) {
        return (
            <Paper p="lg" radius="xl" style={{ opacity: 0.6 }}>
                <Stack gap="sm">
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Chrome Built-in
                    </Text>
                    <Title order={3} size="h3">
                        Chrome Built-in AI is not available on this device
                    </Title>
                    <Text size="sm" c="dimmed">
                        Requires Chrome 138+, 22 GB free storage, 4 GB+ VRAM or
                        16 GB RAM.
                    </Text>
                </Stack>
            </Paper>
        );
    }

    if (availability === PROVIDER_AVAILABILITY.DOWNLOADABLE) {
        return (
            <Paper p="lg" radius="xl">
                <Stack gap="sm">
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Chrome Built-in
                    </Text>
                    <Title order={3} size="h3">
                        Gemini Nano
                    </Title>
                    <Text size="sm" c="dimmed">
                        Approximate download size: ~2 GB. The model runs
                        entirely on your device — no data leaves your computer.
                    </Text>
                    <Button onClick={onDownload}>Download model</Button>
                </Stack>
            </Paper>
        );
    }

    if (availability === PROVIDER_AVAILABILITY.DOWNLOADING) {
        const hasProgress = downloadProgress !== null && downloadProgress >= 0;
        return (
            <Paper p="lg" radius="xl">
                <Stack gap="sm">
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Chrome Built-in
                    </Text>
                    {hasProgress ? (
                        <>
                            <Title order={3} size="h3">
                                Downloading Gemini Nano… {downloadProgress}%
                            </Title>
                            <Progress
                                value={downloadProgress ?? 0}
                                size="lg"
                                radius="xl"
                            />
                        </>
                    ) : (
                        <>
                            <Title order={3} size="h3">
                                Download interrupted
                            </Title>
                            <Text size="sm" c="dimmed">
                                The download was interrupted. Click below to
                                retry.
                            </Text>
                            <Button onClick={onDownload}>Retry</Button>
                        </>
                    )}
                </Stack>
            </Paper>
        );
    }

    // availability === PROVIDER_AVAILABILITY.AVAILABLE
    return (
        <Paper p="lg" radius="xl">
            <Stack gap="sm">
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                    Chrome Built-in
                </Text>
                <Title order={3} size="h3">
                    Gemini Nano is ready to use
                </Title>
                <Badge color="green" variant="filled" size="lg">
                    Ready
                </Badge>
            </Stack>
        </Paper>
    );
}
