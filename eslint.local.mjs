/**
 * @file Lint entries that only TopSkip needs: build and test output of the workspace packages, Node globals for the
 * backend and the build helpers, and a ban on plain block comments.
 */

import globals from 'globals';

const local = {
    rules: {
        // JSDoc (`/** … */`) and line comments (`//`) stay allowed; `jsdoc/multiline-blocks` only inspects JSDoc.
        'no-plain-block-comments': {
            meta: {
                type: 'suggestion',
                docs: { description: 'Disallow plain /* … */ block comments' },
                schema: [],
                messages: {
                    plainBlock: 'Avoid plain /* … */ block comments. Use // for inline notes or /** … */ for JSDoc.',
                },
            },
            create(context) {
                return {
                    Program() {
                        for (const comment of context.sourceCode.getAllComments()) {
                            // The value of a JSDoc comment starts with `*`: its source is `/** … */`.
                            if (comment.type === 'Block' && !comment.value.startsWith('*')) {
                                context.report({
                                    loc: comment.loc,
                                    messageId: 'plainBlock',
                                });
                            }
                        }
                    },
                };
            },
        },
    },
};

export default [
    {
        ignores: [
            'deployment-dist/',
            'extension/dist/',
            '**/coverage/',
            '**/test-results/',
            '**/tmp/',
        ],
    },
    {
        // The backend server and the build helpers that the scripts import run in Node.
        files: [
            'backend/**',
            'extension/build-modes.ts',
        ],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['**/*.{ts,tsx}'],
        plugins: { local },
        rules: {
            'local/no-plain-block-comments': 'error',
        },
    },
];
