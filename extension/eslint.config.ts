import eslint from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Local ESLint plugin: bans plain `/* … *\/` block comments.
 *
 * JSDoc comments (`/** … *\/`) and line comments (`//`) are allowed.
 * This complements `jsdoc/multiline-blocks`, which only inspects JSDoc.
 */
const localPlugin = {
    rules: {
        'no-plain-block-comments': {
            meta: {
                type: 'suggestion',
                docs: { description: 'Disallow plain /* … */ block comments' },
                schema: [],
                messages: {
                    plainBlock:
                        'Avoid plain /* … */ block comments. Use // for inline notes ' +
                        'or /** … */ for JSDoc.',
                },
            },
            create(context: {
                sourceCode: {
                    getAllComments(): Array<{
                        type: string;
                        value: string;
                        loc: unknown;
                    }>;
                };
                report(descriptor: unknown): void;
            }) {
                return {
                    Program() {
                        for (const comment of context.sourceCode.getAllComments()) {
                            if (comment.type !== 'Block') continue;
                            // JSDoc comments start with `*` (i.e. source is `/** … */`).
                            if (comment.value.startsWith('*')) continue;
                            context.report({
                                loc: comment.loc,
                                messageId: 'plainBlock',
                            });
                        }
                    },
                };
            },
        },
    },
};

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        plugins: { local: localPlugin },
    },
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.browser,
                ...globals.es2022,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            // Use `@typescript-eslint` implementation (TS-aware private constructor, etc.).
            'no-empty-function': 'off',
            '@typescript-eslint/no-empty-function': [
                'error',
                {
                    // Disallows `constructor() {}` (including `private constructor() {}`).
                    // `arrowFunctions`: no-op callbacks remain valid.
                    allow: ['arrowFunctions'],
                },
            ],
            // Shallow control flow: discourages deep nesting (use early returns / guards).
            'max-depth': ['error', 5],
            // When a branch returns, drop redundant `else` so the main path stays flat.
            'no-else-return': 'error',
            // No blank line immediately inside `class { ... }` (after `{` / before `}`).
            'padded-blocks': [
                'error',
                { classes: 'never' },
                { allowSingleLineBlocks: true },
            ],
        },
    },
    {
        files: [
            'build-modes.ts',
            'rspack.config.ts',
            'vitest.config.ts',
            'playwright.config.ts',
            'e2e/**/*.ts',
            'tests/**/*.ts',
            'scripts/**/*.ts',
        ],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        plugins: { 'react-hooks': reactHooks },
        rules: { ...reactHooks.configs.recommended.rules },
    },
    {
        files: [
            'src/**/*.{ts,tsx}',
            'tests/**/*.ts',
            'e2e/**/*.ts',
            'scripts/**/*.ts',
        ],
        plugins: { jsdoc },
        settings: {
            jsdoc: {
                mode: 'typescript',
            },
        },
        rules: {
            'jsdoc/multiline-blocks': [
                'error',
                {
                    noSingleLineBlocks: true,
                },
            ],
            // Plain `/* … */` block comments are neither JSDoc nor line comments.
            // Force authors to pick one: `//` for inline rationale, `/** … */` for
            // documentation. Keeps comment style consistent across the codebase.
            'local/no-plain-block-comments': 'error',
        },
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        plugins: { jsdoc },
        settings: {
            jsdoc: {
                mode: 'typescript',
            },
        },
        rules: {
            'jsdoc/require-param': [
                'error',
                {
                    checkDestructured: false,
                    checkDestructuredRoots: false,
                },
            ],
            'jsdoc/require-returns': [
                'error',
                {
                    checkGetters: false,
                    forceReturnsWithAsync: true,
                },
            ],
            'jsdoc/require-jsdoc': [
                'error',
                {
                    enableFixer: true,
                    require: {
                        ArrowFunctionExpression: false,
                        ClassDeclaration: false,
                        FunctionDeclaration: true,
                        FunctionExpression: false,
                        MethodDefinition: true,
                    },
                    // Class fields and type aliases describe public contracts
                    // that otherwise lack nearby prose.
                    contexts: ['PropertyDefinition', 'TSTypeAliasDeclaration'],
                    checkConstructors: true,
                    exemptEmptyConstructors: true,
                },
            ],
            // Block must include prose before tags (not only @param / @returns).
            'jsdoc/require-description': [
                'error',
                {
                    descriptionStyle: 'body',
                    checkConstructors: false,
                    checkGetters: false,
                    checkSetters: false,
                },
            ],
            // Type assertions: allow only `as type` (never angle-bracket syntax),
            // and forbid `{} as X` object-literal assertions so all new code must use
            // narrowing, type guards, or `satisfies` instead.
            '@typescript-eslint/consistent-type-assertions': [
                'error',
                {
                    assertionStyle: 'as',
                    objectLiteralTypeAssertions: 'never',
                },
            ],
        },
    },
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'coverage/**',
            'eslint.config.ts',
            'tasks/**',
            'tmp/**',
        ],
    },
);
