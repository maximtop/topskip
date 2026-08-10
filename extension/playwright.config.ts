import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Builds the extension against the loopback backend the specs mock; the
    // shipped profiles all point at the public origin, which no local listener
    // can answer.
    globalSetup: './tests/e2e/global-setup.ts',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: 'list',
    use: {
        trace: 'on-first-retry',
        baseURL: 'http://127.0.0.1:4173',
    },
    projects: [
        {
            name: 'chromium-extension',
            use: {
                channel: 'chromium',
            },
        },
    ],
    webServer: {
        command: 'pnpm exec serve tests/e2e/fixtures -p 4173 -L',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
