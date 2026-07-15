import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rspack/cli';

const DEPLOY_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIRECTORY = path.resolve(DEPLOY_DIRECTORY, '..');

export default defineConfig({
    mode: 'production',
    target: 'node',
    context: WORKSPACE_DIRECTORY,
    entry: './backend/src/server.ts',
    output: {
        path: path.resolve(WORKSPACE_DIRECTORY, 'deployment-dist'),
        filename: 'server.mjs',
        clean: true,
        module: true,
        chunkFormat: 'module',
        library: { type: 'module' },
    },
    experiments: {
        outputModule: true,
    },
    externalsPresets: {
        node: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            '@topskip/backend': path.resolve(
                WORKSPACE_DIRECTORY,
                'backend/src',
            ),
            '@topskip/common': path.resolve(WORKSPACE_DIRECTORY, 'common/src'),
        },
    },
    module: {
        parser: {
            javascript: {
                importMeta: false,
            },
        },
        rules: [
            {
                test: /\.ts$/u,
                exclude: /node_modules/u,
                use: {
                    loader: 'builtin:swc-loader',
                    options: {
                        jsc: {
                            parser: { syntax: 'typescript' },
                            target: 'es2022',
                        },
                    },
                },
            },
        ],
    },
    optimization: {
        minimize: false,
    },
    devtool: false,
});
