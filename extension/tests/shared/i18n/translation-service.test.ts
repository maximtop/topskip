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

/**
 * Extracts URL string from fetch input.
 * @param url - fetch input
 * @returns URL as string
 */
function toUrlString(
  url: string | URL | Request,
): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

global.fetch = vi.fn((url: string | URL | Request) => {
  const urlStr = toUrlString(url);
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

  it('getMessage returns empty string for missing key', async () => {
    const fakeFrPartial = { popup_heading: { message: 'TopSkip' } };
    vi.mocked(fetch).mockImplementation(
      (url: string | URL | Request) => {
        const urlStr = toUrlString(url);
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
        return Promise.reject(
          new Error(`unexpected: ${urlStr}`),
        );
      },
    );
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
