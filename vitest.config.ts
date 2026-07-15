import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSING_TEST_YT_DLP_PATH = '/__topskip_test_missing__/yt-dlp';

export default defineConfig({
    define: {
        __TOPSKIP_INCLUDE_DEV_LOCAL__: false,
    },
    test: {
        environment: 'node',
        env: {
            TOPSKIP_YT_DLP_PATH: MISSING_TEST_YT_DLP_PATH,
        },
        include: [
            'backend/tests/**/*.test.ts',
            'common/tests/**/*.test.ts',
            'extension/tests/**/*.test.ts',
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
