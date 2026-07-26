import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    BACKEND_CAPTION_SOURCE,
    BackendServerConfig,
} from '@topskip/backend/server-config';

const ORIGINAL_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_HMAC_SECRET = process.env.TOPSKIP_IP_HMAC_SECRET;
const ORIGINAL_ALLOWED_ORIGINS = process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS;
const ORIGINAL_SUPPORT_ISSUE_BASE_URL =
    process.env.TOPSKIP_SUPPORT_ISSUE_BASE_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CAPTION_SOURCE = process.env.TOPSKIP_CAPTION_SOURCE;

describe('BackendServerConfig', () => {
    afterEach(() => {
        if (ORIGINAL_API_KEY === undefined) {
            delete process.env.OPENROUTER_API_KEY;
        } else {
            process.env.OPENROUTER_API_KEY = ORIGINAL_API_KEY;
        }
        if (ORIGINAL_HMAC_SECRET === undefined) {
            delete process.env.TOPSKIP_IP_HMAC_SECRET;
        } else {
            process.env.TOPSKIP_IP_HMAC_SECRET = ORIGINAL_HMAC_SECRET;
        }
        if (ORIGINAL_ALLOWED_ORIGINS === undefined) {
            delete process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS;
        } else {
            process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS =
                ORIGINAL_ALLOWED_ORIGINS;
        }
        if (ORIGINAL_SUPPORT_ISSUE_BASE_URL === undefined) {
            delete process.env.TOPSKIP_SUPPORT_ISSUE_BASE_URL;
        } else {
            process.env.TOPSKIP_SUPPORT_ISSUE_BASE_URL =
                ORIGINAL_SUPPORT_ISSUE_BASE_URL;
        }
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
        if (ORIGINAL_CAPTION_SOURCE === undefined) {
            delete process.env.TOPSKIP_CAPTION_SOURCE;
        } else {
            process.env.TOPSKIP_CAPTION_SOURCE = ORIGINAL_CAPTION_SOURCE;
        }
    });

    it('loads OPENROUTER_API_KEY from an env file', () => {
        const directory = mkdtempSync(join(tmpdir(), 'topskip-env-'));
        const envPath = join(directory, '.env');
        writeFileSync(envPath, 'OPENROUTER_API_KEY=test-from-file\n', 'utf8');
        delete process.env.OPENROUTER_API_KEY;

        BackendServerConfig.prepare(envPath);

        expect(process.env.OPENROUTER_API_KEY).toBe('test-from-file');
        rmSync(directory, { recursive: true, force: true });
    });

    it('fails before startup when the API key is missing', () => {
        delete process.env.OPENROUTER_API_KEY;

        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).toThrow(/OPENROUTER_API_KEY.*\.env/u);
    });

    it('requires a strong IP HMAC secret in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.OPENROUTER_API_KEY = 'test-key';
        delete process.env.TOPSKIP_IP_HMAC_SECRET;

        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).toThrow(/TOPSKIP_IP_HMAC_SECRET/u);

        process.env.TOPSKIP_IP_HMAC_SECRET = 'x'.repeat(32);
        process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS = `chrome-extension://${'a'.repeat(32)}`;
        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).not.toThrow();
    });

    it('requires exact unique Chrome extension origins in production', () => {
        process.env.NODE_ENV = 'production';
        process.env.OPENROUTER_API_KEY = 'test-key';
        process.env.TOPSKIP_IP_HMAC_SECRET = 'x'.repeat(32);
        delete process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS;

        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).toThrow(/TOPSKIP_ALLOWED_EXTENSION_ORIGINS/u);

        process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS =
            'chrome-extension://*, chrome-extension://bad';
        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).toThrow(/unique exact/u);
    });

    it('rejects an unsafe support issue URL before startup', () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        process.env.TOPSKIP_SUPPORT_ISSUE_BASE_URL =
            'https://example.com/private/issues/new';

        expect(() => {
            BackendServerConfig.prepare('/missing/topskip/.env');
        }).toThrow();
    });

    it('selects extension upload by default and accepts only exact caption-source values', () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        delete process.env.TOPSKIP_CAPTION_SOURCE;

        expect(BackendServerConfig.prepare('/missing/topskip/.env')).toEqual({
            captionSource: BACKEND_CAPTION_SOURCE.ExtensionUpload,
        });

        process.env.TOPSKIP_CAPTION_SOURCE =
            BACKEND_CAPTION_SOURCE.ExtensionUpload;
        expect(BackendServerConfig.prepare('/missing/topskip/.env')).toEqual({
            captionSource: BACKEND_CAPTION_SOURCE.ExtensionUpload,
        });

        process.env.TOPSKIP_CAPTION_SOURCE = BACKEND_CAPTION_SOURCE.LegacyYtDlp;
        expect(BackendServerConfig.prepare('/missing/topskip/.env')).toEqual({
            captionSource: BACKEND_CAPTION_SOURCE.LegacyYtDlp,
        });
    });

    it.each([' legacy_yt_dlp', 'legacy_yt_dlp ', 'LEGACY_YT_DLP', 'unknown'])(
        'fails startup closed for caption source %j',
        (captionSource) => {
            process.env.OPENROUTER_API_KEY = 'test-key';
            process.env.TOPSKIP_CAPTION_SOURCE = captionSource;

            expect(() => {
                BackendServerConfig.prepare('/missing/topskip/.env');
            }).toThrow(/TOPSKIP_CAPTION_SOURCE/u);
        },
    );
});
