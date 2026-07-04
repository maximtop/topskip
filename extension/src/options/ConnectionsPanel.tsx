import {
    Badge,
    Button,
    Group,
    PasswordInput,
    Paper,
    Stack,
    Text,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import type {
    ConnectionEntryMessage,
    ConnectionProviderId,
} from '@/shared/messages';
import { CONNECTION_STATUS } from '@/shared/messages';
import { translator } from '@/shared/i18n/translator';

/**
 * Last visible validation state for a cloud provider key test.
 */
export type ConnectionTestState =
    | { kind: 'idle' }
    | { kind: 'valid' }
    | { kind: 'invalid'; error: string }
    | { kind: 'error'; error: string };

/**
 * Connection rows, draft keys, and actions for the API key section.
 */
type ConnectionsPanelProps = {
    connections: ConnectionEntryMessage[];
    drafts: Record<ConnectionProviderId, string>;
    busyProviderId: ConnectionProviderId | null;
    testStates: Partial<Record<ConnectionProviderId, ConnectionTestState>>;
    onDraftChange(providerId: ConnectionProviderId, value: string): void;
    onSave(providerId: ConnectionProviderId): void;
    onTest(providerId: ConnectionProviderId): void;
};

/**
 * Dedicated provider API-key section, separate from model selection.
 *
 * @param props - Connection rows and key actions.
 * @returns Connections management panel.
 */
export function ConnectionsPanel(props: ConnectionsPanelProps): ReactElement {
    return (
        <Paper p="md" radius="md" withBorder>
            <Stack gap="md">
                <Stack gap={4}>
                    <Title order={2} size="h4">
                        {translator.getMessage('options_connections_heading')}
                    </Title>
                    <Text size="sm" c="dimmed">
                        {translator.getMessage(
                            'options_connections_description',
                        )}
                    </Text>
                </Stack>
                {props.connections.map((connection) => {
                    const testState = props.testStates[connection.providerId];
                    const busy = props.busyProviderId === connection.providerId;
                    return (
                        <Paper
                            key={connection.providerId}
                            p="sm"
                            radius="sm"
                            withBorder
                        >
                            <Stack gap="sm">
                                <Group justify="space-between" gap="sm">
                                    <Group gap="xs">
                                        <Text fw={700}>
                                            {connection.providerLabel}
                                        </Text>
                                        {connection.requiredForActiveModel ? (
                                            <Badge
                                                color="yellow"
                                                variant="light"
                                            >
                                                {translator.getMessage(
                                                    'options_connection_required_badge',
                                                )}
                                            </Badge>
                                        ) : null}
                                    </Group>
                                    <Badge
                                        color={
                                            connection.status ===
                                            CONNECTION_STATUS.Saved
                                                ? 'green'
                                                : 'gray'
                                        }
                                        variant="light"
                                    >
                                        {connection.status ===
                                        CONNECTION_STATUS.Saved
                                            ? translator.getMessage(
                                                  'options_connection_key_saved',
                                              )
                                            : translator.getMessage(
                                                  'options_connection_key_missing',
                                              )}
                                    </Badge>
                                </Group>
                                <Group align="flex-end" wrap="nowrap" gap="sm">
                                    <PasswordInput
                                        style={{ flex: 1 }}
                                        label={`${connection.providerLabel} API key`}
                                        placeholder={
                                            connection.apiKeyMasked ??
                                            translator.getMessage(
                                                'options_connection_key_placeholder',
                                            )
                                        }
                                        value={
                                            props.drafts[connection.providerId]
                                        }
                                        onChange={(event) => {
                                            props.onDraftChange(
                                                connection.providerId,
                                                event.currentTarget.value,
                                            );
                                        }}
                                    />
                                    <Button
                                        loading={busy}
                                        onClick={() => {
                                            props.onSave(connection.providerId);
                                        }}
                                    >
                                        {translator.getMessage(
                                            'options_save_button',
                                        )}
                                    </Button>
                                    <Button
                                        variant="light"
                                        loading={busy}
                                        onClick={() => {
                                            props.onTest(connection.providerId);
                                        }}
                                    >
                                        {translator.getMessage(
                                            'options_connection_test_button',
                                        )}
                                    </Button>
                                </Group>
                                {testState?.kind === 'valid' ? (
                                    <Text size="xs" c="green">
                                        {translator.getMessage(
                                            'options_connection_key_valid',
                                        )}
                                    </Text>
                                ) : null}
                                {testState?.kind === 'invalid' ||
                                testState?.kind === 'error' ? (
                                    <Text size="xs" c="red">
                                        {testState.error}
                                    </Text>
                                ) : null}
                            </Stack>
                        </Paper>
                    );
                })}
            </Stack>
        </Paper>
    );
}
