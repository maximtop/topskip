# Implementation Plan: Multi-Language Translation Support (20 Locales)

**Created**: 2026-04-15
**Status**: Validated
**Input**: Feature specification from `.sdd/.current/spec.md`
**Model**: claude-opus-4.6
**User Input**: "No RTL support needed yet"

## Summary

Add i18n infrastructure to the TopSkip Chrome extension following the AdGuard
VPN extension pattern. All ~40+ hardcoded English strings across popup, options,
content script, and manifest are extracted to `_locales/en/messages.json`, a
runtime `TranslationService` loads locale files with English fallback, and the
build pipeline copies `_locales/` into `dist/`. The `@adguard/translate`
library provides `translator` (plain string) and `reactTranslator` (JSX)
facades. 20 locales are supported with TwoSky-based CLI tooling for translation
management.

RTL layout support is explicitly out of scope per user input. Arabic (`ar`)
strings will render correctly in their native script, but no mirrored UI or
Mantine `direction="rtl"` changes are included.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM
**Primary Dependencies**: React 19, Mantine 9, MobX 6, webextension-polyfill,
Valibot, Rspack
**Storage**: `browser.storage.local` (background only)
**Testing**: Vitest 4.x (unit), Playwright (E2E)
**Target Platform**: Chrome MV3 extension
**Project Type**: Single-package
**Performance Goals**: N/A (UI strings only)
**Constraints**: No MobX in background/content bundles; no Mantine in content
bundle; `src/shared/` is pure (no I/O side effects)
**Scale/Scope**: ~40+ translatable strings, 20 locales

## Research

### `@adguard/translate` library API

The library exports `translate.createTranslator(i18nInterface)` and
`translate.createReactTranslator(i18nInterface, React)`. The `I18nInterface`
requires four methods: `getMessage(key)`, `getUILanguage()`,
`getBaseMessage(key)`, `getBaseUILanguage()`. All methods are synchronous.
Before `i18n.init()` completes, calls fall through to `browser.i18n.getMessage`
(native Chrome API reading `_locales/`).

The library handles plural forms via pipe-separated messages
(`"one | few | many"`) and `%placeholder%` substitution. Since TopSkip has no
plural strings currently, only `getMessage` is needed.

### Locale file loading in extensions

Chrome MV3 extensions can load `_locales/` files via
`browser.runtime.getURL('_locales/<lang>/messages.json')` + `fetch()`. The
files must be in `dist/_locales/` at runtime. Rspack's `CopyRspackPlugin`
(already used for `src/public/`) handles this.

### TopSkip architecture constraints

Per `AGENTS.md`, `src/shared/` is reserved for pure, deterministic modules.
The `TranslationService` performs `fetch()` (I/O), so it belongs under a
bundle-specific directory. However, `translator.ts` and `reactTranslator.ts`
are stateless factory calls. The `i18n` singleton holds state but is needed by
all bundles.

The VPN extension places all i18n code under `src/common/`. TopSkip has no
`src/common/` directory. Following the existing pattern where shared pure
helpers go in `src/shared/`, the i18n module will live in `src/shared/i18n/`
with a clear note that the `TranslationService` is an exception to the "no I/O
in shared" rule — it fetches locale files via `browser.runtime.getURL`, which
is an extension-internal operation (no network), analogous to how
`src/shared/browser.ts` re-exports the polyfill.

### Content script i18n

The content script (`youtube-watch.ts`) uses `browser.i18n.getMessage()` for
the toast. Since the content script bundle does not import React or Mantine,
it uses only `translator.getMessage()` (not `reactTranslator`). The
`TranslationService` must be initialized in the content script's startup path
(`Content.init()`).

## Entities

### Message

- **Fields**:
  - `key`: string — unique identifier (e.g., `popup_heading`)
  - `message`: string — translated text, may contain `%placeholder%` tokens
  - `description`: string (optional) — translator context note
- **Validation**: Keys must be non-empty, messages must be non-empty strings
- **Storage**: `src/_locales/<lang>/messages.json`

### Locale

- **Fields**:
  - `code`: string — BCP 47-derived code (e.g., `en`, `zh_CN`, `pt_BR`)
  - `name`: string — native language name (e.g., `日本語`)
- **Supported set**: `en`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `it`, `ja`,
  `ko`, `nl`, `pl`, `pt_BR`, `ru`, `th`, `tr`, `uk`, `vi`, `zh_CN`, `zh_TW`

## Contracts

