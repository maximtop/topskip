import { describe, expect, it } from 'vitest';

import {
    TopSkipBuild,
    getExtensionManifestName,
    getServerAnalysisBaseUrl,
    getServerAnalysisManifestMatch,
    shouldEnableCaptionCaptureVerboseLogs,
} from '../build-modes';
import { TOPSKIP_PUBLIC_SERVER_BASE_URL } from '../src/shared/server-analysis-origin';

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
            expect(getServerAnalysisBaseUrl(build)).toBe(
                TOPSKIP_PUBLIC_SERVER_BASE_URL,
            );
            expect(getServerAnalysisManifestMatch(build)).toBe(
                `${TOPSKIP_PUBLIC_SERVER_BASE_URL}/*`,
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
