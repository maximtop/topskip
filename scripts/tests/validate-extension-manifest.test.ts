import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {

    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    TopSkipBuild,
    getExtensionManifestName,
    type TopSkipBuildMode,
} from '@topskip/extension/build-modes';

import {
    main,
    validateExtensionManifest,
} from '../validate-extension-manifest';

interface ContentScriptFixture {
    matches: string[];
    js: string[];
    css?: string[];
    run_at: string;
    world: string;
    all_frames: boolean;
    match_about_blank: boolean;
    match_origin_as_fallback: boolean;
}

interface ManifestFixture {
    manifest_version: number;
    name: string;
    version: string;
    version_name?: string;
    minimum_chrome_version?: string;
    permissions: string[];
    optional_permissions: string[];
    host_permissions: string[];
    optional_host_permissions: string[];
    content_scripts: ContentScriptFixture[];
    background: { service_worker: string };
}

const RELEASE_SERVER_ORIGIN = 'https://topskip.example.com';
const DEV_SERVER_ORIGIN = 'http://127.0.0.1:8787';
const YOUTUBE_MATCH = 'https://www.youtube.com/*';
const DEV_FIXTURE_MATCH = 'http://127.0.0.1:4173/*';

function contentScript(
    world: 'MAIN' | 'ISOLATED',
    js: string,
    matches: string[],
): ContentScriptFixture {
    return {
        matches,
        js: [js],
        run_at: 'document_start',
        world,
        all_frames: false,
        match_about_blank: false,
        match_origin_as_fallback: false,
    };
}

function validManifest(
    build: TopSkipBuildMode = TopSkipBuild.Release,
): ManifestFixture {
    const matches = [YOUTUBE_MATCH];
    if (build === TopSkipBuild.Dev) {
        matches.push(DEV_FIXTURE_MATCH);
    }
    const serverOrigin = build === TopSkipBuild.Dev
        ? DEV_SERVER_ORIGIN
        : RELEASE_SERVER_ORIGIN;
    return {
        manifest_version: 3,
        name: getExtensionManifestName(build),
        version: '0.1.0',
        minimum_chrome_version: '111',
        permissions: ['storage', 'scripting', 'activeTab', 'unlimitedStorage'],
        optional_permissions: [],
        host_permissions: [`${serverOrigin}/*`],
        optional_host_permissions: [
            'https://openrouter.ai/*',
            'https://api.openai.com/*',
        ],
        content_scripts: [
            contentScript('MAIN', 'caption-page-bridge.js', [...matches]),
            contentScript('ISOLATED', 'content.js', [...matches]),
        ],
        background: { service_worker: 'background.js' },
    };
}

function validateRelease(manifest: ManifestFixture): void {
    validateExtensionManifest(manifest, {
        build: TopSkipBuild.Release,
        serverOrigin: RELEASE_SERVER_ORIGIN,
    });
}

