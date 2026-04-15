import '@mantine/core/styles.css';

import { MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { i18n } from '@/shared/i18n/i18n';

import { PopupApp } from './PopupApp';

/**
 * Popup bundle bootstrap; not instantiable.
 */
export class Popup {
  private constructor() {}

  /**
   * Mounts the React app under `#root`.
   *
   * @returns Promise resolving after i18n init and render
   */
  static async init(): Promise<void> {
    await i18n.init();
    const rootEl = document.getElementById('root');
    if (!rootEl) {
      throw new Error('Missing #root');
    }

    createRoot(rootEl).render(
      <StrictMode>
        <MantineProvider defaultColorScheme="auto">
          <PopupApp />
        </MantineProvider>
      </StrictMode>,
    );
  }
}
