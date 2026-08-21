import { afterEach, describe, expect, it } from 'vitest';

import {
    SERVER_ORIGIN_ENV_VAR,
    TOPSKIP_BUILD_MODES,
    TopSkipBuild,
    getExtensionManifestName,
    getServerAnalysisBaseUrl,
    getServerAnalysisManifestMatch,
    resolveTopSkipBuild,
    shouldEnableCaptionCaptureVerboseLogs,
    validateServerOrigin,
} from '../build-modes';

const PUBLIC_SERVER_ORIGIN = 'https://api.topskip.dev';
const DEV_LOOPBACK_SERVER_ORIGIN = 'http://127.0.0.1:8787';

describe('TopSkip build profile', () => {
    it('defaults only an absent build profile to development', () => {
        expect(resolveTopSkipBuild(undefined)).toBe(TopSkipBuild.Dev);
    });

    it.each(TOPSKIP_BUILD_MODES)('accepts the %s build profile', (build) => {
        expect(resolveTopSkipBuild(build)).toBe(build);
    });

    it.each(['', ' ', 'relese', ' release', 'release '])(
        'rejects the explicit build profile %p',
        (raw) => {
            expect(() => resolveTopSkipBuild(raw)).toThrow(/TOPSKIP_BUILD/);
        },
    );

    it.each([
        [TopSkipBuild.Dev, 'TopSkip (Dev)'],
        [TopSkipBuild.Beta, 'TopSkip (Beta)'],
        [TopSkipBuild.Release, '__MSG_name__'],
    ])('uses the expected manifest name for %s', (build, name) => {
        expect(getExtensionManifestName(build)).toBe(name);
    });

    it('enables verbose caption diagnostics only for development', () => {
        expect(shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Dev)).toBe(
            true,
        );
        expect(shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Beta)).toBe(
            false,
        );
        expect(
            shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Release),
        ).toBe(false);
    });
});