N/A — no API endpoints required.

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/_locales/en/messages.json` | Create | Base English locale — all ~40+ message keys |
| `src/_locales/{18 other locales}/messages.json` | Create | Stub locale files (copy of English base initially) |
| `src/shared/i18n/i18n.ts` | Create | `I18n` singleton facade: `getMessage`, `getUILanguage`, `getBaseMessage`, `getBaseUILanguage`; `browser.i18n` fallback before init |
| `src/shared/i18n/translation-service.ts` | Create | Stateless: fetch + cache + lookup locale files via `browser.runtime.getURL` |
| `src/shared/i18n/locale-constants.ts` | Create | `AVAILABLE_LOCALES`, `BASE_LOCALE`, `LANGUAGE_NAMES`, `AvailableLocale` type |
| `src/shared/i18n/check-locale.ts` | Create | BCP 47 locale resolution (browser code → supported locale) |
| `src/shared/i18n/translator.ts` | Create | `translator` singleton via `translate.createTranslator(i18n)` |
| `src/shared/i18n/react-translator.ts` | Create | `reactTranslator` singleton via `translate.createReactTranslator(i18n, React)` |
| `src/manifest.json` | Modify | Add `default_locale`, use `__MSG_*__` for name/description/title |
| `rspack.config.ts` | Modify | Add `CopyRspackPlugin` pattern for `_locales/` |
| `src/popup/PopupApp.tsx` | Modify | Replace hardcoded strings with `reactTranslator.getMessage()` |
| `src/popup/popup.tsx` | Modify | Call `i18n.init()` before rendering |
| `src/options/options.tsx` | Modify | Replace hardcoded strings with `reactTranslator.getMessage()` / `translator.getMessage()`, call `i18n.init()` |
| `src/content/youtube-watch.ts` | Modify | Replace `'Skip applied'` with `translator.getMessage('content_skip_applied')` |
| `src/content/content.ts` | Modify | Call `i18n.init()` during startup |
| `src/background/background.ts` | Modify | Call `i18n.init()` during startup |
| `src/popup/preferences-store.ts` | Modify | Replace hardcoded error strings with `translator.getMessage()` |
| `.twosky.json` | Create | TwoSky project config (project_id, base_locale, languages) |
| `tasks/translations/config.json` | Create | Translation tooling config (API URL, paths, required locales) |
| `tasks/translations/index.js` | Create | CLI entry point for `pnpm locales` commands |
| `tasks/translations/download.js` | Create | Download translations from TwoSky |
| `tasks/translations/upload.js` | Create | Upload base locale to TwoSky |
| `tasks/translations/validate.js` | Create | Validate translation completeness |
| `tasks/translations/unused.js` | Create | Detect unused message keys |
| `tasks/translations/helpers.js` | Create | File I/O and logging utilities |
| `tasks/translations/locales-constants.js` | Create | Reads `.twosky.json`, exports constants |
| `package.json` | Modify | Add `@adguard/translate` dependency, `locales` script |
| `tests/shared/i18n/check-locale.test.ts` | Create | Unit tests for BCP 47 resolution |
| `tests/shared/i18n/translation-service.test.ts` | Create | Unit tests for message lookup and fallback |
| `tests/shared/i18n/i18n.test.ts` | Create | Unit tests for I18n facade |

## Tasks

### [ ] Task 1: Install `@adguard/translate` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run:

```bash
pnpm add @adguard/translate
```

- [ ] **Step 2: Verify installation**

Run: `pnpm ls @adguard/translate`
Expected: `@adguard/translate` appears in the dependency tree

**Verification**: `package.json` has `@adguard/translate` in `dependencies`;
`pnpm-lock.yaml` is updated; `pnpm run lint:types` still passes.

---

### [ ] Task 2: Create `.twosky.json` configuration

**Files:**
- Create: `.twosky.json`

- [ ] **Step 1: Create the TwoSky config file**

Create `.twosky.json` in the project root (`extension/`):

```json
[
    {
        "project_id": "topskip-extension",
        "base_locale": "en",
        "localizable_files": ["src/_locales/en/messages.json"],
        "languages": {
            "ar": "Arabic",
            "de": "German",
            "en": "English",
            "es": "Spanish",
            "fr": "French",
            "hi": "Hindi",
            "id": "Indonesian",
            "it": "Italian",
            "ja": "Japanese",
            "ko": "Korean",
            "nl": "Dutch",
            "pl": "Polish",
            "pt_BR": "Portuguese, Brazilian",
            "ru": "Russian",
            "th": "Thai",
            "tr": "Turkish",
            "uk": "Ukrainian",
            "vi": "Vietnamese",
            "zh_CN": "Chinese Simplified",
            "zh_TW": "Chinese Traditional"
        }
    }
]
```

- [ ] **Step 2: Enable JSON import in tsconfig**

Verify `tsconfig.json` already has `"resolveJsonModule": true` (it does at
line 16). No change needed.

**Verification**: File exists at `extension/.twosky.json` with 20 locales.

---

### [ ] Task 3: Create locale constants module

**Files:**
- Create: `src/shared/i18n/locale-constants.ts`
- Test: `tests/shared/i18n/locale-constants.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/i18n/locale-constants.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import {
  AVAILABLE_LOCALES,
  BASE_LOCALE,
  LANGUAGE_NAMES,
  type AvailableLocale,
} from '@/shared/i18n/locale-constants';

