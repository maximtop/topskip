import { afterEach, describe, expect, it } from 'vitest';

import {
    TopSkipBuild,
    getExtensionManifestName,
    getServerAnalysisBaseUrl,
    getServerAnalysisManifestMatch,
    shouldEnableCaptionCaptureVerboseLogs,
    SERVER_ORIGIN_ENV_VAR,
} from '../build-modes';

// Same source the build reads; vitest.config.ts pins it for hermetic runs.
const configuredOrigin = process.env[SERVER_ORIGIN_ENV_VAR] ?? '';

describe('TopSkip server build routing', () => {
    it.each([
        [TopSkipBuild.Dev, 'TopSkip (Dev)'],
        [TopSkipBuild.Beta, 'TopSkip (Beta)'],
        [TopSkipBuild.Release, '__MSG_name__'],
    ])('uses the expected manifest name for %s', (build, name) => {
        expect(getExtensionManifestName(build)).toBe(name);
    });

    // Asserted against the shared constant rather than a copied literal: the
    // point is that no profile diverges onto its own origin, not what the
    // origin happens to be.
    it.each([TopSkipBuild.Dev, TopSkipBuild.Beta, TopSkipBuild.Release])(
        'uses the public backend for the %s build',
        (build) => {
            expect(getServerAnalysisBaseUrl(build)).toBe(configuredOrigin);
            expect(getServerAnalysisManifestMatch(build)).toBe(
                `${configuredOrigin}/*`,
            );
        },
    );

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

describe('backend origin configuration', () => {
    const original = process.env[SERVER_ORIGIN_ENV_VAR];

    afterEach(() => {
        if (original === undefined) {
            delete process.env[SERVER_ORIGIN_ENV_VAR];
        } else {
            process.env[SERVER_ORIGIN_ENV_VAR] = original;
        }
    });

    it.each(['', '   '])(
        'fails the build when the origin is blank (%p)',
        (value) => {
            process.env[SERVER_ORIGIN_ENV_VAR] = value;
            expect(() => getServerAnalysisBaseUrl(TopSkipBuild.Release)).toThrow(
                /is not set/,
            );
        },
    );

    it('fails the build when the origin is unset', () => {
        delete process.env[SERVER_ORIGIN_ENV_VAR];
        expect(() => getServerAnalysisBaseUrl(TopSkipBuild.Release)).toThrow(
            /is not set/,
        );
    });

    it.each([
        ['not-a-url', /absolute URL/],
        ['ftp://example.com', /http or https/],
        // Callers append `/v1/...`, so a path or trailing slash would produce
        // a double slash or a nested path at request time.
        ['https://example.com/', /bare origin/],
        ['https://example.com/api', /bare origin/],
    ])('rejects %p', (value, message) => {
        process.env[SERVER_ORIGIN_ENV_VAR] = value;
        expect(() => getServerAnalysisBaseUrl(TopSkipBuild.Release)).toThrow(
            message,
        );
    });

    it('accepts a bare origin and derives the manifest match from it', () => {
        process.env[SERVER_ORIGIN_ENV_VAR] = 'https://api.example.com';
        expect(getServerAnalysisBaseUrl(TopSkipBuild.Release)).toBe(
            'https://api.example.com',
        );
        expect(getServerAnalysisManifestMatch(TopSkipBuild.Release)).toBe(
            'https://api.example.com/*',
        );
    });
});
