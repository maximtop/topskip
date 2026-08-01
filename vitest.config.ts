import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSING_TEST_YT_DLP_PATH = '/__topskip_test_missing__/yt-dlp';

// Hermetic origin for tests: never the real deployment host, so assertions
// cannot silently depend on where this happens to be deployed.
const TEST_SERVER_ORIGIN = 'https://topskip.test';

export default defineConfig({
    define: {
        __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__: false,
        __TOPSKIP_INCLUDE_DEV_LOCAL__: false,
        __TOPSKIP_INCLUDE_CHROME_BUILTIN__: false,
        __TOPSKIP_SERVER_BASE_URL__: JSON.stringify(TEST_SERVER_ORIGIN),
    },
    test: {
        environment: 'node',
        env: {
            TOPSKIP_YT_DLP_PATH: MISSING_TEST_YT_DLP_PATH,
            TOPSKIP_SERVER_ORIGIN: TEST_SERVER_ORIGIN,
        },
        include: [
            'backend/tests/**/*.test.ts',
            'common/tests/**/*.test.ts',
            'extension/tests/**/*.test.ts',
            'scripts/tests/**/*.test.ts',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: [
                'extension/src/content/skip-logic.ts',
                'extension/src/content/promo-skip-logic.ts',
                'extension/src/content/page-guards.ts',
                'extension/src/popup/preferences-store.ts',
            ],
            thresholds: {
                lines: 80,
                branches: 75,
                functions: 80,
                statements: 80,
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'extension/src'),
            '@topskip/backend': path.resolve(__dirname, 'backend/src'),
            '@topskip/common': path.resolve(__dirname, 'common/src'),
        },
    },
});