describe('backend origin policy', () => {
    const originalServerOrigin = process.env[SERVER_ORIGIN_ENV_VAR];

    afterEach(() => {
        if (originalServerOrigin === undefined) {
            delete process.env[SERVER_ORIGIN_ENV_VAR];
            return;
        }
        process.env[SERVER_ORIGIN_ENV_VAR] = originalServerOrigin;
    });

    it.each(TOPSKIP_BUILD_MODES)(
        'accepts a public HTTPS DNS origin for %s',
        (build) => {
            expect(validateServerOrigin(build, PUBLIC_SERVER_ORIGIN)).toBe(
                PUBLIC_SERVER_ORIGIN,
            );
        },
    );

    it('accepts only the exact development HTTP exception', () => {
        expect(
            validateServerOrigin(
                TopSkipBuild.Dev,
                DEV_LOOPBACK_SERVER_ORIGIN,
            ),
        ).toBe(DEV_LOOPBACK_SERVER_ORIGIN);
    });

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'rejects a missing or blank %s origin',
        (build) => {
            expect(() => validateServerOrigin(build, undefined)).toThrow(
                /is not set/,
            );
            expect(() => validateServerOrigin(build, '')).toThrow(/is not set/);
            expect(() => validateServerOrigin(build, '   ')).toThrow(
                /is not set/,
            );
        },
    );

    it.each(TOPSKIP_BUILD_MODES)(
        'rejects surrounding whitespace for %s',
        (build) => {
            expect(() =>
                validateServerOrigin(build, ` ${PUBLIC_SERVER_ORIGIN}`),
            ).toThrow(/whitespace/);
            expect(() =>
                validateServerOrigin(build, `${PUBLIC_SERVER_ORIGIN} `),
            ).toThrow(/whitespace/);
        },
    );

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'requires public HTTPS for %s',
        (build) => {
            expect(() =>
                validateServerOrigin(build, 'http://topskip.example.com'),
            ).toThrow(/public HTTPS/);
            expect(() =>
                validateServerOrigin(build, DEV_LOOPBACK_SERVER_ORIGIN),
            ).toThrow(/public HTTPS/);
        },
    );

    it.each([
        'http://127.0.0.1:8788',
        'http://localhost:8787',
        'http://topskip.example.com',
    ])('rejects the non-exempt development HTTP origin %s', (origin) => {
        expect(() => validateServerOrigin(TopSkipBuild.Dev, origin)).toThrow(
            /public HTTPS/,
        );
    });

    const specialUseSuffixes = [
        'localhost',
        'local',
        'localdomain',
        'localnet',
        'internal',
        'home',
        'lan',
        'test',
        'example',
        'invalid',
        'onion',
        'arpa',
        'alt',
    ];

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'rejects special-use DNS suffixes for %s',
        (build) => {
            for (const suffix of specialUseSuffixes) {
                expect(() =>
                    validateServerOrigin(build, `https://api.${suffix}`),
                ).toThrow(/public HTTPS/);
            }
            expect(() => validateServerOrigin(build, 'https://localhost')).toThrow(
                /public HTTPS/,
            );
        },
    );

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'rejects a single-label DNS name for %s',
        (build) => {
            expect(() => validateServerOrigin(build, 'https://intranet')).toThrow(
                /public HTTPS/,
            );
        },
    );

    it.each([
        'https://localhost.',
        'https://api.internal.',
        'https://example.com.',
        'https://api.internal\u3002',
        'https://example.com\uFF0E',
        'https://example.com\uFF61',
    ])('rejects the rooted DNS spelling %s', (origin) => {
        expect(() =>
            validateServerOrigin(TopSkipBuild.Release, origin),
        ).toThrow(/public HTTPS/);
    });

    it.each([
        'https://2130706433',
        'https://127.0.0.2',
        'https://0.0.0.0',
        'https://10.0.0.1',
        'https://100.64.0.1',
        'https://172.16.0.1',
        'https://192.168.0.1',
        'https://169.254.0.1',
        'https://224.0.0.1',
        'https://240.0.0.1',
        'https://255.255.255.255',
        'https://8.8.8.8',
        'https://[::]',
        'https://[::1]',
        'https://[::ffff:127.0.0.1]',
        'https://[::ffff:10.0.0.1]',
        'https://[fc00::1]',
        'https://[fe80::1]',
    ])('rejects the canonical IP literal %s', (origin) => {
        expect(() =>
            validateServerOrigin(TopSkipBuild.Release, origin),
        ).toThrow(/public HTTPS/);
    });

    it.each([
        ['not-a-url', /absolute URL/],
        ['ftp://example.com', /http or https/],
        ['https://user@example.com', /bare origin/],
        ['https://user:password@example.com', /bare origin/],
        ['https://example.com/', /bare origin/],
        ['https://example.com/api', /bare origin/],
        ['https://example.com?query=value', /bare origin/],
        ['https://example.com#fragment', /bare origin/],
        ['https://*.example.com', /public HTTPS/],
    ])('rejects non-origin input %p', (value, message) => {
        expect(() =>
            validateServerOrigin(TopSkipBuild.Release, value),
        ).toThrow(message);
    });

    it('makes the environment-backed getters use the same policy', () => {
        process.env[SERVER_ORIGIN_ENV_VAR] = PUBLIC_SERVER_ORIGIN;
        expect(getServerAnalysisBaseUrl(TopSkipBuild.Release)).toBe(
            PUBLIC_SERVER_ORIGIN,
        );
        expect(getServerAnalysisManifestMatch(TopSkipBuild.Release)).toBe(
            `${PUBLIC_SERVER_ORIGIN}/*`,
        );

        process.env[SERVER_ORIGIN_ENV_VAR] = 'http://topskip.example.com';
        expect(() => getServerAnalysisBaseUrl(TopSkipBuild.Release)).toThrow(
            /public HTTPS/,
        );
    });

    it('does not leak a configured origin into the pure validator', () => {
        process.env[SERVER_ORIGIN_ENV_VAR] = 'https://environment.example.com';
        expect(
            validateServerOrigin(TopSkipBuild.Release, PUBLIC_SERVER_ORIGIN),
        ).toBe(PUBLIC_SERVER_ORIGIN);
    });
});