describe('locale-constants', () => {
  it('BASE_LOCALE is "en"', () => {
    expect(BASE_LOCALE).toBe('en');
  });

  it('AVAILABLE_LOCALES contains exactly 20 entries', () => {
    expect(AVAILABLE_LOCALES).toHaveLength(20);
  });

  it('AVAILABLE_LOCALES is sorted alphabetically', () => {
    const sorted = [...AVAILABLE_LOCALES].sort();
    expect(AVAILABLE_LOCALES).toEqual(sorted);
  });

  it('AVAILABLE_LOCALES includes expected locales', () => {
    const expected: AvailableLocale[] = [
      'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
      'nl', 'pl', 'pt_BR', 'ru', 'th', 'tr', 'uk', 'vi', 'zh_CN', 'zh_TW',
    ];
    for (const locale of expected) {
      expect(AVAILABLE_LOCALES).toContain(locale);
    }
  });

  it('LANGUAGE_NAMES has an entry for every available locale', () => {
    for (const locale of AVAILABLE_LOCALES) {
      expect(LANGUAGE_NAMES[locale]).toBeDefined();
      expect(typeof LANGUAGE_NAMES[locale]).toBe('string');
      expect(LANGUAGE_NAMES[locale].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/i18n/locale-constants.test.ts`
Expected: FAIL — module `@/shared/i18n/locale-constants` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/i18n/locale-constants.ts`:

```typescript
import twosky from '../../../.twosky.json';

/**
 * Locale code derived from the `.twosky.json` languages object.
 */
export type AvailableLocale = keyof (typeof twosky)[0]['languages'];

/**
 * Base locale used as fallback when translations are missing.
 */
export const BASE_LOCALE: AvailableLocale = 'en';

/**
 * All supported locale codes, derived from `.twosky.json` languages.
 * Sorted alphabetically.
 */
export const AVAILABLE_LOCALES: AvailableLocale[] = (
  Object.keys(twosky[0].languages) as AvailableLocale[]
).sort();

/**
 * Maps each supported locale code to its native language name.
 */
export const LANGUAGE_NAMES: Record<AvailableLocale, string> = {
  ar: 'العربية',
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  pt_BR: 'Português (Brasil)',
  ru: 'Русский',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  zh_CN: '简体中文',
  zh_TW: '繁體中文',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/i18n/locale-constants.test.ts`
Expected: PASS

**Verification**: All 5 assertions pass; `pnpm run lint:types` passes.

---

### [ ] Task 4: Create `checkLocale` — BCP 47 locale resolution

**Files:**
- Create: `src/shared/i18n/check-locale.ts`
- Test: `tests/shared/i18n/check-locale.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/i18n/check-locale.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { checkLocale } from '@/shared/i18n/check-locale';
import { AVAILABLE_LOCALES } from '@/shared/i18n/locale-constants';

describe('checkLocale', () => {
  it('exact match returns suitable', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'en');
    expect(r).toEqual({ suitable: true, locale: 'en' });
  });

  it('case-insensitive match: EN → en', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'EN');
    expect(r).toEqual({ suitable: true, locale: 'en' });
  });

  it('hyphen to underscore: zh-CN → zh_CN', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'zh-CN');
    expect(r).toEqual({ suitable: true, locale: 'zh_CN' });
  });

  it('BCP 47 three-part: zh-Hant-TW → zh_TW', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'zh-Hant-TW');
    expect(r).toEqual({ suitable: true, locale: 'zh_TW' });
  });

  it('BCP 47 three-part: zh-Hans-CN → zh_CN', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'zh-Hans-CN');
    expect(r).toEqual({ suitable: true, locale: 'zh_CN' });
  });

  it('base language match: en-GB → en', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'en-GB');
    expect(r).toEqual({ suitable: true, locale: 'en' });
  });

  it('pt-BR → pt_BR', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'pt-BR');
    expect(r).toEqual({ suitable: true, locale: 'pt_BR' });
  });

  it('unsupported locale returns not suitable', () => {
    const r = checkLocale(AVAILABLE_LOCALES, 'sw');
    expect(r).toEqual({ suitable: false, locale: 'sw' });
  });

  it('null input returns not suitable', () => {
    const r = checkLocale(AVAILABLE_LOCALES, null);
    expect(r).toEqual({ suitable: false, locale: '' });
  });

  it('empty string returns not suitable', () => {
    const r = checkLocale(AVAILABLE_LOCALES, '');
    expect(r).toEqual({ suitable: false, locale: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/i18n/check-locale.test.ts`
Expected: FAIL — module `@/shared/i18n/check-locale` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/i18n/check-locale.ts`:

```typescript
import type { AvailableLocale } from '@/shared/i18n/locale-constants';

/**
 * Result of matching a locale code against available locales.
 */
export type CheckLocaleResult =
  | { suitable: true; locale: AvailableLocale }
  | { suitable: false; locale: string };

/**
 * Matches a browser locale code to one of the supported locales.
 *
 * Resolution order:
 * 1. Normalize input (lowercase, hyphens → underscores)
 * 2. Exact match against available locales
 * 3. First+last segments for 3-part BCP 47 codes (e.g. zh-Hant-TW → zh_TW)
 * 4. Base language exact match (e.g. en-GB → en)
 * 5. Base language prefix match (e.g. zh → zh_CN)
 *
 * @param availableLocales - List of supported locale codes
 * @param locale - Browser locale code to resolve
 * @returns Result indicating whether a match was found
 */
export function checkLocale(
  availableLocales: readonly AvailableLocale[],
  locale: string | null,
): CheckLocaleResult {
  if (!locale) {
    return { suitable: false, locale: '' };
  }

  const normalized = locale.toLowerCase().replace(/-/g, '_');

  const lookupMap = new Map<string, AvailableLocale>();
  for (const available of availableLocales) {
    lookupMap.set(available.toLowerCase(), available);
  }

  const exactMatch = lookupMap.get(normalized);
  if (exactMatch) {
    return { suitable: true, locale: exactMatch };
  }

  const parts = normalized.split('_');

  if (parts.length >= 3) {
    const firstSecond = `${parts[0]}_${parts[1]}`;
    const firstSecondMatch = lookupMap.get(firstSecond);
    if (firstSecondMatch) {
      return { suitable: true, locale: firstSecondMatch };
    }

    const firstLast = `${parts[0]}_${parts[parts.length - 1]}`;
    const firstLastMatch = lookupMap.get(firstLast);
    if (firstLastMatch) {
      return { suitable: true, locale: firstLastMatch };
    }
  }

  const baseMatch = lookupMap.get(parts[0]);
  if (baseMatch) {
    return { suitable: true, locale: baseMatch };
  }

  const prefix = `${parts[0]}_`;
  const prefixMatch = availableLocales.find(
    (available) => available.toLowerCase().startsWith(prefix),
  );
  if (prefixMatch) {
    return { suitable: true, locale: prefixMatch };
  }

  return { suitable: false, locale: normalized };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/i18n/check-locale.test.ts`
Expected: PASS — all 10 assertions pass

**Verification**: `pnpm run lint:types` passes.

---

### [ ] Task 5: Create `TranslationService`

**Files:**
- Create: `src/shared/i18n/translation-service.ts`
- Test: `tests/shared/i18n/translation-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/i18n/translation-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/browser', () => ({
  default: {
    i18n: {
      getUILanguage: vi.fn(() => 'en'),
    },
    runtime: {
      getURL: vi.fn(
        (path: string) => `chrome-extension://fake-id/${path}`,
      ),
    },
  },
}));

const FAKE_EN_MESSAGES = {
  popup_heading: { message: 'TopSkip' },
  popup_enable: { message: 'Enable promo skip (YouTube)' },
};

const FAKE_FR_MESSAGES = {
  popup_heading: { message: 'TopSkip' },
  popup_enable: { message: 'Activer le saut de promo (YouTube)' },
};

global.fetch = vi.fn((url: string | URL | Request) => {
  const urlStr = typeof url === 'string' ? url : url.toString();
  if (urlStr.includes('/en/')) {
    return Promise.resolve({
      json: () => Promise.resolve(FAKE_EN_MESSAGES),
    } as Response);
  }
  if (urlStr.includes('/fr/')) {
    return Promise.resolve({
      json: () => Promise.resolve(FAKE_FR_MESSAGES),
    } as Response);
  }
  return Promise.reject(new Error(`unexpected fetch: ${urlStr}`));
}) as typeof fetch;

import { TranslationService } from '@/shared/i18n/translation-service';

describe('TranslationService', () => {
  let service: TranslationService;

  beforeEach(() => {
    service = new TranslationService();
    vi.clearAllMocks();
  });

  it('loadLocaleData loads en and returns resolved locale', async () => {
    const resolved = await service.loadLocaleData();
    expect(resolved).toBe('en');
  });

  it('getMessage returns base message for base locale', async () => {
    await service.loadLocaleData();
    const msg = service.getMessage('en', 'popup_heading');
    expect(msg).toBe('TopSkip');
  });

  it('getMessage returns translated message for non-base locale', async () => {
    await service.loadLocaleData('fr');
    const msg = service.getMessage('fr', 'popup_enable');
    expect(msg).toBe('Activer le saut de promo (YouTube)');
  });

  it('getMessage returns empty string for missing key in non-base locale', async () => {
    const fakeFrPartial = { popup_heading: { message: 'TopSkip' } };
    vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/en/')) {
        return Promise.resolve({
          json: () => Promise.resolve(FAKE_EN_MESSAGES),
        } as Response);
      }
      if (urlStr.includes('/fr/')) {
        return Promise.resolve({
          json: () => Promise.resolve(fakeFrPartial),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected: ${urlStr}`));
    });
    const svc = new TranslationService();
    await svc.loadLocaleData('fr');
    const msg = svc.getMessage('fr', 'popup_enable');
    expect(msg).toBe('');
  });

  it('getMessage throws for key not in base locale', async () => {
    await service.loadLocaleData();
    expect(() => service.getMessage('en', 'nonexistent_key')).toThrow(
      'There is no such key "nonexistent_key"',
    );
  });

  it('getBaseMessage returns English message', async () => {
    await service.loadLocaleData();
    expect(service.getBaseMessage('popup_heading')).toBe('TopSkip');
  });

  it('getBaseMessage returns empty string for unknown key', async () => {
    await service.loadLocaleData();
    expect(service.getBaseMessage('unknown')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/i18n/translation-service.test.ts`
Expected: FAIL — module `@/shared/i18n/translation-service` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/i18n/translation-service.ts`:

```typescript
import browser from '@/shared/browser';

import {
  type AvailableLocale,
  BASE_LOCALE,
  AVAILABLE_LOCALES,
} from '@/shared/i18n/locale-constants';
import { checkLocale } from '@/shared/i18n/check-locale';

/**
 * Individual message entry in a messages.json file.
 */
interface MessageEntry {
  /** Translated text. */
  message: string;
  /** Optional translator context note. */
  description?: string;
}

/**
 * Shape of a Chrome extension messages.json file.
 */
type MessagesJson = Record<string, MessageEntry>;

/**
 * Flattened format for runtime lookup: key → translated text.
 */
type FlattenedMessages = Record<string, string>;

/**
 * Stateless translation utility: loads locale files on demand, caches them,
 * and provides synchronous message lookup with English fallback.
 *
 * Contains no MobX dependencies and holds no locale state — callers pass
 * the active locale as a parameter to lookup methods.
 */
export class TranslationService {
  /**
   * In-memory cache of loaded and flattened locale data.
   */
  private localeCache = new Map<AvailableLocale, FlattenedMessages>();

  /**
   * Flattens raw MessagesJson into key → message map.
   *
   * @param rawMessages - Raw messages.json content
   * @returns Flattened key-value map
   */
  private flattenMessages(rawMessages: MessagesJson): FlattenedMessages {
    const result: FlattenedMessages = {};
    for (const [key, entry] of Object.entries(rawMessages)) {
      if (
        entry &&
        typeof entry.message === 'string' &&
        entry.message.length > 0
      ) {
        result[key] = entry.message;
      }
    }
    return result;
  }

  /**
   * Resolves a user preference into a supported locale code.
   *
   * @param localePreference - 'auto' or a locale code
   * @returns Resolved locale from AVAILABLE_LOCALES, or BASE_LOCALE
   */
  resolveLocale(localePreference: string): AvailableLocale {
    const code =
      localePreference === 'auto'
        ? browser.i18n.getUILanguage()
        : localePreference;

    const result = checkLocale(AVAILABLE_LOCALES, code);
    return result.suitable ? result.locale : BASE_LOCALE;
  }

  /**
   * Loads a locale file from extension assets, flattens, and caches it.
   *
   * @param locale - Locale code matching a folder in `_locales/`
   * @returns Promise that resolves when the locale is cached
   */
  async loadLocale(locale: AvailableLocale): Promise<void> {
    if (this.localeCache.has(locale)) {
      return;
    }
    const url = browser.runtime.getURL(
      `_locales/${locale}/messages.json`,
    );
    const response = await fetch(url);
    const raw: MessagesJson = (await response.json()) as MessagesJson;
    const flattened = this.flattenMessages(raw);
    this.localeCache.set(locale, flattened);
  }

  /**
   * Loads base English locale and the locale resolved from `preference`.
   *
   * @param preference - 'auto' or a locale code; defaults to 'auto'
   * @returns The resolved AvailableLocale that was loaded
   */
  async loadLocaleData(
    preference?: string,
  ): Promise<AvailableLocale> {
    const pref = preference ?? 'auto';
    await this.loadLocale(BASE_LOCALE);
    const resolved = this.resolveLocale(pref);
    if (resolved !== BASE_LOCALE) {
      await this.loadLocale(resolved);
    }
    return resolved;
  }

  /**
   * Returns the translated message for the given key in the specified locale.
   *
   * @param locale - The locale to look up the message in
   * @param key - Translation message key
   * @returns Translated message, or empty string if untranslated
   */
  getMessage(locale: AvailableLocale, key: string): string {
    const baseMessages = this.localeCache.get(BASE_LOCALE);
    const baseMessage = baseMessages?.[key];

    if (!baseMessage) {
      throw new Error(
        `There is no such key "${key}" in the messages`,
      );
    }

    if (locale === BASE_LOCALE) {
      return baseMessage;
    }

    const currentMessages = this.localeCache.get(locale);
    return currentMessages?.[key] ?? '';
  }

  /**
   * Returns the UI language code for `@adguard/translate`.
   *
   * @param locale - The locale code
   * @returns Lowercase locale code
   */
  getUILanguage(locale: AvailableLocale): string {
    return locale.toLowerCase();
  }

  /**
   * Returns the English base message for the given key.
   *
   * @param key - Translation message key
   * @returns English base message, or empty string if not found
   */
  getBaseMessage(key: string): string {
    const baseMessages = this.localeCache.get(BASE_LOCALE);
    return baseMessages?.[key] ?? '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/i18n/translation-service.test.ts`
Expected: PASS — all 7 assertions pass

**Verification**: `pnpm run lint:types` passes.

---

### [ ] Task 6: Create `I18n` facade singleton

**Files:**
- Create: `src/shared/i18n/i18n.ts`
- Test: `tests/shared/i18n/i18n.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/i18n/i18n.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/browser', () => ({
  default: {
    i18n: {
      getMessage: vi.fn((key: string) => `native:${key}`),
      getUILanguage: vi.fn(() => 'en-US'),
    },
    runtime: {
      getURL: vi.fn(
        (path: string) => `chrome-extension://fake-id/${path}`,
      ),
    },
  },
}));

const FAKE_EN = {
  popup_heading: { message: 'TopSkip' },
};

global.fetch = vi.fn(() =>
  Promise.resolve({
    json: () => Promise.resolve(FAKE_EN),
  } as Response),
) as typeof fetch;

import { I18n } from '@/shared/i18n/i18n';

describe('I18n', () => {
  let i18n: I18n;

  beforeEach(() => {
    i18n = new I18n();
    vi.clearAllMocks();
  });

  it('before init, getMessage falls back to browser.i18n', () => {
    const msg = i18n.getMessage('popup_heading');
    expect(msg).toBe('native:popup_heading');
  });

  it('before init, getUILanguage falls back to browser.i18n', () => {
    const lang = i18n.getUILanguage();
    expect(lang).toBe('en_us');
  });

  it('after init, getMessage returns loaded message', async () => {
    await i18n.init();
    const msg = i18n.getMessage('popup_heading');
    expect(msg).toBe('TopSkip');
  });

  it('after init, getUILanguage returns resolved locale', async () => {
    await i18n.init();
    const lang = i18n.getUILanguage();
    expect(lang).toBe('en');
  });

  it('getBaseMessage returns English message after init', async () => {
    await i18n.init();
    const msg = i18n.getBaseMessage('popup_heading');
    expect(msg).toBe('TopSkip');
  });

  it('getBaseUILanguage returns "en"', () => {
    expect(i18n.getBaseUILanguage()).toBe('en');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/i18n/i18n.test.ts`
Expected: FAIL — module `@/shared/i18n/i18n` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/i18n/i18n.ts`:

```typescript
import browser from '@/shared/browser';

import { TranslationService } from '@/shared/i18n/translation-service';
import {
  type AvailableLocale,
  BASE_LOCALE,
} from '@/shared/i18n/locale-constants';

/**
 * I18n facade with browser.i18n fallback before initialization.
 *
 * Each extension context (background, popup, options, content) creates its
 * own TranslationService instance. Before `init()` completes, all methods
 * fall back to `browser.i18n` (native Chrome API reading `_locales/`).
 */
export class I18n {
  /**
   * Per-context TranslationService instance.
   */
  private translationService = new TranslationService();

  /**
   * Whether `init()` has completed successfully.
   */
  private initialized = false;

  /**
   * Active locale (resolved from browser language).
   */
  private currentLocale: AvailableLocale = BASE_LOCALE;

  /**
   * Initializes the translation service with locale data.
   *
   * @returns Promise resolving when locale data is loaded
   */
  async init(): Promise<void> {
    try {
      this.currentLocale =
        await this.translationService.loadLocaleData();
    } catch {
      this.currentLocale = BASE_LOCALE;
    }
    this.initialized = true;
  }

  /**
   * Retrieves the localized message for the given key.
   *
   * Before `init()` completes, falls back to `browser.i18n.getMessage()`.
   *
   * @param key - Message key from messages.json
   * @returns Localized message string
   */
  getMessage(key: string): string {
    if (!this.initialized) {
      return browser.i18n.getMessage(key);
    }
    return this.translationService.getMessage(
      this.currentLocale,
      key,
    );
  }

  /**
   * Returns the UI language code for `@adguard/translate`.
   *
   * Before `init()` completes, falls back to `browser.i18n.getUILanguage()`.
   *
   * @returns Lowercase locale code (e.g. 'de', 'pt_br')
   */
  getUILanguage(): string {
    if (!this.initialized) {
      return browser.i18n
        .getUILanguage()
        .toLowerCase()
        .replace('-', '_');
    }
    return this.translationService.getUILanguage(
      this.currentLocale,
    );
  }

  /**
   * Returns the English base message for the given key.
   *
   * Before `init()` completes, falls back to `browser.i18n.getMessage()`.
   *
   * @param key - Message key from messages.json
   * @returns English base message
   */
  getBaseMessage(key: string): string {
    if (!this.initialized) {
      return browser.i18n.getMessage(key);
    }
    return this.translationService.getBaseMessage(key);
  }

  /**
   * Returns the base locale code.
   *
   * @returns The base locale code ('en')
   */
  getBaseUILanguage(): string {
    return BASE_LOCALE;
  }
}

/**
 * Shared singleton — each bundle gets its own instance due to separate
 * Rspack entry points.
 */
export const i18n = new I18n();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/i18n/i18n.test.ts`
Expected: PASS — all 6 assertions pass

**Verification**: `pnpm run lint:types` passes.

---

### [ ] Task 7: Create `translator` and `reactTranslator` singletons

**Files:**
- Create: `src/shared/i18n/translator.ts`
- Create: `src/shared/i18n/react-translator.ts`

- [ ] **Step 1: Create the plain-string translator**

Create `src/shared/i18n/translator.ts`:

```typescript
import { translate, type I18nInterface } from '@adguard/translate';

import { i18n } from '@/shared/i18n/i18n';

/**
 * Plain-string translator: resolves message keys to localized strings.
 * Used in non-React contexts (background, content scripts).
 */
export const translator = translate.createTranslator(
  i18n as I18nInterface,
);
```

- [ ] **Step 2: Create the React translator**

Create `src/shared/i18n/react-translator.ts`:

```typescript
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
```

- [ ] **Step 3: Verify compilation**

Run: `pnpm run lint:types`
Expected: PASS — no type errors

**Verification**: Both files compile; `translator.getMessage` and
`reactTranslator.getMessage` are callable.

---

### [ ] Task 8: Create base English locale file `en/messages.json`

**Files:**
- Create: `src/_locales/en/messages.json`

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p src/_locales/en
```

- [ ] **Step 2: Create the base messages file**

Create `src/_locales/en/messages.json` with all extracted strings:

```json
{
    "name": {
        "message": "TopSkip",
        "description": "Extension name displayed in Chrome Web Store and chrome://extensions. Keep short."
    },
    "short_name": {
        "message": "TopSkip",
        "description": "Short name for the extension. Used in the toolbar."
    },
    "description": {
        "message": "LLM-assisted promo skip on YouTube (MVP)",
        "description": "Extension description for Chrome Web Store listing. TEXT MAX LENGTH: 132"
    },
    "popup_heading": {
        "message": "TopSkip",
        "description": "Popup heading text"
    },
    "popup_enable_promo_skip": {
        "message": "Enable promo skip (YouTube)",
        "description": "Label next to the main enable/disable switch in the popup"
    },
    "popup_enable_auto_skip_aria": {
        "message": "Enable auto-skip",
        "description": "Accessible label for the enable/disable switch in the popup"
    },
    "popup_active_tab_prefix": {
        "message": "Active tab: ",
        "description": "Prefix before the detection status line in the popup. Includes trailing space."
    },
    "popup_open_settings": {
        "message": "Open settings (OpenRouter)",
        "description": "Button in the popup that opens the options page"
    },
    "popup_reliability_notice_title": {
        "message": "Reliability notice",
        "description": "Title for the yellow alert box in the popup"
    },
    "popup_reliability_notice_body_1": {
        "message": "TopSkip may rely on parts of YouTube's site that are not a documented public API—the same general area the YouTube web client uses. There is no guarantee that auto-skip will keep working if YouTube changes how the page behaves.",
        "description": "First paragraph of the reliability notice in the popup"
    },
    "popup_reliability_notice_body_2": {
        "message": "If it stops working, please report it where you installed this extension (for example the Chrome Web Store support options, if you installed it from there).",
        "description": "Second paragraph of the reliability notice in the popup"
    },
    "popup_detection_not_configured": {
        "message": "LLM not configured",
        "description": "Detection status shown when OpenRouter is not set up"
    },
    "popup_detection_unavailable": {
        "message": "Unavailable",
        "description": "Detection status shown when detection is unavailable"
    },
    "popup_detection_analyzing": {
        "message": "Analyzing…",
        "description": "Detection status shown during transcript analysis"
    },
    "popup_detection_detected": {
        "message": "Promo blocks detected",
        "description": "Detection status shown when promo blocks are found"
    },
    "popup_detection_no_promo": {
        "message": "No promo found",
        "description": "Detection status shown when no promo blocks are found"
    },
    "popup_detection_error": {
        "message": "Detection error",
        "description": "Detection status shown when detection fails"
    },
    "options_heading": {
        "message": "TopSkip — LLM promo detection",
        "description": "Heading on the options page"
    },
    "options_description": {
        "message": "Configure OpenRouter for transcript analysis. The API key is stored only in this browser profile (extension local storage).",
        "description": "Description text below the heading on the options page"
    },
    "options_enable_detection": {
        "message": "Enable LLM promo detection",
        "description": "Checkbox label on the options page"
    },
    "options_api_key_label": {
        "message": "OpenRouter API key",
        "description": "Label for the API key input on the options page"
    },
    "options_api_key_placeholder": {
        "message": "sk-or-…",
        "description": "Placeholder text for the API key input"
    },
    "options_api_key_saved": {
        "message": "Saved key: %mask% - leave blank to keep it.",
        "description": "Shown below API key input when a key is already saved. %mask% is the masked key value."
    },
    "options_api_key_none": {
        "message": "No key saved yet.",
        "description": "Shown below API key input when no key has been saved"
    },
    "options_model_label": {
        "message": "Model",
        "description": "Label for the model select dropdown on the options page"
    },
    "options_model_description": {
        "message": "Built-in presets and models you added below.",
        "description": "Help text below the model select dropdown"
    },
    "options_add_model_heading": {
        "message": "Add a model",
        "description": "Heading for the custom model section on the options page"
    },
    "options_add_model_description": {
        "message": "Type an OpenRouter model id (for example vendor/model), then Add to keep it for later sessions. This is not the same as Save below.",
        "description": "Help text for the custom model input section"
    },
    "options_custom_model_label": {
        "message": "Custom model id",
        "description": "Label for the custom model text input"
    },
    "options_custom_model_placeholder": {
        "message": "vendor/model",
        "description": "Placeholder for the custom model text input"
    },
    "options_add_button": {
        "message": "Add",
        "description": "Button to add a custom model id"
    },
    "options_your_models_heading": {
        "message": "Your added models",
        "description": "Heading above the list of user-added custom models"
    },
    "options_remove_button": {
        "message": "Remove",
        "description": "Button to remove a custom model from the list"
    },
    "options_saved": {
        "message": "Saved.",
        "description": "Success message shown after saving settings"
    },
    "options_save_button": {
        "message": "Save",
        "description": "Button to save all settings on the options page"
    },
    "options_reload_button": {
        "message": "Reload",
        "description": "Button to reload settings from storage on the options page"
    },
    "options_save_help": {
        "message": "Save applies the detection toggle, API key (if changed), and the selected model. Use Add to store extra model ids in your list.",
        "description": "Help text below the Save/Reload buttons"
    },
    "options_error_bg_no_response": {
        "message": "Extension background did not respond. Click Reload or reload the extension on chrome://extensions.",
        "description": "Error shown when the background service worker is unreachable"
    },
    "options_error_load_failed": {
        "message": "Failed to load settings",
        "description": "Generic error when loading settings fails"
    },
    "options_error_save_failed": {
        "message": "Save failed",
        "description": "Generic error when saving settings fails"
    },
    "options_error_add_model": {
        "message": "Could not add model",
        "description": "Error when adding a custom model fails"
    },
    "options_error_remove_model": {
        "message": "Could not remove model",
        "description": "Error when removing a custom model fails"
    },
    "content_skip_applied": {
        "message": "Skip applied",
        "description": "Brief toast notification shown on YouTube after a promo block is skipped"
    },
    "prefs_error_load": {
        "message": "failed to load preferences",
        "description": "Error fallback in preferences store when loading fails"
    },
    "prefs_error_save": {
        "message": "failed to save preferences",
        "description": "Error fallback in preferences store when saving fails"
    }
}
```

**Verification**: Valid JSON; contains keys for every hardcoded string identified
in the spec. `cat src/_locales/en/messages.json | python3 -m json.tool` succeeds.

---

### [ ] Task 9: Create stub locale files for the other 19 locales

**Files:**
- Create: `src/_locales/{ar,de,es,fr,hi,id,it,ja,ko,nl,pl,pt_BR,ru,th,tr,uk,vi,zh_CN,zh_TW}/messages.json`

- [ ] **Step 1: Create directories and copy English base as stubs**

Run:

```bash
for lang in ar de es fr hi id it ja ko nl pl pt_BR ru th tr uk vi zh_CN zh_TW; do
  mkdir -p "src/_locales/$lang"
  cp src/_locales/en/messages.json "src/_locales/$lang/messages.json"
done
```

- [ ] **Step 2: Verify 20 locale directories exist**

Run: `ls src/_locales/ | wc -l`
Expected: `20`

Run: `ls src/_locales/`
Expected: `ar de en es fr hi id it ja ko nl pl pt_BR ru th tr uk vi zh_CN zh_TW`

**Verification**: Every locale folder has a valid `messages.json`.

---

### [ ] Task 10: Update manifest.json for i18n

**Files:**
- Modify: `src/manifest.json`

- [ ] **Step 1: Add `default_locale` and replace hardcoded strings**

Replace the contents of `src/manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "__MSG_name__",
  "version": "0.1.0",
  "description": "__MSG_description__",
  "default_locale": "en",
  "permissions": ["storage", "tabs", "scripting"],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://openrouter.ai/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "__MSG_short_name__"
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  }
}
```

- [ ] **Step 2: Verify manifest is valid JSON**

Run: `python3 -m json.tool src/manifest.json > /dev/null`
Expected: No errors

**Verification**: Manifest contains `default_locale`, `__MSG_name__`,
`__MSG_description__`, `__MSG_short_name__`.

---

### [ ] Task 11: Update Rspack build to copy `_locales/`

**Files:**
- Modify: `rspack.config.ts:178-179`

- [ ] **Step 1: Add `_locales` copy pattern**

In `rspack.config.ts`, find the existing `CopyRspackPlugin` (line 178) and add
the `_locales` pattern:

```typescript
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: 'src/public', to: '.', noErrorOnMissing: true },
        { from: 'src/_locales', to: '_locales' },
      ],
    }),
```

- [ ] **Step 2: Build and verify `_locales/` is in `dist/`**

Run: `pnpm run build && ls dist/_locales/ | wc -l`
Expected: `20`

Run: `python3 -m json.tool dist/_locales/en/messages.json > /dev/null`
Expected: No errors

Run: `python3 -c "import json; m=json.load(open('dist/manifest.json')); assert m.get('default_locale')=='en', 'missing default_locale'; print('OK')"  `
Expected: `OK`

**Verification**: `dist/_locales/` has 20 folders; `dist/manifest.json` has
`default_locale`.

---

### [ ] Task 12: Initialize i18n in background script

**Files:**
- Modify: `src/background/background.ts`

- [ ] **Step 1: Add i18n import and init call**

At the top of `src/background/background.ts`, add the import:

```typescript
import { i18n } from '@/shared/i18n/i18n';
```

In the `Background.init()` static method, add `await i18n.init();` as the first
statement (before wiring lifecycle and messaging). If `init()` is not async,
wrap the call in a void promise or add it to the existing startup flow.

Look at the current `Background.init()` method and add the i18n initialization
at the beginning of the method body:

```typescript
await i18n.init();
```

- [ ] **Step 2: Build and verify no errors**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Verification**: Background script initializes i18n on startup.

---

### [ ] Task 13: Initialize i18n in popup and replace strings in `PopupApp.tsx`

**Files:**
- Modify: `src/popup/popup.tsx`
- Modify: `src/popup/PopupApp.tsx`

- [ ] **Step 1: Initialize i18n in popup bootstrap**

In `src/popup/popup.tsx`, add the import and init call. Since `Popup.init()` is
synchronous (it calls `createRoot().render()`), call `i18n.init()` as a
fire-and-forget before render (the `browser.i18n` fallback covers the gap):

```typescript
import { i18n } from '@/shared/i18n/i18n';
```

Add `void i18n.init();` as the first line inside `Popup.init()`:

```typescript
  static init(): void {
    void i18n.init();
    const rootEl = document.getElementById('root');
    // ...
  }
```

- [ ] **Step 2: Replace hardcoded strings in `PopupApp.tsx`**

Add imports at the top of `PopupApp.tsx`:

```typescript
import { translator } from '@/shared/i18n/translator';
```

Replace the `detectionLabel` function body (lines 34-51):

```typescript
function detectionLabel(s: PromoDetectionStatus): string {
  switch (s) {
    case 'not_configured':
      return translator.getMessage('popup_detection_not_configured');
    case 'unavailable':
      return translator.getMessage('popup_detection_unavailable');
    case 'analyzing':
      return translator.getMessage('popup_detection_analyzing');
    case 'detected':
      return translator.getMessage('popup_detection_detected');
    case 'no_promo':
      return translator.getMessage('popup_detection_no_promo');
    case 'error':
      return translator.getMessage('popup_detection_error');
    default:
      return s;
  }
}
```

In the JSX return (lines 120-163), replace all hardcoded strings:

- `'TopSkip'` → `{translator.getMessage('popup_heading')}`
- `'Enable promo skip (YouTube)'` → `{translator.getMessage('popup_enable_promo_skip')}`
- `aria-label="Enable auto-skip"` → `aria-label={translator.getMessage('popup_enable_auto_skip_aria')}`
- `Active tab: ` → `{translator.getMessage('popup_active_tab_prefix')}`
- `'Open settings (OpenRouter)'` → `{translator.getMessage('popup_open_settings')}`
- `title="Reliability notice"` → `title={translator.getMessage('popup_reliability_notice_title')}`
- First `<Text>` in alert → `{translator.getMessage('popup_reliability_notice_body_1')}`
- Second `<Text>` in alert → `{translator.getMessage('popup_reliability_notice_body_2')}`

- [ ] **Step 3: Build and verify**

Run: `pnpm run build`
Expected: Build succeeds

**Verification**: No hardcoded English strings in `PopupApp.tsx` UI output.

---

### [ ] Task 14: Initialize i18n in options and replace strings in `options.tsx`

**Files:**
- Modify: `src/options/options.tsx`

- [ ] **Step 1: Initialize i18n in options bootstrap**

In `src/options/options.tsx`, add at the top:

```typescript
import { i18n } from '@/shared/i18n/i18n';
import { translator } from '@/shared/i18n/translator';
```

In `Options.init()`, add `void i18n.init();` as the first line:

```typescript
  static init(): void {
    void i18n.init();
    const rootEl = document.getElementById('root');
    // ...
  }
```

- [ ] **Step 2: Replace hardcoded strings in `OptionsApp`**

Replace all hardcoded strings in the `OptionsApp` component JSX and error
handling:

- Line 87-91 error: `'Extension background did not respond...'` → `translator.getMessage('options_error_bg_no_response')`
- Line 247: `'Failed to load settings'` → `translator.getMessage('options_error_load_failed')`
- Line 253: `'Failed to load settings'` → `translator.getMessage('options_error_load_failed')`
- Line 296: `'Save failed'` → `translator.getMessage('options_error_save_failed')`
- Line 329: `'Could not add model'` → `translator.getMessage('options_error_add_model')`
- Line 365: `'Could not remove model'` → `translator.getMessage('options_error_remove_model')`
- Line 377: `'TopSkip — LLM promo detection'` → `{translator.getMessage('options_heading')}`
- Lines 379-380: description text → `{translator.getMessage('options_description')}`
- Line 383: `"Enable LLM promo detection"` → `{translator.getMessage('options_enable_detection')}`
- Line 390: `"OpenRouter API key"` → `{translator.getMessage('options_api_key_label')}`
- Line 391: `"sk-or-…"` → `{translator.getMessage('options_api_key_placeholder')}`
- Lines 400-401: description conditional → use `translator.getMessage('options_api_key_saved')` with `.replace('%mask%', savedApiKeyMasked)` or `translator.getMessage('options_api_key_none')`
- Line 405: `"Model"` → `{translator.getMessage('options_model_label')}`
- Line 406: `"Built-in presets..."` → `{translator.getMessage('options_model_description')}`
- Line 415: `"Add a model"` → `{translator.getMessage('options_add_model_heading')}`
- Lines 417-419: help text → `{translator.getMessage('options_add_model_description')}`
- Line 423: `"Custom model id"` → `{translator.getMessage('options_custom_model_label')}`
- Line 424: `"vendor/model"` → `{translator.getMessage('options_custom_model_placeholder')}`
- Line 435: `"Add"` → `{translator.getMessage('options_add_button')}`
- Line 443: `"Your added models"` → `{translator.getMessage('options_your_models_heading')}`
- Line 457: `"Remove"` → `{translator.getMessage('options_remove_button')}`
- Line 470: `"Saved."` → `{translator.getMessage('options_saved')}`
- Line 475: `"Save"` → `{translator.getMessage('options_save_button')}`
- Line 478: `"Reload"` → `{translator.getMessage('options_reload_button')}`
- Lines 482-484: help text → `{translator.getMessage('options_save_help')}`

- [ ] **Step 3: Build and verify**

Run: `pnpm run build`
Expected: Build succeeds

**Verification**: No hardcoded English strings in options page UI output.

---

### [ ] Task 15: Replace hardcoded strings in content script and preferences store

**Files:**
- Modify: `src/content/youtube-watch.ts:110`
- Modify: `src/content/content.ts`
- Modify: `src/popup/preferences-store.ts:75,103`

- [ ] **Step 1: Initialize i18n in content script**

In `src/content/content.ts`, add:

```typescript
import { i18n } from '@/shared/i18n/i18n';
```

Add `void i18n.init();` at the beginning of `Content.init()`.

- [ ] **Step 2: Replace toast string in `youtube-watch.ts`**

At the top of `src/content/youtube-watch.ts`, add:

```typescript
import { translator } from '@/shared/i18n/translator';
```

Replace line 110:

```typescript
// Before:
root.textContent = 'Skip applied';
// After:
root.textContent = translator.getMessage('content_skip_applied');
```

- [ ] **Step 3: Replace error strings in `preferences-store.ts`**

At the top of `src/popup/preferences-store.ts`, add:

```typescript
import { translator } from '@/shared/i18n/translator';
```

Replace line 75:

```typescript
// Before:
: 'failed to load preferences';
// After:
: translator.getMessage('prefs_error_load');
```

Replace line 103 (approximately):

```typescript
// Before:
: 'failed to save preferences';
// After:
: translator.getMessage('prefs_error_save');
```

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`
Expected: Build succeeds

**Verification**: Zero hardcoded user-facing English strings remain in source.

---

### [ ] Task 16: Run full lint and test suite

**Files:** (no new files)

- [ ] **Step 1: Run lint**

Run: `pnpm run lint`
Expected: PASS — no errors

- [ ] **Step 2: Run unit tests**

Run: `pnpm run test`
Expected: PASS — all existing tests pass; new i18n tests pass

- [ ] **Step 3: Run build**

Run: `pnpm run build`
Expected: PASS — `dist/` contains `_locales/` with 20 folders

- [ ] **Step 4: Run E2E tests**

Run: `pnpm run test:e2e`
Expected: PASS — existing E2E tests still pass

**Verification**: CI pipeline would pass. All SC-001 through SC-007 criteria met.

---

### [ ] Task 17: Create translation management CLI tooling

**Files:**
- Create: `tasks/translations/config.json`
- Create: `tasks/translations/locales-constants.js`
- Create: `tasks/translations/helpers.js`
- Create: `tasks/translations/download.js`
- Create: `tasks/translations/upload.js`
- Create: `tasks/translations/validate.js`
- Create: `tasks/translations/unused.js`
- Create: `tasks/translations/index.js`
- Modify: `package.json` (add `locales` script)

- [ ] **Step 1: Create `tasks/translations/config.json`**

```json
{
    "twosky_config_path": "../../.twosky.json",
    "api_url": "https://twosky.int.agrd.dev/api/v1",
    "source_relative_path": "../../src",
    "supported_source_filename_extensions": [
        ".js",
        ".jsx",
        ".tsx",
        ".ts"
    ],
    "persistent_messages": [
        "name",
        "short_name",
        "description"
    ],
    "locales_relative_path": "../../src/_locales",
    "locales_data_format": "chrome",
    "locales_data_filename": "messages.json",
    "required_locales": [],
    "threshold_percentage": 100
}
```

- [ ] **Step 2: Create the CLI scripts**

Port the VPN extension's `tasks/translations/` scripts with TopSkip-specific
paths. The scripts are plain Node.js (not TypeScript) using `commander` (already
in devDependencies) and `fs`/`path`. Each script follows the VPN extension's
structure:

- `locales-constants.js` — reads `.twosky.json` and `config.json`, exports
  `BASE_LOCALE`, `LOCALES`, `LOCALES_DIR`, `API_URL`, etc.
- `helpers.js` — `readJsonFile`, `writeJsonFile`, `logInfo`, `logError` helpers.
- `download.js` — fetches each locale from TwoSky API, saves to
  `src/_locales/<lang>/messages.json`.
- `upload.js` — posts `en/messages.json` to TwoSky.
- `validate.js` — uses `@adguard/translate` validator to check structural
  validity.
- `unused.js` — scans source files for message key references, reports
  unreferenced keys.
- `index.js` — `commander` CLI entry: `download`, `upload`, `validate`,
  `info --summary`, `info --unused`.

- [ ] **Step 3: Add `locales` script to package.json**

Add to the `scripts` section of `package.json`:

```json
"locales": "node tasks/translations/index.js"
```

- [ ] **Step 4: Verify the CLI**

Run: `pnpm locales validate`
Expected: Reports completeness (100% for `en`; 100% for all stubs since they
are copies of English).

**Verification**: `pnpm locales validate` runs without crashes.

---

### [ ] Task 18: Final verification — build, lint, test, manual check

**Files:** (no new files)

- [ ] **Step 1: Full CI pipeline check**

Run:

```bash
pnpm run lint && pnpm run build && pnpm run test && pnpm run test:coverage && pnpm run test:e2e
```

Expected: All pass

- [ ] **Step 2: Verify dist output**

Run:

```bash
ls dist/_locales/ | sort
```

Expected: `ar de en es fr hi id it ja ko nl pl pt_BR ru th tr uk vi zh_CN zh_TW`

Run:

```bash
python3 -c "
import json, pathlib
m = json.loads(pathlib.Path('dist/manifest.json').read_text())
assert m['default_locale'] == 'en'
assert m['name'] == '__MSG_name__'
assert m['description'] == '__MSG_description__'
assert m['action']['default_title'] == '__MSG_short_name__'
print('manifest OK')
"
```

Expected: `manifest OK`

- [ ] **Step 3: Manual smoke test**

1. `make build`, load `dist/` as unpacked extension in Chrome
2. Open popup — all strings display in English (via `browser.i18n` fallback
   or loaded `en` locale)
3. Open options page — all labels, placeholders, and error messages display
4. Verify `chrome://extensions` shows "TopSkip" as the extension name

**Verification**: All success criteria (SC-001 through SC-007) are met.
