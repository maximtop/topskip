import React from 'react';
import { translate, type I18nInterface } from '@adguard/translate';

import { i18n } from '@/shared/i18n/i18n';

/**
 * React-aware translator: resolves message keys to React nodes with
 * tag substitution (e.g. `<b>`, `<a>`).
 * Used in popup and options page components.
 */
export const reactTranslator = translate.createReactTranslator(
  i18n as I18nInterface,
  React,
);
