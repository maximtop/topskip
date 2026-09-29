/**
 * @file CLI and library entry point that validates a built extension
 * manifest against the permission/host/content-script policy for a given
 * build profile, so a manifest that drifted from its profile fails CI
 * instead of shipping.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import * as v from 'valibot';

import {
    resolveTopSkipBuild,
    type TopSkipBuildMode,
} from '@topskip/extension/build-modes';
import {
    composeExtensionManifest,
    extensionManifestSchema,
} from '@topskip/extension/manifest-profile';

const CLI_ARGUMENT_COUNT = 6;
const CLI_ERROR_MAX_LENGTH = 260;
const MANIFEST_PATH_FLAG = '--manifest';
const BUILD_FLAG = '--build';
const SERVER_ORIGIN_FLAG = '--server-origin';
const SUCCESS_MESSAGE = 'Extension manifest is valid.';
const FAILURE_PREFIX = 'Extension manifest policy failed: ';

const backgroundSchema = v.strictObject({
    service_worker: v.literal('background.js'),
});
const manifestBackgroundSchema = v.looseObject({
    background: backgroundSchema,
});

/**
 * Build profile and backend origin the emitted manifest must match.
 */
interface ValidatorExpectation {
    /**
     * Build profile (dev/beta/release) the artifact was produced for.
     */
    build: TopSkipBuildMode;

    /**
     * Backend origin the composed manifest's host permissions must target.
     */
    serverOrigin: string;
}

/**
 * Parsed and validated `--build`/`--server-origin`/`--manifest` CLI values.
 */
interface CliArguments {
    /**
     * Build profile resolved from `--build`.
     */
    build: TopSkipBuildMode;

    /**
     * Backend origin from `--server-origin`.
     */
    serverOrigin: string;

    /**
     * Filesystem path to the manifest JSON to validate, from `--manifest`.
     */
    manifestPath: string;
}

/**
 * Rejects duplicate set members before equality comparison can hide them.
 *
 * @param field - Manifest field used in the policy error.
 * @param actual - Values read from the emitted artifact.
 * @param expected - Exact values allowed for the selected build profile.
 *
 * @throws {Error} When `actual` has duplicates or does not equal `expected` as a set.
 */
function assertExactSet(
    field: string,
    actual: readonly string[],
    expected: readonly string[],
): void {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    if (actualSet.size !== actual.length) {
        throw new Error(`${field} contains duplicate entries.`);
    }
    const hasExactSize = actualSet.size === expectedSet.size;
    const containsOnlyExpected = [...actualSet].every((value) => expectedSet.has(value));
    if (!hasExactSize || !containsOnlyExpected) {
        throw new Error(`${field} does not match the selected build profile.`);
    }
}

/**
 * Prevents a host from being both implicit and user-granted access.
 *
 * @param required - Required host permissions in the artifact.
 * @param optional - Optional host permissions in the artifact.
 *
 * @throws {Error} When a host appears in both `required` and `optional`.
 */
function assertNoHostOverlap(
    required: readonly string[],
    optional: readonly string[],
): void {
    const optionalHosts = new Set(optional);
    if (required.some((host) => optionalHosts.has(host))) {
        throw new Error(
            'Required and optional host permissions must not overlap.',
        );
    }
}

/**
 * Preserves MAIN-before-ISOLATED execution while treating match glob order as
 * set-like browser policy rather than a separate execution identity.
 *
 * @param actual - Content scripts emitted by the artifact.
 * @param expected - Exact profile scripts composed from trusted inputs.
 *
 * @throws {Error} When the count, matches, or other fields of any content script diverge from `expected`.
 */
function assertContentScripts(
    actual: v.InferOutput<typeof extensionManifestSchema>['content_scripts'],
    expected: v.InferOutput<typeof extensionManifestSchema>['content_scripts'],
): void {
    if (actual.length !== expected.length) {
        throw new Error(
            'content_scripts does not match the selected build profile.',
        );
    }
    for (const [index, actualScript] of actual.entries()) {
        const expectedScript = expected[index];
        if (expectedScript === undefined) {
            throw new Error(
                'content_scripts does not match the selected build profile.',
            );
        }
        assertExactSet(
            `content_scripts[${String(index)}].matches`,
            actualScript.matches,
            expectedScript.matches,
        );
        const actualExecution = {
            ...actualScript,
            matches: expectedScript.matches,
        };
        if (!isDeepStrictEqual(actualExecution, expectedScript)) {
            throw new Error(
                'content_scripts does not match the selected build profile.',
            );
        }
    }
}

