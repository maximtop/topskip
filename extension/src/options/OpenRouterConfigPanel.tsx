import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Group,
    Paper,
    Select,
    Stack,
    Text,
    TextInput,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

type OpenRouterSelectOption = {
    value: string;
    label: string;
};

type OpenRouterConfigPanelProps = {
    apiKey: string;
    apiKeyVisible: boolean;
    savedApiKeyMasked: string | null;
    modelChoice: string;
    modelSelectData: OpenRouterSelectOption[];
    customModels: string[];
    newModelDraft: string;
    addBusy: boolean;
    removeBusySlug: string | null;
    validationError: string | null;
    unverifiedModels: Set<string>;
    onApiKeyChange(value: string): void;
    onToggleApiKeyVisibility(): void;
    onModelChoiceChange(value: string | null): void;
    onNewModelDraftChange(value: string): void;
    onAddCustomModel(): void;
    onRemoveCustomModel(slug: string): void;
};

/**
 * Provider-specific OpenRouter configuration controls extracted from the
 * options page container.
 *
 * @param props - Current OpenRouter form state and callbacks
 * @returns OpenRouter provider panel
 */
export function OpenRouterConfigPanel(
    props: OpenRouterConfigPanelProps,
): ReactElement {
    return (
        <Stack gap="lg">
            <Paper p="lg" radius="xl">
                <Stack gap="md">
                    <Stack gap={4}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                            OpenRouter model
                        </Text>
                        <Title order={3} size="h3">
                            Model selection
                        </Title>
                        <Text size="sm" c="dimmed">
                            Choose the default cloud model used when OpenRouter
                            is the active provider.
                        </Text>
                    </Stack>
                    <Select
                        label="Model"
                        description={
                            'Pick the model TopSkip should use for transcript analysis.'
                        }
                        data={props.modelSelectData}
                        value={props.modelChoice}
                        onChange={(value) => {
                            props.onModelChoiceChange(value);
                        }}
                    />
                </Stack>
            </Paper>

            <Paper p="lg" radius="xl">
                <Stack gap="md">
                    <Stack gap={4}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                            Secure connection
                        </Text>
                        <Title order={3} size="h3">
                            OpenRouter API key
                        </Title>
                    </Stack>
                    <TextInput
                        label="API key"
                        placeholder="sk-or-v1-..."
                        type={props.apiKeyVisible ? 'text' : 'password'}
                        autoComplete="off"
                        value={props.apiKey}
                        onChange={(event) => {
                            props.onApiKeyChange(event.currentTarget.value);
                        }}
                        description={
                            props.savedApiKeyMasked !== null
                                ? `Saved key: ${props.savedApiKeyMasked}`
                                : 'No API key saved yet.'
                        }
                        rightSection={
                            <ActionIcon
                                variant="subtle"
                                aria-label={
                                    props.apiKeyVisible
                                        ? 'Hide API key'
                                        : 'Show API key'
                                }
                                onClick={() => {
                                    props.onToggleApiKeyVisibility();
                                }}
                            >
                                {props.apiKeyVisible ? (
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path
                                            d={
                                                'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-' +
                                                '11-8a18.45 18.45 0 0 1 5.06-5.94'
                                            }
                                        />
                                        <path
                                            d={
                                                'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18' +
                                                '.5 18.5 0 0 1-2.16 3.19'
                                            }
                                        />
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                    </svg>
                                ) : (
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                        <circle cx="12" cy="12" r="3" />
                                    </svg>
                                )}
                            </ActionIcon>
                        }
                    />
                </Stack>
            </Paper>

            <Paper p="lg" radius="xl">
                <Stack gap="md">
                    <Stack gap={4}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                            Add model
                        </Text>
                        <Title order={3} size="h3">
                            Custom models
                        </Title>
                        <Text size="sm" c="dimmed">
                            Save additional OpenRouter model slugs if you want
                            quick access to providers outside the built-in
                            preset list.
                        </Text>
                    </Stack>
                    {props.validationError ? (
                        <Alert color="red" title="Validation error">
                            {props.validationError}
                        </Alert>
                    ) : null}
                    <Group align="flex-end" wrap="nowrap" gap="sm">
                        <TextInput
                            style={{ flex: 1 }}
                            label="Custom model slug"
                            placeholder="owner/model-name"
                            value={props.newModelDraft}
                            onChange={(event) => {
                                props.onNewModelDraftChange(
                                    event.currentTarget.value,
                                );
                            }}
                        />
                        <Button
                            loading={props.addBusy}
                            disabled={props.newModelDraft.trim().length === 0}
                            onClick={() => {
                                props.onAddCustomModel();
                            }}
                        >
                            Add
                        </Button>
                    </Group>
                    {props.customModels.length > 0 ? (
                        <Stack gap="xs">
                            {props.customModels.map((slug) => (
                                <Paper
                                    key={slug}
                                    p="sm"
                                    radius="lg"
                                    style={{ background: '#fbfdff' }}
                                >
                                    <Group
                                        justify="space-between"
                                        wrap="nowrap"
                                        gap="md"
                                    >
                                        <Stack gap={1} style={{ flex: 1 }}>
                                            <Group gap={6}>
                                                <Text
                                                    size="xs"
                                                    c="dimmed"
                                                    tt="uppercase"
                                                    fw={700}
                                                >
                                                    Saved model
                                                </Text>
                                                {props.unverifiedModels.has(
                                                    slug,
                                                ) ? (
                                                    <Badge
                                                        size="xs"
                                                        color="yellow"
                                                        variant="light"
                                                    >
                                                        Unverified
                                                    </Badge>
                                                ) : null}
                                            </Group>
                                            <Text size="sm" ff="monospace">
                                                {slug}
                                            </Text>
                                        </Stack>
                                        <Button
                                            size="xs"
                                            variant="light"
                                            color="error"
                                            loading={
                                                props.removeBusySlug === slug
                                            }
                                            disabled={
                                                props.removeBusySlug !== null &&
                                                props.removeBusySlug !== slug
                                            }
                                            onClick={() => {
                                                props.onRemoveCustomModel(slug);
                                            }}
                                        >
                                            Remove
                                        </Button>
                                    </Group>
                                </Paper>
                            ))}
                        </Stack>
                    ) : (
                        <Text size="sm" c="dimmed">
                            No custom models saved yet.
                        </Text>
                    )}
                </Stack>
            </Paper>
        </Stack>
    );
}
