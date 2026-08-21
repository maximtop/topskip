import * as v from 'valibot';

import {
    TopSkipBuild,
    getExtensionManifestName,
    validateServerOrigin,
    type TopSkipBuildMode,
} from './build-modes.ts';
import {
    DEV_E2E_CONTENT_SCRIPT_MATCH,
    DEV_E2E_ORIGIN,
    YOUTUBE_CONTENT_SCRIPT_MATCH,
    YOUTUBE_ORIGIN,
} from './src/shared/watch-route.ts';
import {
    OPTIONAL_PROVIDER_HOST_PERMISSIONS,
    PROVIDER_HOST_PERMISSION,
} from './src/shared/provider-host-permissions.ts';

/**
 * First Chrome release supporting declarative MAIN-world content scripts.
 */
export const TOPSKIP_MINIMUM_CHROME_VERSION = '111';

const providerOrigins = Object.values(PROVIDER_HOST_PERMISSION).map(
    (definition) => new URL(definition.origin).origin,
);
const RESERVED_SERVER_ORIGINS = new Set([
    YOUTUBE_ORIGIN,
    ...providerOrigins,
    DEV_E2E_ORIGIN,
]);

const nonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());
const sourceManifestSchema = v.looseObject({
    manifest_version: v.literal(3),
    name: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    description: v.optional(v.string()),
    default_locale: v.optional(nonEmptyStringSchema),
});

/**
 * Chrome fields whose complete identity controls bundle execution order.
 */
export const extensionContentScriptSchema = v.strictObject({
    matches: v.array(v.string()),
    js: v.array(v.string()),
    run_at: v.literal('document_start'),
    world: v.picklist(['MAIN', 'ISOLATED']),
    all_frames: v.boolean(),
    match_about_blank: v.boolean(),
    match_origin_as_fallback: v.boolean(),
});

/**
 * Packaging-boundary schema covering every security-sensitive emitted field.
 */
export const extensionManifestSchema = v.looseObject({
    manifest_version: v.literal(3),
    name: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    version_name: v.optional(nonEmptyStringSchema),
    minimum_chrome_version: v.literal(TOPSKIP_MINIMUM_CHROME_VERSION),
    permissions: v.array(v.string()),
    optional_permissions: v.array(v.string()),
    host_permissions: v.array(v.string()),
    optional_host_permissions: v.array(v.string()),
    content_scripts: v.array(extensionContentScriptSchema),
});

/**
 * Parsed emitted manifest shared by build and packaging validation.
 */
export type ExtensionManifest = v.InferOutput<typeof extensionManifestSchema>;

/**
 * Prevents the backend grant from overlapping a site/provider permission class
 * even when its origin is otherwise valid for the selected build profile.
 *
 * @param raw - Explicit backend origin passed to the manifest composer.
 */
function rejectReservedServerOrigin(raw: string): void {
    let origin: string;
    try {
        origin = new URL(raw).origin;
    } catch {
        return;
    }
    if (RESERVED_SERVER_ORIGINS.has(origin)) {
        throw new Error(`TopSkip server origin '${raw}' is reserved.`);
    }
}

/**
 * Seconds are enough to tell consecutive rebuilds apart in Chrome's UI.
 */
const ISO_TIMESTAMP_SECONDS_LENGTH = 'YYYY-MM-DDTHH:MM:SS'.length;

/**
 * Stamps the build time into the display version because unpacked and beta
 * installs are rebuilt under one manifest `version`, so only the stamp tells a
 * stale Chrome load from the latest artifact. Release keeps the bare version:
 * `version_name` replaces it in the Chrome UI and the store listing.
 *
 * @param build - Validated build profile.
 * @param version - Base manifest version.
 * @param builtAt - Build time, or `undefined` when only validating.
 * @returns Display version for dev/beta builds, otherwise `undefined`.
 */
export function composeVersionName(
    build: TopSkipBuildMode,
    version: string,
    builtAt: Date | undefined,
): string | undefined {
    if (builtAt === undefined || build === TopSkipBuild.Release) {
        return undefined;
    }
    const stamp = builtAt.toISOString().slice(0, ISO_TIMESTAMP_SECONDS_LENGTH);
    return `${version} (${build} build ${stamp}Z)`;
}

/**
 * Produces a fresh least-privilege manifest so stale source arrays can never
 * append access to a release artifact.
 *
 * @param source - Untrusted parsed base manifest JSON.
 * @param build - Validated build profile.
 * @param serverOrigin - Explicit backend origin for this artifact.
 * @param builtAt - Build time stamped into the dev/beta display version; omit
 * when only validating an existing artifact.
 * @returns Validated emitted manifest with exact permission and script arrays.
 */
export function composeExtensionManifest(
    source: unknown,
    build: TopSkipBuildMode,
    serverOrigin: string,
    builtAt?: Date,
): ExtensionManifest {
    const base = v.parse(sourceManifestSchema, source);
    rejectReservedServerOrigin(serverOrigin);
    const canonicalServerOrigin = validateServerOrigin(build, serverOrigin);
    const matches = [YOUTUBE_CONTENT_SCRIPT_MATCH];
    if (build === TopSkipBuild.Dev) {
        matches.push(DEV_E2E_CONTENT_SCRIPT_MATCH);
    }
    const versionName = composeVersionName(build, base.version, builtAt);

    return v.parse(extensionManifestSchema, {
        ...base,
        name: getExtensionManifestName(build),
        ...(versionName === undefined ? {} : { version_name: versionName }),
        minimum_chrome_version: TOPSKIP_MINIMUM_CHROME_VERSION,
        permissions: ['storage'],
        optional_permissions: [],
        host_permissions: [`${canonicalServerOrigin}/*`],
        optional_host_permissions: [...OPTIONAL_PROVIDER_HOST_PERMISSIONS],
        content_scripts: [
            {
                matches: [...matches],
                js: ['caption-page-bridge.js'],
                run_at: 'document_start',
                world: 'MAIN',
                all_frames: false,
                match_about_blank: false,
                match_origin_as_fallback: false,
            },
            {
                matches: [...matches],
                js: ['content.js'],
                run_at: 'document_start',
                world: 'ISOLATED',
                all_frames: false,
                match_about_blank: false,
                match_origin_as_fallback: false,
            },
        ],
    });
}
