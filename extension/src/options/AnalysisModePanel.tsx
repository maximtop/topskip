import { Paper, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import type { ReactElement } from 'react';

import { ANALYSIS_MODE, type AnalysisMode } from '@/shared/constants';
import { translator } from '@/shared/i18n/translator';

/**
 * Analysis mode selector state supplied by the options container.
 */
type AnalysisModePanelProps = {
    value: AnalysisMode;
    disabled: boolean;
    onChange(value: AnalysisMode): void;
};

/**
 * Makes the server route explicit and keeps privacy-sensitive BYOK intentional.
 *
 * @param props - Selected route, save state, and mutation callback.
 * @returns Localized analysis mode selector and route disclosure.
 */
export function AnalysisModePanel(props: AnalysisModePanelProps): ReactElement {
    const descriptionKey =
        props.value === ANALYSIS_MODE.Byok
            ? 'options_analysis_mode_byok_description'
            : 'options_analysis_mode_server_description';

    return (
        <Paper p="md" radius="md" withBorder>
            <Stack gap="sm">
                <Stack gap={4}>
                    <Title order={2} size="h4">
                        {translator.getMessage('options_analysis_mode_heading')}
                    </Title>
                    <Text size="sm" c="dimmed">
                        {translator.getMessage(descriptionKey)}
                    </Text>
                </Stack>
                <SegmentedControl
                    role="radiogroup"
                    aria-label={translator.getMessage(
                        'options_analysis_mode_heading',
                    )}
                    fullWidth
                    disabled={props.disabled}
                    value={props.value}
                    data={[
                        {
                            value: ANALYSIS_MODE.Server,
                            label: translator.getMessage(
                                'options_analysis_mode_server_label',
                            ),
                        },
                        {
                            value: ANALYSIS_MODE.Byok,
                            label: translator.getMessage(
                                'options_analysis_mode_byok_label',
                            ),
                        },
                    ]}
                    onChange={(value) => {
                        if (
                            value === ANALYSIS_MODE.Server ||
                            value === ANALYSIS_MODE.Byok
                        ) {
                            props.onChange(value);
                        }
                    }}
                />
                {props.value === ANALYSIS_MODE.Byok ? (
                    <Text size="xs" c="dimmed">
                        {translator.getMessage(
                            'options_analysis_mode_byok_privacy',
                        )}
                    </Text>
                ) : null}
            </Stack>
        </Paper>
    );
}
