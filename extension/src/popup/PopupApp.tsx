import { observer } from 'mobx-react-lite';
import { useEffect, useMemo } from 'react';
import { Alert, Group, Stack, Switch, Text } from '@mantine/core';

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
      <Alert color="yellow" title="Reliability notice" variant="light">
        <Text size="xs">
          TopSkip may rely on parts of YouTube’s site that are not a documented
          public API—the same general area the YouTube web client uses. There is
          no guarantee that auto-skip will keep working if YouTube changes how
          the page behaves.
        </Text>
        <Text size="xs" mt="xs">
          If it stops working, please report it where you installed this
          extension (for example the Chrome Web Store support options, if you
          installed it from there).
        </Text>
      </Alert>
    </Stack>
  );
});
