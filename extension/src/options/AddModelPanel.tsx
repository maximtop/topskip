import {
    Badge,
    Button,
    Group,
    Paper,
    Stack,
    Text,
    TextInput,
    Title,
} from '@mantine/core';
import type { ReactElement } from 'react';

import { translator } from '@/shared/i18n/translator';
import { PROVIDER_LABEL } from '@/shared/providers';

/**
 * State and callbacks for the custom model add/remove form.
 */
type AddModelPanelProps = {
    customModels: string[];
    newModelDraft: string;
    addBusy: boolean;
    removeBusySlug: string | null;
    onNewModelDraftChange(value: string): void;
    onAddCustomModel(): void;
    onRemoveCustomModel(slug: string): void;
};

/**
 * OpenRouter custom models remain an add-model flow, not provider selection.
 *
 * @param props - Custom model list and actions.
 * @returns Add model panel.
 */
export function AddModelPanel(props: AddModelPanelProps): ReactElement {
    return (
        <Paper p="md" radius="md" withBorder>
            <Stack gap="md">
                <Stack gap={4}>
                    <Title order={2} size="h4">
                        {translator.getMessage('options_add_model_heading')}
                    </Title>
                    <Text size="sm" c="dimmed">
                        {translator.getMessage('options_add_model_description')}
                    </Text>
                </Stack>
                <Group align="flex-end" wrap="nowrap" gap="sm">
                    <TextInput
                        style={{ flex: 1 }}
                        label={translator.getMessage(
                            'options_custom_model_label',
                        )}
                        placeholder={translator.getMessage(
                            'options_custom_model_placeholder',
                        )}
                        value={props.newModelDraft}
                        onChange={(event) => {
                            props.onNewModelDraftChange(
                                event.currentTarget.value,
                            );
                        }}
                    />
                    <Button
                        loading={props.addBusy}
                        onClick={() => {
                            props.onAddCustomModel();
                        }}
                    >
                        {translator.getMessage('options_add_button')}
                    </Button>
                </Group>
                <Stack gap="xs">
                    {props.customModels.length === 0 ? (
                        <Text size="sm" c="dimmed">
                            {translator.getMessage('options_no_custom_models')}
                        </Text>
                    ) : null}
                    {props.customModels.map((slug) => (
                        <Group key={slug} justify="space-between" gap="sm">
                            <Group gap="xs">
                                <Text size="sm">{slug}</Text>
                                <Badge variant="light">
                                    {PROVIDER_LABEL.OpenRouter}
                                </Badge>
                            </Group>
                            <Button
                                size="xs"
                                variant="subtle"
                                color="red"
                                loading={props.removeBusySlug === slug}
                                onClick={() => {
                                    props.onRemoveCustomModel(slug);
                                }}
                            >
                                {translator.getMessage('options_remove_button')}
                            </Button>
                        </Group>
                    ))}
                </Stack>
            </Stack>
        </Paper>
    );
}
