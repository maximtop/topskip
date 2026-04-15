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
