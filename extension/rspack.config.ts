import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { defineConfig } from '@rspack/cli';
import {
    Compilation,
    type Compiler,
    type RspackPluginInstance,
    rspack,
    sources,
} from '@rspack/core';

import {
    BUILD_MODE_ENV_VAR,
    INCLUDE_CHROME_BUILTIN_PROVIDER,
    TopSkipBuild,
    getDevE2eOrigin,
    getServerAnalysisBaseUrl,
    resolveTopSkipBuild,
    shouldEnableCaptionCaptureVerboseLogs,
    type TopSkipBuildMode,
} from './build-modes.ts';
import { composeExtensionManifest } from './manifest-profile.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The backend origin is configuration, not source. Local builds read it from
// the gitignored root `.env`; CI exports it instead.
loadDotEnv({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Emits `manifest.json` through the same exact profile boundary used by
 * packaging validation.
 *
 * @param build - Resolved `TOPSKIP_BUILD` value
 * @param serverOrigin - Explicit validated backend origin.
 * @returns Rspack plugin
 */
function topSkipManifestPlugin(
    build: TopSkipBuildMode,
    serverOrigin: string,
): RspackPluginInstance {
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
                            const source = JSON.parse(raw) as unknown;
                            const manifest = composeExtensionManifest(
                                source,
                                build,
                                serverOrigin,
                                new Date(),
                            );
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

const topSkipBuildMode = resolveTopSkipBuild(
    process.env[BUILD_MODE_ENV_VAR],
);
const topSkipServerOrigin = getServerAnalysisBaseUrl(topSkipBuildMode);

export default defineConfig({
    mode: topSkipBuildMode === TopSkipBuild.Dev ? 'development' : 'production',
    devtool: topSkipBuildMode === TopSkipBuild.Dev ? 'source-map' : false,
    context: __dirname,
    entry: {
        background: './src/background/index.ts',
        content: './src/content/index.ts',
        'caption-page-bridge': './src/content/captions/caption-page-bridge.ts',
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
                            target: 'es2022',
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
            __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__: JSON.stringify(
                shouldEnableCaptionCaptureVerboseLogs(topSkipBuildMode),
            ),
            __TOPSKIP_INCLUDE_DEV_LOCAL__: JSON.stringify(
                topSkipBuildMode === TopSkipBuild.Dev,
            ),
            __TOPSKIP_DEV_E2E_ORIGIN__: JSON.stringify(
                getDevE2eOrigin(topSkipBuildMode),
            ),
            __TOPSKIP_SERVER_BASE_URL__: JSON.stringify(
                topSkipServerOrigin,
            ),
            __TOPSKIP_INCLUDE_CHROME_BUILTIN__: JSON.stringify(
                INCLUDE_CHROME_BUILTIN_PROVIDER,
            ),
        }),
        topSkipManifestPlugin(topSkipBuildMode, topSkipServerOrigin),
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
                {
                    from: 'src/public',
                    to: '.',
                    noErrorOnMissing: true,
                    globOptions: {
                        ignore: ['**/.DS_Store', '**/.gitkeep'],
                    },
                },
                { from: 'src/_locales', to: '_locales' },
            ],
        }),
    ],
    optimization: {
        // FIXME: Popup/options both import Mantine CSS; keeping split chunks off
        // duplicates that CSS across extension pages.
        splitChunks: false,
    },
});