describe('validateExtensionManifest', () => {
    it('accepts a valid release artifact with set-like arrays reordered', () => {
        const manifest = validManifest();
        manifest.optional_host_permissions.reverse();

        expect(() => validateRelease(manifest)).not.toThrow();
    });

    it('accepts a dev artifact whose display version carries the build stamp', () => {
        const manifest = validManifest(TopSkipBuild.Dev);
        manifest.version_name = '0.1.0 (dev build 2026-08-21T20:40:00Z)';

        expect(() => validateExtensionManifest(manifest, {
            build: TopSkipBuild.Dev,
            serverOrigin: DEV_SERVER_ORIGIN,
        })).not.toThrow();
    });

    it.each([
        ['required tabs', () => {
            const manifest = validManifest();
            manifest.permissions.push('tabs');
            return manifest;
        }],
        ['duplicate API permission', () => {
            const manifest = validManifest();
            manifest.permissions.push('storage');
            return manifest;
        }],
        ['optional tabs', () => {
            const manifest = validManifest();
            manifest.optional_permissions.push('tabs');
            return manifest;
        }],
        ['optional scripting', () => {
            const manifest = validManifest();
            manifest.optional_permissions.push('scripting');
            return manifest;
        }],
        ['missing storage', () => {
            const manifest = validManifest();
            manifest.permissions.splice(0);
            return manifest;
        }],
        ['missing scripting', () => {
            const manifest = validManifest();
            manifest.permissions = ['storage', 'activeTab', 'unlimitedStorage'];
            return manifest;
        }],
        ['missing activeTab', () => {
            const manifest = validManifest();
            manifest.permissions = ['storage', 'scripting', 'unlimitedStorage'];
            return manifest;
        }],
        ['missing unlimitedStorage', () => {
            const manifest = validManifest();
            manifest.permissions = ['storage', 'scripting', 'activeTab'];
            return manifest;
        }],
        ['optional unlimitedStorage', () => {
            const manifest = validManifest();
            manifest.optional_permissions.push('unlimitedStorage');
            return manifest;
        }],
        ['required downloads', () => {
            const manifest = validManifest();
            manifest.permissions.push('downloads');
            return manifest;
        }],
        ['required OpenRouter', () => {
            const manifest = validManifest();
            manifest.host_permissions.push('https://openrouter.ai/*');
            return manifest;
        }],
        ['missing optional OpenAI', () => {
            const manifest = validManifest();
            manifest.optional_host_permissions.pop();
            return manifest;
        }],
        ['duplicate host', () => {
            const manifest = validManifest();
            manifest.optional_host_permissions.push('https://openrouter.ai/*');
            return manifest;
        }],
        ['unknown host', () => {
            const manifest = validManifest();
            manifest.optional_host_permissions.push('https://unknown.example/*');
            return manifest;
        }],
        ['HTTP release host', () => {
            const manifest = validManifest();
            manifest.host_permissions = ['http://topskip.example.com/*'];
            return manifest;
        }],
        ['release fixture', () => {
            const manifest = validManifest();
            manifest.content_scripts[0]?.matches.push(DEV_FIXTURE_MATCH);
            return manifest;
        }],
        ['wrong MAIN world', () => {
            const manifest = validManifest();
            if (manifest.content_scripts[0]) {
                manifest.content_scripts[0].world = 'ISOLATED';
            }
            return manifest;
        }],
        ['swapped content order', () => {
            const manifest = validManifest();
            manifest.content_scripts.reverse();
            return manifest;
        }],
        ['lower Chrome version', () => {
            const manifest = validManifest();
            manifest.minimum_chrome_version = '110';
            return manifest;
        }],
        ['missing Chrome version', () => {
            const manifest = validManifest();
            delete manifest.minimum_chrome_version;
            return manifest;
        }],
        ['all frames', () => {
            const manifest = validManifest();
            if (manifest.content_scripts[0]) {
                manifest.content_scripts[0].all_frames = true;
            }
            return manifest;
        }],
        ['about blank', () => {
            const manifest = validManifest();
            if (manifest.content_scripts[0]) {
                manifest.content_scripts[0].match_about_blank = true;
            }
            return manifest;
        }],
        ['origin fallback', () => {
            const manifest = validManifest();
            if (manifest.content_scripts[0]) {
                manifest.content_scripts[0].match_origin_as_fallback = true;
            }
            return manifest;
        }],
        ['extra JS', () => {
            const manifest = validManifest();
            manifest.content_scripts[0]?.js.push('extra.js');
            return manifest;
        }],
        ['extra CSS', () => {
            const manifest = validManifest();
            if (manifest.content_scripts[0]) {
                manifest.content_scripts[0].css = ['extra.css'];
            }
            return manifest;
        }],
        ['extra match', () => {
            const manifest = validManifest();
            manifest.content_scripts[0]?.matches.push('https://example.com/*');
            return manifest;
        }],
        ['wrong manifest version', () => {
            const manifest = validManifest();
            manifest.manifest_version = 2;
            return manifest;
        }],
        ['wrong profile name', () => {
            const manifest = validManifest();
            manifest.name = 'TopSkip (Dev)';
            return manifest;
        }],
        ['wrong service worker', () => {
            const manifest = validManifest();
            manifest.background.service_worker = 'worker.js';
            return manifest;
        }],
    ])('rejects %s', (_label, buildInvalid) => {
        const manifest = buildInvalid();

        expect(() => validateRelease(manifest)).toThrow();
    });

    it.each([0, 1])(
        'requires the dev fixture in content script %i',
        (scriptIndex) => {
            const manifest = validManifest(TopSkipBuild.Dev);
            manifest.content_scripts[scriptIndex]?.matches.pop();

            expect(() => validateExtensionManifest(manifest, {
                build: TopSkipBuild.Dev,
                serverOrigin: DEV_SERVER_ORIGIN,
            })).toThrow();
        },
    );

    it('rejects overlap between required and optional hosts', () => {
        const manifest = validManifest();
        manifest.optional_host_permissions.push(
            `${RELEASE_SERVER_ORIGIN}/*`,
        );

        expect(() => validateRelease(manifest)).toThrow();
    });

    it('treats match order as set-like within each ordered entry', () => {
        const manifest = validManifest(TopSkipBuild.Dev);
        for (const script of manifest.content_scripts) {
            script.matches.reverse();
        }

        expect(() => validateExtensionManifest(manifest, {
            build: TopSkipBuild.Dev,
            serverOrigin: DEV_SERVER_ORIGIN,
        })).not.toThrow();
    });
});

describe('manifest validator CLI', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('can be imported without executing the CLI', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const readFile = vi.spyOn(fs, 'readFile');
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit must not run on import');
        });
        const originalArgv = [...process.argv];
        process.argv.splice(
            0,
            process.argv.length,
            'node',
            '/workspace/node_modules/vitest/vitest.mjs',
            'run',
            '--reporter=default',
        );

        try {
            vi.resetModules();
            await import('../validate-extension-manifest');
        } finally {
            process.argv.splice(0, process.argv.length, ...originalArgv);
        }

        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(readFile).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
    });

    it('validates a manifest file through main', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'topskip-manifest-'),
        );
        const manifestPath = path.join(directory, 'manifest.json');
        await fs.writeFile(
            manifestPath,
            JSON.stringify(validManifest()),
            'utf8',
        );
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const code = await main([
            '--',
            '--build',
            'release',
            '--server-origin',
            RELEASE_SERVER_ORIGIN,
            '--manifest',
            manifestPath,
        ]);

        expect(code).toBe(0);
        expect(log).toHaveBeenCalledWith('Extension manifest is valid.');
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('returns a bounded policy error for invalid CLI input', async () => {
        const messages: unknown[] = [];
        vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
            messages.push(message);
        });

        const code = await main(['--unknown', 'secret-value']);

        expect(code).toBe(1);
        const firstMessage = messages[0];
        expect(typeof firstMessage).toBe('string');
        expect(String(firstMessage).length).toBeLessThanOrEqual(300);
    });
});