/**
 * Enforces the complete permission and execution policy on an emitted build
 * artifact rather than trusting its source manifest or build configuration.
 *
 * @param input - Parsed manifest JSON from the real build artifact.
 * @param expected - Profile and backend origin selected for that build.
 *
 * @throws {Error} When any policy check (schema, name, permissions, hosts, content scripts) fails.
 */
export function validateExtensionManifest(
    input: unknown,
    expected: ValidatorExpectation,
): void {
    const actual = v.parse(extensionManifestSchema, input);
    v.parse(manifestBackgroundSchema, input);
    const target = composeExtensionManifest(
        {
            manifest_version: 3,
            name: '__MSG_name__',
            version: actual.version,
        },
        expected.build,
        expected.serverOrigin,
    );

    if (actual.name !== target.name) {
        throw new Error('name does not match the selected build profile.');
    }

    assertExactSet('permissions', actual.permissions, target.permissions);
    assertExactSet(
        'optional_permissions',
        actual.optional_permissions,
        target.optional_permissions,
    );
    assertExactSet(
        'host_permissions',
        actual.host_permissions,
        target.host_permissions,
    );
    assertExactSet(
        'optional_host_permissions',
        actual.optional_host_permissions,
        target.optional_host_permissions,
    );
    assertNoHostOverlap(
        actual.host_permissions,
        actual.optional_host_permissions,
    );
    assertContentScripts(actual.content_scripts, target.content_scripts);
}

/**
 * Keeps the executable boundary deliberately small so unknown or repeated
 * options cannot silently change the artifact policy.
 *
 * @param args - User arguments after the executable path.
 *
 * @returns Validated CLI values.
 *
 * @throws {Error} When a flag is unknown, repeated, missing its value, or a required flag is absent.
 */
function parseCliArguments(args: string[]): CliArguments {
    const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
    if (normalizedArgs.length !== CLI_ARGUMENT_COUNT) {
        throw new Error(
            'Expected --build, --server-origin, and --manifest exactly once.',
        );
    }
    const values = new Map<string, string>();
    for (let index = 0; index < normalizedArgs.length; index += 2) {
        const flag = normalizedArgs[index];
        const value = normalizedArgs[index + 1];
        const isKnownFlag = flag === BUILD_FLAG
            || flag === SERVER_ORIGIN_FLAG
            || flag === MANIFEST_PATH_FLAG;
        if (
            !isKnownFlag
            || value === undefined
            || value === ''
            || values.has(flag)
        ) {
            throw new Error(
                'Expected --build, --server-origin, and --manifest exactly once.',
            );
        }
        values.set(flag, value);
    }
    const rawBuild = values.get(BUILD_FLAG);
    const serverOrigin = values.get(SERVER_ORIGIN_FLAG);
    const manifestPath = values.get(MANIFEST_PATH_FLAG);
    if (serverOrigin === undefined || manifestPath === undefined) {
        throw new Error(
            'Expected --build, --server-origin, and --manifest exactly once.',
        );
    }
    return {
        build: resolveTopSkipBuild(rawBuild),
        serverOrigin,
        manifestPath,
    };
}

/**
 * Bounds unexpected parser and filesystem messages before writing them to CI
 * logs while retaining enough policy context to diagnose a failed artifact.
 *
 * @param error - Unknown failure from argument, file, JSON, or policy parsing.
 *
 * @returns One single-line bounded diagnostic.
 */
function formatCliError(error: unknown): string {
    const message = error instanceof Error
        ? error.message
        : 'Unknown manifest validation failure.';
    const normalized = message.replaceAll(/\s+/gu, ' ').trim();
    const availableLength = CLI_ERROR_MAX_LENGTH - FAILURE_PREFIX.length;
    return `${FAILURE_PREFIX}${normalized.slice(0, availableLength)}`;
}

/**
 * Validates one on-disk build artifact and reports a process-compatible code
 * without terminating callers that import this module.
 *
 * @param args - CLI arguments after the executable path.
 *
 * @returns Zero for a valid artifact, otherwise one.
 */
export async function main(args: string[]): Promise<number> {
    try {
        const parsed = parseCliArguments(args);
        const rawManifest = await fs.readFile(parsed.manifestPath, 'utf8');
        const manifest = JSON.parse(rawManifest) as unknown;
        validateExtensionManifest(manifest, {
            build: parsed.build,
            serverOrigin: parsed.serverOrigin,
        });
        console.log(SUCCESS_MESSAGE);
        return 0;
    } catch (error: unknown) {
        console.error(formatCliError(error));
        return 1;
    }
}

const entryPath = path.resolve(process.argv[1] ?? '');
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
    process.exitCode = await main(process.argv.slice(2));
}
