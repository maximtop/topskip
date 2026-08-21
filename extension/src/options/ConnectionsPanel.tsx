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
import {
    PROVIDER_HOST_ACCESS_STATUS,
    PROVIDER_HOST_PERMISSION,
} from '@/shared/provider-host-permissions';

/**
 * Last visible validation state for a cloud provider key test.
 */
export type ConnectionTestState =
    | { kind: 'idle' }
    | { kind: 'valid' }
    | { kind: 'invalid' }
    | { kind: 'key_required' }
    | { kind: 'access_denied' }
    | { kind: 'access_request_failed' }
    | { kind: 'host_access_required' }
    | { kind: 'error' };

/**
 * Safe state-to-copy mapping prevents runtime and provider error text from
 * entering the rendered options page.
 *
 * @param state - Last classified test or access outcome.
 * @returns Localized feedback, or `null` while idle.
 */
function getConnectionFeedback(
    state: ConnectionTestState | undefined,
): { message: string; color: string } | null {
    switch (state?.kind) {
        case 'valid':
            return {
                message: translator.getMessage(
                    'options_connection_key_valid',
                ),
                color: 'green',
            };
        case 'key_required':
            return {
                message: translator.getMessage(
                    'options_connection_key_missing',
                ),
                color: 'red',
            };
        case 'access_denied':
            return {
                message: translator.getMessage(
                    'options_connection_host_access_denied',
                ),
                color: 'red',
            };
        case 'access_request_failed':
            return {
                message: translator.getMessage(
                    'options_connection_host_access_request_failed',
                ),
                color: 'red',
            };
        case 'host_access_required':
            return {
                message: translator.getMessage(
                    'options_connection_host_access_required_for_test',
                ),
                color: 'red',
            };
        case 'invalid':
        case 'error':
            return {
                message: translator.getMessage(
                    'options_connection_test_failed',
                ),
                color: 'red',
            };
        case 'idle':
        case undefined:
            return null;
    }
}

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
    onGrantHostAccess(providerId: ConnectionProviderId): void;
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
                    const testFeedback = getConnectionFeedback(testState);
                    const busy = props.busyProviderId === connection.providerId;
                    const hostPermission =
                        PROVIDER_HOST_PERMISSION[connection.providerId];
                    const hasHostAccess =
                        connection.hostAccessStatus ===
                        PROVIDER_HOST_ACCESS_STATUS.Granted;
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
                                <Group justify="space-between" gap="sm">
                                    <Stack gap={2}>
                                        <Badge
                                            color={hasHostAccess ? 'green' : 'gray'}
                                            variant="light"
                                        >
                                            {hasHostAccess
                                                ? translator.getMessage(
                                                        'options_connection_host_access_granted_badge',
                                                    )
                                                : translator.getMessage(
                                                        'options_connection_host_access_required_badge',
                                                    )}
                                        </Badge>
                                        <Text size="xs" c="dimmed">
                                            {translator.getMessage(
                                                'options_connection_host_access_description',
                                                {
                                                    provider:
                                                        connection.providerLabel,
                                                    host: hostPermission.hostLabel,
                                                },
                                            )}
                                        </Text>
                                    </Stack>
                                    {!hasHostAccess ? (
                                        <Button
                                            variant="light"
                                            onClick={() => {
                                                props.onGrantHostAccess(
                                                    connection.providerId,
                                                );
                                            }}
                                        >
                                            {translator.getMessage(
                                                'options_connection_host_access_allow_button',
                                            )}
                                        </Button>
                                    ) : null}
                                </Group>
                                {testFeedback === null ? null : (
                                    <Text size="xs" c={testFeedback.color}>
                                        {testFeedback.message}
                                    </Text>
                                )}
                            </Stack>
                        </Paper>
                    );
                })}
            </Stack>
        </Paper>
    );
}
