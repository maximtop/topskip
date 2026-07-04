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

import {
    CheckIcon,
    ExternalLinkIcon,
    InfoIcon,
    LockIcon,
    PencilIcon,
    TrashIcon,
    XIcon,
} from '@/shared/topskip-icons';

/**
 * Select option shape for built-in and custom OpenRouter models.
 */
type OpenRouterSelectOption = {
    value: string;
    label: string;
};

/**
 * OpenRouter form state and callbacks owned by the options container.
 */
type OpenRouterConfigPanelProps = {
    apiKey: string;
    apiKeyVisible: boolean;
    savedApiKeyMasked: string | null;
    modelChoice: string;
    modelSelectData: OpenRouterSelectOption[];
    customModels: string[];
    newModelDraft: string;
    addBusy: boolean;
    saveBusy: boolean;
    removeBusySlug: string | null;
    editingModelSlug: string | null;
    editingModelDraft: string;
    updateBusySlug: string | null;
    validationError: string | null;
    unverifiedModels: Set<string>;
    onApiKeyChange(value: string): void;
    onToggleApiKeyVisibility(): void;
    onModelChoiceChange(value: string | null): void;
    onNewModelDraftChange(value: string): void;
    onSave(): void;
    onAddCustomModel(): void;
    onEditCustomModel(slug: string): void;
    onEditCustomModelDraftChange(value: string): void;
    onSaveCustomModelEdit(slug: string): void;
    onCancelCustomModelEdit(): void;
    onRemoveCustomModel(slug: string): void;
};

