import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rspack/cli';
import {
    Compilation,
    type Compiler,
    type RspackPluginInstance,
    rspack,
    sources,
} from '@rspack/core';

import { TopSkipBuild, type TopSkipBuildMode } from './build-modes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Local Playwright fixture origin (injected for `TOPSKIP_BUILD=dev` only). */
const DEV_LOCAL_MATCH = 'http://127.0.0.1:4173/*';

/**
 * Reads `TOPSKIP_BUILD`: `dev` (default) includes localhost for E2E fixtures;
 * `beta` / `release` are YouTube-only.
 *
 * @returns Normalized build mode
 */
function getTopSkipBuild(): TopSkipBuildMode {
    const raw = process.env.TOPSKIP_BUILD;
    if (raw === TopSkipBuild.Beta || raw === TopSkipBuild.Release) {
        return raw;
    }
    return TopSkipBuild.Dev;
}

/**
 * Adds dev-only manifest entries when building for local / CI browser tests.
 *
 * @param manifest - Parsed MV3 manifest (mutated when build is `dev`)
 * @param build - Active TopSkip build mode
 */
function applyDevLocalhostToManifest(
    manifest: {
        host_permissions?: string[];
        content_scripts?: Array<{ matches: string[] }>;
    },
    build: TopSkipBuildMode,
): void {
    if (build !== TopSkipBuild.Dev) {
        return;
    }
    const hostPermissions = manifest.host_permissions;
    if (!hostPermissions) {
        return;
    }
    if (!hostPermissions.includes(DEV_LOCAL_MATCH)) {
        hostPermissions.push(DEV_LOCAL_MATCH);
    }
    const firstContentScript = manifest.content_scripts?.[0];
    if (
        firstContentScript &&
        !firstContentScript.matches.includes(DEV_LOCAL_MATCH)
    ) {
        firstContentScript.matches.push(DEV_LOCAL_MATCH);
    }
}

/**
 * Emits `manifest.json` from `src/manifest.json` with optional dev-only
 * `127.0.0.1:4173` matches.
 *
 * @param build - Resolved `TOPSKIP_BUILD` value
 * @returns Rspack plugin
 */
function topSkipManifestPlugin(build: TopSkipBuildMode): RspackPluginInstance {
    return {
        name: 'TopSkipManifestPlugin',
        apply(compiler: Compiler) {
            compiler.hooks.thisCompilation.tap(
                'TopSkipManifestPlugin',
                (compilation) => {
                    compilation.hooks.processAssets.tap(
                        {
                            name: 'TopSkipManifestPlugin',
                            stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
                        },
                        () => {
                            const manifestPath = path.resolve(
                                __dirname,
                                'src/manifest.json',
                            );
                            compilation.fileDependencies.add(manifestPath);
                            const raw = fs.readFileSync(manifestPath, 'utf8');
                            const manifest = JSON.parse(raw) as {
                                host_permissions?: string[];
                                content_scripts?: Array<{ matches: string[] }>;
                            };
                            applyDevLocalhostToManifest(manifest, build);
                            const json = `${JSON.stringify(manifest, null, 2)}\n`;
                            compilation.emitAsset(
                                'manifest.json',
                                new sources.RawSource(json),
                            );
                        },
                    );
                },
            );
        },
    };
}

const topSkipBuildMode = getTopSkipBuild();

export default defineConfig({
    context: __dirname,
    entry: {
        background: './src/background/index.ts',
        content: './src/content/index.ts',
        popup: './src/popup/main.tsx',
        options: './src/options/main.tsx',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        clean: true,
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js'],
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: 'builtin:swc-loader',
                    options: {
                        jsc: {
                            parser: { syntax: 'typescript', tsx: true },
                            transform: { react: { runtime: 'automatic' } },
                        },
                    },
                },
            },
            {
                test: /\.css$/,
                use: [
                    rspack.CssExtractRspackPlugin.loader,
                    { loader: 'css-loader' },
                ],
                type: 'javascript/auto',
            },
        ],
    },
    plugins: [
        new rspack.CssExtractRspackPlugin({
            filename: '[name].css',
        }),
        new rspack.DefinePlugin({
            __TOPSKIP_INCLUDE_DEV_LOCAL__: JSON.stringify(
                topSkipBuildMode === TopSkipBuild.Dev,
            ),
        }),
        topSkipManifestPlugin(topSkipBuildMode),
        new rspack.HtmlRspackPlugin({
            template: './src/popup/index.html',
            filename: 'popup.html',
            chunks: ['popup'],
            inject: 'body',
        }),
        new rspack.HtmlRspackPlugin({
            template: './src/options/index.html',
            filename: 'options.html',
            chunks: ['options'],
            inject: 'body',
        }),
        new rspack.CopyRspackPlugin({
            patterns: [
                { from: 'src/public', to: '.', noErrorOnMissing: true },
                { from: 'src/_locales', to: '_locales' },
            ],
        }),
    ],
    // FIXME: Disable source maps for beta/release packaging; Chrome counts
    // emitted `.map` files in unpacked extension size.
    optimization: {
        // FIXME: Popup/options both import Mantine CSS; keeping split chunks off
        // duplicates that CSS across extension pages.
        splitChunks: false,
    },
});
