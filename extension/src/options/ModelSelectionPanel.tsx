import {
    Alert,
    Badge,
    Button,
    Group,
    Paper,
    Select,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import type {
    ConnectionProviderId,
    DetectionModelMessage,
} from '@/shared/messages';

/**
 * Model selector state and callbacks supplied by the options container.
 */
type ModelSelectionPanelProps = {
    activeModelId: string;
    models: DetectionModelMessage[];
    missingConnectionProviderId: ConnectionProviderId | null;
    onModelChange(modelId: string): void;
    onOpenConnection(providerId: ConnectionProviderId): void;
};

/**
 * Primary model-first detection selector for the options page.
 *
 * @param props - Available models and active model callbacks.
 * @returns Model selection panel.
 */
export function ModelSelectionPanel(
    props: ModelSelectionPanelProps,
): ReactElement {
    const activeModel = props.models.find(
        (model) => model.id === props.activeModelId,
    );
    const missingProvider = props.missingConnectionProviderId;

    return (
        <Paper p="md" radius="md" withBorder>
            <Stack gap="md">
                <Stack gap={4}>
                    <Title order={2} size="h4">
                        Detection model
                    </Title>
                    <Text size="sm" c="dimmed">
                        Choose the model TopSkip uses to detect promo segments.
                    </Text>
                </Stack>
                <Select
                    label="Model"
                    data={props.models.map((model) => ({
                        value: model.id,
                        label: `${model.label} · ${model.providerLabel}`,
                    }))}
                    value={props.activeModelId}
                    onChange={(value) => {
                        if (value !== null) {
                            props.onModelChange(value);
                        }
                    }}
                />
                {activeModel ? (
                    <Group gap="xs">
                        <Badge variant="light">
                            {activeModel.providerLabel}
                        </Badge>
                        <Text size="sm" c="dimmed">
                            {activeModel.requiresConnection
                                ? 'Uses a saved API key from Connections.'
                                : 'No external API key required.'}
                        </Text>
                    </Group>
                ) : null}
                {missingProvider ? (
                    <Alert color="yellow" title="Connection required">
                        <Group justify="space-between" gap="sm">
                            <Text size="sm">
                                Selected model needs an API key before detection
                                can run.
                            </Text>
                            <Button
                                size="xs"
                                variant="light"
                                onClick={() => {
                                    props.onOpenConnection(missingProvider);
                                }}
                            >
                                Open connection
                            </Button>
                        </Group>
                    </Alert>
                ) : null}
            </Stack>
        </Paper>
    );
}