const OPTIONS_PANEL_BLUE_SOFT = '#eff6ff';
const OPTIONS_PANEL_BORDER = '#dbe3ee';
const OPTIONS_PANEL_TEXT = '#0f172a';
const OPTIONS_PANEL_MUTED = '#64748b';

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
    const apiKeyPlaceholder =
        props.savedApiKeyMasked !== null
            ? '••••••••••••••••••••••••••••••••'
            : 'sk-or-v1-...';

    return (
        <Stack gap="lg">
            <Paper
                p="md"
                radius="md"
                style={{
                    background: OPTIONS_PANEL_BLUE_SOFT,
                    border: `1px solid ${OPTIONS_PANEL_BORDER}`,
                }}
            >
                <Stack gap="md">
                    <Group
                        justify="space-between"
                        align="center"
                        wrap="wrap"
                        gap="sm"
                    >
                        <Title order={3} size="h4" c={OPTIONS_PANEL_TEXT}>
                            OpenRouter BYOK settings
                        </Title>
                        {props.savedApiKeyMasked !== null ? (
                            <Badge
                                color="green"
                                variant="light"
                                leftSection={
                                    <CheckIcon size={12} color="currentColor" />
                                }
                                style={{ textTransform: 'none' }}
                            >
                                Key saved
                            </Badge>
                        ) : (
                            <Badge
                                color="yellow"
                                variant="light"
                                style={{ textTransform: 'none' }}
                            >
                                Key missing
                            </Badge>
                        )}
                    </Group>
                    <Stack gap={6}>
                        <Text size="sm" fw={700} c={OPTIONS_PANEL_TEXT}>
                            OpenRouter API key
                        </Text>
                        <Group align="flex-start" wrap="nowrap" gap="sm">
                            <TextInput
                                style={{ flex: 1 }}
                                aria-label="OpenRouter API key"
                                placeholder={apiKeyPlaceholder}
                                type={props.apiKeyVisible ? 'text' : 'password'}
                                autoComplete="off"
                                value={props.apiKey}
                                onChange={(event) => {
                                    props.onApiKeyChange(
                                        event.currentTarget.value,
                                    );
                                }}
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
                                                <line
                                                    x1="1"
                                                    y1="1"
                                                    x2="23"
                                                    y2="23"
                                                />
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
                            <Button
                                color="blue"
                                loading={props.saveBusy}
                                onClick={() => {
                                    props.onSave();
                                }}
                            >
                                Save key
                            </Button>
                        </Group>
                        <Group gap={4} wrap="nowrap" c={OPTIONS_PANEL_MUTED}>
                            <LockIcon size={12} color="currentColor" />
                            <Text size="xs" c="inherit">
                                Your key is stored locally and never shared.
                            </Text>
                        </Group>
                    </Stack>
                    <Select
                        label="Built-in model presets (choose a preset model)"
                        data={props.modelSelectData}
                        value={props.modelChoice}
                        onChange={(value) => {
                            props.onModelChoiceChange(value);
                        }}
                    />
                </Stack>
            </Paper>

            <Paper
                p="md"
                radius="md"
                style={{ border: `1px solid ${OPTIONS_PANEL_BORDER}` }}
            >
                <Stack gap="md">
                    <Stack gap={4}>
                        <Title order={3} size="h4" c={OPTIONS_PANEL_TEXT}>
                            2. Custom OpenRouter models
                        </Title>
                        <Text size="sm" c={OPTIONS_PANEL_MUTED}>
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
                            placeholder="Enter OpenRouter model slug (e.g., meta-llama/llama-3.1-8b-instruct)"
                            value={props.newModelDraft}
                            onChange={(event) => {
                                props.onNewModelDraftChange(
                                    event.currentTarget.value,
                                );
                            }}
                        />
                        <Button
                            color="blue"
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
                        <Paper
                            radius="md"
                            style={{
                                border: `1px solid ${OPTIONS_PANEL_BORDER}`,
                                overflow: 'hidden',
                            }}
                        >
                            {props.customModels.map((slug) => {
                                const editing = props.editingModelSlug === slug;
                                const busy =
                                    props.removeBusySlug === slug ||
                                    props.updateBusySlug === slug;
                                return (
                                    <Group
                                        key={slug}
                                        justify="space-between"
                                        wrap="nowrap"
                                        gap="md"
                                        align="center"
                                        px="sm"
                                        py="xs"
                                        style={{
                                            background: '#fbfdff',
                                            borderBottom: `1px solid ${OPTIONS_PANEL_BORDER}`,
                                        }}
                                    >
                                        {editing ? (
                                            <TextInput
                                                aria-label={`Edit ${slug}`}
                                                value={props.editingModelDraft}
                                                style={{ flex: 1 }}
                                                onChange={(event) => {
                                                    props.onEditCustomModelDraftChange(
                                                        event.currentTarget
                                                            .value,
                                                    );
                                                }}
                                            />
                                        ) : (
                                            <Group
                                                gap="xs"
                                                wrap="nowrap"
                                                style={{
                                                    flex: 1,
                                                    minWidth: 0,
                                                }}
                                            >
                                                <Text
                                                    size="sm"
                                                    ff="monospace"
                                                    style={{
                                                        overflowWrap:
                                                            'anywhere',
                                                    }}
                                                >
                                                    {slug}
                                                </Text>
                                                {props.unverifiedModels.has(
                                                    slug,
                                                ) ? (
                                                    <Badge
                                                        size="xs"
                                                        color="yellow"
                                                        variant="light"
                                                        style={{
                                                            textTransform:
                                                                'none',
                                                        }}
                                                    >
                                                        Unverified
                                                    </Badge>
                                                ) : null}
                                            </Group>
                                        )}
                                        {editing ? (
                                            <Group gap="xs" wrap="nowrap">
                                                <Button
                                                    size="xs"
                                                    variant="light"
                                                    color="green"
                                                    loading={
                                                        props.updateBusySlug ===
                                                        slug
                                                    }
                                                    leftSection={
                                                        <CheckIcon
                                                            size={14}
                                                            color="currentColor"
                                                        />
                                                    }
                                                    onClick={() => {
                                                        props.onSaveCustomModelEdit(
                                                            slug,
                                                        );
                                                    }}
                                                >
                                                    Save
                                                </Button>
                                                <Button
                                                    size="xs"
                                                    variant="light"
                                                    color="gray"
                                                    disabled={busy}
                                                    leftSection={
                                                        <XIcon
                                                            size={14}
                                                            color="currentColor"
                                                        />
                                                    }
                                                    onClick={() => {
                                                        props.onCancelCustomModelEdit();
                                                    }}
                                                >
                                                    Cancel
                                                </Button>
                                            </Group>
                                        ) : (
                                            <Group gap="xs" wrap="nowrap">
                                                <Button
                                                    size="xs"
                                                    variant="light"
                                                    color="blue"
                                                    disabled={busy}
                                                    leftSection={
                                                        <PencilIcon
                                                            size={14}
                                                            color="currentColor"
                                                        />
                                                    }
                                                    onClick={() => {
                                                        props.onEditCustomModel(
                                                            slug,
                                                        );
                                                    }}
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="xs"
                                                    variant="light"
                                                    color="red"
                                                    loading={
                                                        props.removeBusySlug ===
                                                        slug
                                                    }
                                                    disabled={
                                                        props.updateBusySlug !==
                                                            null ||
                                                        (props.removeBusySlug !==
                                                            null &&
                                                            props.removeBusySlug !==
                                                                slug)
                                                    }
                                                    leftSection={
                                                        <TrashIcon
                                                            size={14}
                                                            color="currentColor"
                                                        />
                                                    }
                                                    onClick={() => {
                                                        props.onRemoveCustomModel(
                                                            slug,
                                                        );
                                                    }}
                                                >
                                                    Delete
                                                </Button>
                                            </Group>
                                        )}
                                    </Group>
                                );
                            })}
                        </Paper>
                    ) : (
                        <Text size="sm" c="dimmed">
                            No custom models saved yet.
                        </Text>
                    )}
                    <Paper
                        p="xs"
                        radius="md"
                        style={{
                            background: '#f8fafc',
                            border: `1px solid ${OPTIONS_PANEL_BORDER}`,
                        }}
                    >
                        <Group gap="xs" wrap="wrap" c={OPTIONS_PANEL_MUTED}>
                            <InfoIcon size={14} color="currentColor" />
                            <Text
                                size="xs"
                                c="inherit"
                                style={{ flex: '1 1 18rem' }}
                            >
                                Custom models must be valid OpenRouter slugs.
                            </Text>
                            <Text
                                component="a"
                                href="https://openrouter.ai/docs"
                                target="_blank"
                                rel="noreferrer"
                                size="xs"
                                c="blue"
                                fw={600}
                            >
                                Learn more about OpenRouter
                            </Text>
                            <ExternalLinkIcon size={12} color="currentColor" />
                        </Group>
                    </Paper>
                </Stack>
            </Paper>
        </Stack>
    );
}
