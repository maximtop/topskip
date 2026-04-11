import { observer } from 'mobx-react-lite';
import { useEffect, useMemo } from 'react';
import { Group, Stack, Switch, Text } from '@mantine/core';

import { PreferencesStore } from '@/popup/preferences-store';

export const PopupApp = observer(function PopupApp() {
  const store = useMemo(() => new PreferencesStore(), []);

  useEffect(() => {
    void store.load();
  }, [store]);

  return (
    <Stack gap="sm" p="md" maw={320}>
      <Text fw={600} size="sm">
        TopSkip
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">Skip 30s–1min on YouTube</Text>
        <Switch
          checked={store.enabled}
          onChange={(e) => {
            void store.setEnabled(e.currentTarget.checked);
          }}
          aria-label="Enable auto-skip"
        />
      </Group>
    </Stack>
  );
});
