import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
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
    // ESLint Stylistic owns formatting. Unlike a real formatter it never
    // reflows code, so `max-len` only reports over-long lines — wrap by hand.
    stylistic.configs.customize({
        indent: 4,
        quotes: 'single',
        semi: true,
        jsx: true,
        commaDangle: 'always-multiline',
        braceStyle: '1tbs',
        arrowParens: true,
    }),
    {
        rules: {
            // Continuation operators stay at end of line (`a &&` / `const x =`),
            // while ternary branches and type-union members lead their line.
            '@stylistic/operator-linebreak': [
                'error',
                'after',
                {
                    overrides: {
                        '?': 'before',
                        ':': 'before',
                        '|': 'before',
                        '&': 'before',
                    },
                },
            ],
            // Quote only the keys that require quoting (e.g. `pt_BR`).
            '@stylistic/quote-props': ['error', 'as-needed'],
            // Double quotes are allowed when they avoid escaping (`"don't"`).
            '@stylistic/quotes': [
                'error',
                'single',
                { avoidEscape: true, allowTemplateLiterals: 'never' },
            ],
            '@stylistic/jsx-quotes': ['error', 'prefer-double'],
            '@stylistic/linebreak-style': ['error', 'unix'],
            // Multi-line union/intersection members carry a hanging indent that
            // `indent` cannot model; `operator-linebreak` still anchors them.
            '@stylistic/indent': [
                'error',
                4,
                {
                    ArrayExpression: 1,
                    CallExpression: { arguments: 1 },
                    flatTernaryExpressions: false,
                    FunctionDeclaration: { body: 1, parameters: 1, returnType: 1 },
                    FunctionExpression: { body: 1, parameters: 1, returnType: 1 },
                    ignoreComments: false,
                    ignoredNodes: [
                        'TSUnionType',
                        'TSIntersectionType',
                        'TSUnionType *',
                        'TSIntersectionType *',
                    ],
                    ImportDeclaration: 1,
                    MemberExpression: 1,
                    ObjectExpression: 1,
                    offsetTernaryExpressions: true,
                    outerIIFEBody: 1,
                    SwitchCase: 1,
                    tabLength: 4,
                    VariableDeclarator: 1,
                },
            ],
            // Continuation indent of long binary expressions: the previous
            // formatter aligned these its own way and this rule disagrees
            // without adding safety. `indent` still governs the enclosing block.
            '@stylistic/indent-binary-ops': 'off',
            // JSX conditionals are written as `cond ? (\n…\n) : (\n…\n)`, which
            // this rule rejects on principle rather than for readability.
            '@stylistic/multiline-ternary': 'off',
            // 80 columns stays the target to write to, but it can only be a
            // target now: nothing reflows code, and the previous formatter
            // treated 80 as a soft width it exceeded for unbreakable spans
            // (long member chains, deep JSX). 100 is the hard ceiling that
            // still catches runaway lines. Comments are exempt because prose
            // was never wrapped and 300 JSDoc lines already pass 80.
            '@stylistic/max-len': [
                'error',
                {
                    code: 100,
                    tabWidth: 4,
                    ignoreComments: true,
                    ignoreUrls: true,
                    ignoreStrings: true,
                    ignoreTemplateLiterals: true,
                    ignoreRegExpLiterals: true,
                },
            ],
        },
    },
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
            '@stylistic/padded-blocks': [
                'error',
                { classes: 'never' },
                { allowSingleLineBlocks: true },
            ],
        },
    },
    {
        files: [
            'extension/build-modes.ts',
            'extension/rspack.config.ts',
            'vitest.config.ts',
            'extension/playwright.config.ts',
            'extension/e2e/**/*.ts',
            'backend/tests/**/*.ts',
            'common/tests/**/*.ts',
            'extension/tests/**/*.ts',
            'scripts/**/*.ts',
            'tasks/**/*.ts',
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
            'backend/src/**/*.ts',
            'common/src/**/*.ts',
            'extension/src/**/*.{ts,tsx}',
            'backend/tests/**/*.ts',
            'common/tests/**/*.ts',
            'extension/tests/**/*.ts',
            'extension/e2e/**/*.ts',
            'scripts/**/*.ts',
            'tasks/**/*.ts',
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
        files: [
            'backend/src/**/*.ts',
            'common/src/**/*.ts',
            'extension/src/**/*.{ts,tsx}',
        ],
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
            'deployment-dist/**',
            'extension/dist/**',
            'node_modules/**',
            '**/coverage/**',
            'eslint.config.ts',
            '**/tmp/**',
        ],
    },
);
