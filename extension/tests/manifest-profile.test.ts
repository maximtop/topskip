import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import {
    DEV_E2E_CONTENT_SCRIPT_MATCH,
    TopSkipBuild,
    getDevE2eOrigin,
} from '../build-modes';
import {
    TOPSKIP_MINIMUM_CHROME_VERSION,
    composeExtensionManifest,
} from '../manifest-profile';

const EXPECTED_PROVIDER_HOSTS = [
    'https://openrouter.ai/*',
    'https://api.openai.com/*',
];

function staleSourceManifest(): unknown {
    return {
        manifest_version: 3,
        name: '__MSG_name__',
        version: '0.1.0',
        description: '__MSG_description__',
        permissions: ['storage', 'tabs', 'scripting'],
        optional_permissions: ['tabs'],
        host_permissions: [
            'https://www.youtube.com/*',
            'https://openrouter.ai/*',
            'https://openrouter.ai/*',
        ],
        optional_host_permissions: ['https://stale.example/*'],
        content_scripts: [
            {
                matches: ['https://stale.example/*'],
                js: ['stale.js'],
            },
        ],
        background: { service_worker: 'background.js' },
    };
}

describe('composeExtensionManifest', () => {
    afterEach(() => {
        delete process.env.TOPSKIP_SERVER_ORIGIN;
    });

    it('replaces every security-sensitive release field exactly', () => {
        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            TopSkipBuild.Release,
            'https://topskip.example.com',
        );

        expect(manifest.name).toBe('__MSG_name__');
        expect(manifest.permissions).toEqual([
            'storage',
            'scripting',
            'activeTab',
        ]);
        expect(manifest.optional_permissions).toEqual([]);
        expect(manifest.minimum_chrome_version).toBe(
            TOPSKIP_MINIMUM_CHROME_VERSION,
        );
        expect(manifest.host_permissions).toEqual([
            'https://topskip.example.com/*',
        ]);
        expect(manifest.optional_host_permissions).toEqual(
            EXPECTED_PROVIDER_HOSTS,
        );
        expect(manifest.content_scripts).toEqual([
            {
                matches: ['https://www.youtube.com/*'],
                js: ['caption-page-bridge.js'],
                run_at: 'document_start',
                world: 'MAIN',
                all_frames: false,
                match_about_blank: false,
                match_origin_as_fallback: false,
            },
            {
                matches: ['https://www.youtube.com/*'],
                js: ['content.js'],
                run_at: 'document_start',
                world: 'ISOLATED',
                all_frames: false,
                match_about_blank: false,
                match_origin_as_fallback: false,
            },
        ]);
        expect(manifest.background).toEqual({
            service_worker: 'background.js',
        });
    });

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'keeps local fixture access out of %s',
        (build) => {
            const manifest = composeExtensionManifest(
                staleSourceManifest(),
                build,
                'https://topskip.example.com',
            );

            expect(manifest.host_permissions).not.toContain(
                'http://127.0.0.1:4173/*',
            );
            for (const script of manifest.content_scripts) {
                expect(script.matches).toEqual([
                    'https://www.youtube.com/*',
                ]);
            }
        },
    );

    it('adds the fixture only to both dev content-script matches', () => {
        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            TopSkipBuild.Dev,
            'http://127.0.0.1:8787',
        );

        expect(manifest.host_permissions).toEqual([
            'http://127.0.0.1:8787/*',
        ]);
        for (const script of manifest.content_scripts) {
            expect(script.matches).toEqual([
                'https://www.youtube.com/*',
                'http://127.0.0.1:4173/*',
            ]);
        }
    });

    it('uses only the explicit server origin argument', () => {
        process.env.TOPSKIP_SERVER_ORIGIN = 'https://conflict.example.net';

        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            TopSkipBuild.Release,
            'https://topskip.example.com',
        );

        expect(manifest.host_permissions).toEqual([
            'https://topskip.example.com/*',
        ]);
    });

    it.each([
        'https://www.youtube.com',
        'https://openrouter.ai',
        'https://api.openai.com',
        'http://127.0.0.1:4173',
    ])('rejects reserved server origin %s', (origin) => {
        expect(() =>
            composeExtensionManifest(
                staleSourceManifest(),
                TopSkipBuild.Dev,
                origin,
            ),
        ).toThrow(/reserved/u);
    });

    it.each([
        {},
        { manifest_version: 2, name: 'TopSkip', version: '1.0.0' },
        { manifest_version: 3, name: '', version: '1.0.0' },
        { manifest_version: 3, name: 'TopSkip', version: '' },
    ])('rejects an invalid non-security base manifest %#', (source) => {
        expect(() =>
            composeExtensionManifest(
                source,
                TopSkipBuild.Release,
                'https://topskip.example.com',
            ),
        ).toThrow();
    });

    it.each([
        [TopSkipBuild.Dev, 'http://127.0.0.1:8787'],
        [TopSkipBuild.Beta, 'https://topskip.example.com'],
    ])('stamps the %s build time into version_name', (build, origin) => {
        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            build,
            origin,
            new Date('2026-08-21T20:40:00.123Z'),
        );

        expect(manifest.version).toBe('0.1.0');
        expect(manifest.version_name).toBe(
            `0.1.0 (${build} build 2026-08-21T20:40:00Z)`,
        );
    });

    it('keeps the bare store version for release builds', () => {
        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            TopSkipBuild.Release,
            'https://topskip.example.com',
            new Date('2026-08-21T20:40:00Z'),
        );

        expect(manifest.version_name).toBeUndefined();
    });

    it('omits version_name when no build time is supplied', () => {
        const manifest = composeExtensionManifest(
            staleSourceManifest(),
            TopSkipBuild.Dev,
            'http://127.0.0.1:8787',
        );

        expect(manifest.version_name).toBeUndefined();
    });
});

describe('getDevE2eOrigin', () => {
    it('compiles the fixture origin into dev bundles only', () => {
        expect(getDevE2eOrigin(TopSkipBuild.Dev)).toBe(
            'http://127.0.0.1:4173',
        );
        expect(DEV_E2E_CONTENT_SCRIPT_MATCH).toBe('http://127.0.0.1:4173/*');
        expect(getDevE2eOrigin(TopSkipBuild.Beta)).toBeNull();
        expect(getDevE2eOrigin(TopSkipBuild.Release)).toBeNull();
    });
});
