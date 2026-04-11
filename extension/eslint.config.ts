import eslint from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
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
      'max-len': [
        'error',
        {
          code: 80,
          tabWidth: 2,
          ignoreUrls: true,
        },
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
    files: ['src/**/*.{ts,tsx}'],
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
          checkConstructors: true,
          exemptEmptyConstructors: true,
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.ts'],
  },
);
