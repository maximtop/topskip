# Implementation Plan: Evaluate ESLint Replacement With Oxfmt And Oxlint

**Created**: 2026-05-08
**Status**: Validated (staged; ESLint retained)
**Model**: GitHub Copilot
**Type**: Configuration
**Input**: replace eslint with oxfmt and oxlint?

## Problem

The repository currently enforces code quality through `pnpm run lint`, which
runs ESLint, markdownlint, and `tsc --noEmit`. The user wants to know whether
ESLint can be replaced by `oxfmt` and `oxlint`, especially so indentation and
formatting are enforced consistently instead of relying only on VS Code editor
settings.

## Research Findings

TopSkip is a Chrome MV3 extension using TypeScript, React, Mantine, MobX,
Rspack, Vitest, and Playwright. The enforced lint command is documented in
`README.md`, `DEVELOPMENT.md`, `AGENTS.md`, `package.json`, `Makefile`, and
`.github/workflows/ci.yml`.

Current `package.json` scripts:

```json
{
    "lint": "eslint . && pnpm run lint:md && pnpm run lint:types",
    "lint:md": "markdownlint-cli2 \"**/*.md\" \"#node_modules\" \"#dist\" \"#coverage\" \"#.sdd\" \"#test-results\"",
    "lint:types": "tsc --noEmit"
}
```

Current ESLint responsibilities in `eslint.config.ts`:

```ts
'@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
],
'no-empty-function': 'off',
'@typescript-eslint/no-empty-function': [
    'error',
    { allow: ['arrowFunctions'] },
],
'max-depth': ['error', 5],
'no-else-return': 'error',
'padded-blocks': [
    'error',
    { classes: 'never' },
    { allowSingleLineBlocks: true },
],
'max-len': [
    'error',
    { code: 80, tabWidth: 4, ignoreUrls: true },
],
'jsdoc/multiline-blocks': ['error', { noSingleLineBlocks: true }],
'local/no-plain-block-comments': 'error',
'jsdoc/require-param': [
    'error',
    { checkDestructured: false, checkDestructuredRoots: false },
],
'jsdoc/require-returns': [
    'error',
    { checkGetters: false, forceReturnsWithAsync: true },
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
        contexts: ['PropertyDefinition'],
        checkConstructors: true,
        exemptEmptyConstructors: true,
    },
],
'jsdoc/require-description': [
    'error',
    {
        descriptionStyle: 'body',
        checkConstructors: false,
        checkGetters: false,
        checkSetters: false,
    },
],
'@typescript-eslint/consistent-type-assertions': [
    'error',
    { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
],
```

`oxfmt` is the formatter. It supports `--check`, `--write`, `tabWidth`,
`printWidth`, `singleQuote`, `trailingComma`, and `.editorconfig`-style
formatting concerns. It can catch existing 2-space indentation when configured
for 4 spaces.

`oxlint` is the linter. It is faster than ESLint and supports many ESLint,
TypeScript, React, JSDoc, and plugin rules. It also has `@oxlint/migrate` for
ESLint flat config migration, with `--type-aware`, `--js-plugins`, and
`--details`. It does not automatically remove the need for `tsc --noEmit`, and
rule parity must be checked before deleting ESLint.

### Root Cause

ESLint does not currently catch 2-space indentation because the repo has no
indent rule and no formatter check. VS Code settings and `.editorconfig` guide
editing, but they do not enforce formatting in CI.

A direct ESLint removal would also drop repo-specific checks unless oxlint
migration proves parity. The riskiest checks are:

- Local custom ESLint rule `local/no-plain-block-comments`.
- JSDoc requirements for params, returns, descriptions, and multi-line blocks.
- TypeScript assertion policy from `@typescript-eslint/consistent-type-assertions`.
- React hooks recommended rules.
- `max-depth`, `no-else-return`, `padded-blocks`, and `max-len` style gates.
- Existing `eslint-disable-next-line` comments that may need oxlint equivalents.

### Patterns to Follow

- Keep `pnpm run lint` as the single CI quality gate.
- Keep `pnpm run lint:md` and `pnpm run lint:types`; `oxlint` does not replace
  markdownlint or the TypeScript compiler.
- Use pnpm dev dependencies.
- Update docs when commands change.
- Avoid huge behavior changes hidden inside tooling migration.
- Use a staged migration: formatter first, oxlint second, ESLint removal only
  after parity is proven.

### Edge Cases

- Running `oxfmt` repo-wide will create a large mechanical diff because current
  TypeScript files use 2-space indentation.
- `oxfmt` may also wrap lines, normalize package JSON, sort imports, or format
  Markdown unless configured narrowly.
- `oxlint` migration may not preserve the local custom ESLint plugin rule.
- Inline `eslint-disable-next-line` comments may stop suppressing diagnostics
  after ESLint removal.
- CI must still run `tsc --noEmit`; oxlint is not the project typecheck.
- Editor diagnostics may differ until VS Code extensions/settings are updated.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `package.json` | Modify | Add `oxfmt`, `oxlint`, scripts, and staged lint command. |
| `pnpm-lock.yaml` | Modify | Lock new dev dependencies. |
| `.oxfmtrc.json` | Create | Configure formatter: 4 spaces, 80-column wrap, no import/package sorting surprises. |
| `.oxlintrc.json` | Create | Configure oxlint rules and ignore patterns generated from ESLint migration. |
| `eslint.config.ts` | Keep initially | Retain only until oxlint parity is proven. |
| `.github/workflows/ci.yml` | Usually unchanged | CI already calls `pnpm run lint`; only update if scripts split. |
| `README.md` | Modify | Update command description. |
| `DEVELOPMENT.md` | Modify | Document formatter and new lint pipeline. |
| `AGENTS.md` | Modify | Update contributor guidance for oxlint/oxfmt. |
| `src/**/*.ts`, `src/**/*.tsx`, `tests/**/*.ts`, `e2e/**/*.ts`, `scripts/**/*.ts` | Modify | Mechanical formatting after `oxfmt --write`. |

## Solution

Use `oxfmt` to enforce formatting and indentation. Use `oxlint` as the primary
fast linter, but keep ESLint temporarily as a parity backstop. Remove ESLint in a
follow-up only after the oxlint config catches the same required failures or the
team accepts dropping specific rules.

Recommended first implementation:

```json
{
    "scripts": {
        "format": "oxfmt .",
        "format:check": "oxfmt --check .",
        "lint": "pnpm run format:check && pnpm run lint:ox && pnpm run lint:eslint && pnpm run lint:md && pnpm run lint:types",
        "lint:eslint": "eslint .",
        "lint:md": "markdownlint-cli2 \"**/*.md\" \"#node_modules\" \"#dist\" \"#coverage\" \"#.sdd\" \"#test-results\"",
        "lint:ox": "oxlint --jsdoc-plugin --react-plugin --vitest-plugin .",
        "lint:types": "tsc --noEmit"
    }
}
```

After parity is proven, replace the lint command with:

```json
{
    "scripts": {
        "lint": "pnpm run format:check && pnpm run lint:ox && pnpm run lint:md && pnpm run lint:types"
    }
}
```

### Alternatives Considered

- Add ESLint indent rule only: smaller change, but does not format or enforce
  full formatting. Also ESLint core formatting rules are not the preferred path.
- Replace ESLint immediately: fastest dependency cleanup, but risks silently
  losing JSDoc, React hooks, custom comment, and type assertion policies.
- Add only `oxfmt`: fixes indentation enforcement, but does not replace linting.

## Tasks

### [x] Task 1: Prove Formatter Failure On Existing Indentation

**Files:**

- Read: `src/background/captions/watch-url.ts`
- Read: `.editorconfig`
- Read: `.vscode/settings.json`

- [x] **Step 1: Run formatting check before adding scripts**

Run:

```bash
pnpm dlx oxfmt --check src/background/captions/watch-url.ts
```

Expected: FAIL because `watch-url.ts` currently has 2-space indentation while
project settings require 4 spaces.

- [x] **Step 2: Confirm lint still passes before migration**

Run:

```bash
pnpm run lint
```

Expected: PASS. This proves the current gap: ESLint does not enforce
indentation.

**Verification**: Formatter check fails for formatting; lint passes before the
formatter is introduced into the enforced pipeline.

### [x] Task 2: Add Oxfmt Configuration

**Files:**

- Create: `.oxfmtrc.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Add formatter dependency**

Run:

```bash
pnpm add -D oxfmt
```

Expected: `package.json` and `pnpm-lock.yaml` include `oxfmt`.

- [x] **Step 2: Create formatter config**

Create `.oxfmtrc.json`:

```json
{
    "printWidth": 80,
    "tabWidth": 4,
    "useTabs": false,
    "singleQuote": true,
    "jsxSingleQuote": false,
    "semi": true,
    "trailingComma": "all",
    "bracketSpacing": true,
    "bracketSameLine": false,
    "arrowParens": "always",
    "endOfLine": "lf",
    "insertFinalNewline": true,
    "proseWrap": "preserve",
    "sortImports": false,
    "sortPackageJson": false,
    "ignorePatterns": [
        "dist/**",
        "node_modules/**",
        "coverage/**",
        "test-results/**",
        "playwright-report/**",
        ".sdd/**"
    ]
}
```

- [x] **Step 3: Add formatter scripts**

Change the `scripts` section in `package.json` to include:

```json
{
    "format": "oxfmt .",
    "format:check": "oxfmt --check ."
}
```

Keep all existing scripts.

- [x] **Step 4: Verify formatter catches current repo state**

Run:

```bash
pnpm run format:check
```

Expected: FAIL with files listed as not formatted.

**Verification**: `pnpm run format:check` exists and fails until mechanical
formatting is applied.

### [x] Task 3: Apply Mechanical Formatting

**Files:**

- Modify: `src/**/*.ts`
- Modify: `src/**/*.tsx`
- Modify: `tests/**/*.ts`
- Modify: `e2e/**/*.ts`
- Modify: `scripts/**/*.ts`
- Modify: `package.json` only if oxfmt touches it despite `sortPackageJson: false`

- [x] **Step 1: Format repository**

Run:

```bash
pnpm run format
```

Expected: files are rewritten with 4-space indentation and 80-column wrapping.

- [x] **Step 2: Check mechanical diff**

Run:

```bash
git diff --stat
```

Expected: large mechanical diff. No behavior-only edits should be mixed into
this task.

- [x] **Step 3: Verify formatter passes**

Run:

```bash
pnpm run format:check
```

Expected: PASS.

- [x] **Step 4: Verify current lint and tests still pass**

Run:

```bash
pnpm run lint
pnpm run test
```

Expected: both PASS.

**Verification**: Formatting is fully applied, current ESLint/markdownlint/type
checks still pass, and unit tests still pass.

### [x] Task 4: Add Oxlint In Parallel

**Files:**

- Create: `.oxlintrc.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Add linter dependency**

Run:

```bash
pnpm add -D oxlint
```

Expected: `package.json` and `pnpm-lock.yaml` include `oxlint`.

- [x] **Step 2: Generate oxlint config from ESLint**

Run:

```bash
pnpm dlx @oxlint/migrate eslint.config.ts --output-file .oxlintrc.json --type-aware --details
```

Expected: `.oxlintrc.json` is created. Terminal output lists any unsupported
rules that need manual handling.

- [x] **Step 3: Ensure ignore patterns are present**

If migration does not add them, add these entries to `.oxlintrc.json`:

```json
{
    "ignorePatterns": [
        "dist/**",
        "node_modules/**",
        "coverage/**",
        "eslint.config.ts",
        "tasks/**"
    ]
}
```

If `.oxlintrc.json` already has `ignorePatterns`, merge these strings into that
array instead of replacing other generated keys.

- [x] **Step 4: Add oxlint script**

Add this script to `package.json`:

```json
{
    "lint:ox": "oxlint --jsdoc-plugin --react-plugin --vitest-plugin ."
}
```

- [x] **Step 5: Run oxlint**

Run:

```bash
pnpm run lint:ox
```

Expected: PASS, or actionable diagnostics that are either real issues or rule
parity differences to configure.

**Verification**: Oxlint runs successfully from pnpm and has a committed config.

### [x] Task 5: Keep ESLint As Temporary Parity Backstop

**Files:**

- Modify: `package.json`
- Keep: `eslint.config.ts`

- [x] **Step 1: Split existing ESLint command**

Change scripts in `package.json` to:

```json
{
    "lint": "pnpm run format:check && pnpm run lint:ox && pnpm run lint:eslint && pnpm run lint:md && pnpm run lint:types",
    "lint:eslint": "eslint .",
    "lint:md": "markdownlint-cli2 \"**/*.md\" \"#node_modules\" \"#dist\" \"#coverage\" \"#.sdd\" \"#test-results\"",
    "lint:ox": "oxlint --jsdoc-plugin --react-plugin --vitest-plugin .",
    "lint:types": "tsc --noEmit"
}
```

Keep `format` and `format:check` from Task 2.

- [x] **Step 2: Verify combined lint gate**

Run:

```bash
pnpm run lint
```

Expected: PASS.

**Verification**: CI still uses `pnpm run lint`, and the new gate includes
formatting, oxlint, legacy ESLint parity checks, markdownlint, and TypeScript.

### [x] Task 6: Prove Or Document Rule Parity Before Removing ESLint

**Files:**

- Create: `tmp/lint-parity/README.md` for local scratch only, then delete before commit
- Modify: `.oxlintrc.json`
- Modify: `package.json` only after parity is proven

- [x] **Step 1: Check custom block comment behavior**

Create a temporary file `tmp/lint-parity/plain-block-comment.ts`:

```ts
/* plain block comment */
export const value = 1;
```

Run:

```bash
pnpm run lint:eslint -- tmp/lint-parity/plain-block-comment.ts
pnpm run lint:ox -- tmp/lint-parity/plain-block-comment.ts
```

Expected: ESLint FAILS with `local/no-plain-block-comments`. Oxlint must also
FAIL with an equivalent rule before ESLint can be removed. If oxlint cannot
catch this rule, keep ESLint or implement an oxlint JS plugin.

- [x] **Step 2: Check JSDoc required-param behavior**

Create `tmp/lint-parity/missing-param.ts`:

```ts
/**
 * Returns input for parity testing.
 *
 * @returns Input value.
 */
export function missingParam(value: string): string {
    return value;
}
```

Run:

```bash
pnpm run lint:eslint -- tmp/lint-parity/missing-param.ts
pnpm run lint:ox -- tmp/lint-parity/missing-param.ts
```

Expected: both FAIL for missing `@param value` before ESLint can be removed.

- [x] **Step 3: Check type assertion behavior**

Create `tmp/lint-parity/object-assertion.ts`:

```ts
const value = {} as { ok: boolean };

export const ok = value.ok;
```

Run:

```bash
pnpm run lint:eslint -- tmp/lint-parity/object-assertion.ts
pnpm run lint:ox -- tmp/lint-parity/object-assertion.ts
```

Expected: both FAIL for object-literal type assertion before ESLint can be
removed.

- [x] **Step 4: Check React hooks behavior**

Create `tmp/lint-parity/bad-hook.tsx`:

```tsx
import { useEffect } from 'react';

export function BadHook({ enabled }: { enabled: boolean }): null {
    if (enabled) {
        useEffect(() => undefined, []);
    }

    return null;
}
```

Run:

```bash
pnpm run lint:eslint -- tmp/lint-parity/bad-hook.tsx
pnpm run lint:ox -- tmp/lint-parity/bad-hook.tsx
```

Expected: both FAIL for hooks rule violation before ESLint can be removed.

- [x] **Step 5: Delete temporary parity files**

Run:

```bash
rm -rf tmp/lint-parity
```

Expected: no temporary parity files remain in `git status`.

**Verification**: ESLint removal is allowed only if oxlint catches the same
policy failures or the team explicitly accepts dropping a rule.

### [ ] Task 7: Remove ESLint Only After Parity Is Proven

Not executed. Parity checks showed oxlint does not catch
`local/no-plain-block-comments`, so ESLint remains as a parity backstop.

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Delete: `eslint.config.ts`

- [ ] **Step 1: Remove ESLint packages**

Run only after Task 6 passes:

```bash
pnpm remove eslint @eslint/js eslint-plugin-jsdoc eslint-plugin-react-hooks globals typescript-eslint
```

Expected: ESLint-related dev dependencies are removed.

- [ ] **Step 2: Delete ESLint config**

Delete:

```text
eslint.config.ts
```

- [ ] **Step 3: Remove ESLint script**

Change scripts in `package.json` to:

```json
{
    "lint": "pnpm run format:check && pnpm run lint:ox && pnpm run lint:md && pnpm run lint:types",
    "lint:md": "markdownlint-cli2 \"**/*.md\" \"#node_modules\" \"#dist\" \"#coverage\" \"#.sdd\" \"#test-results\"",
    "lint:ox": "oxlint --jsdoc-plugin --react-plugin --vitest-plugin .",
    "lint:types": "tsc --noEmit"
}
```

Keep all non-lint scripts already present in `package.json`.

- [ ] **Step 4: Verify final lint pipeline**

Run:

```bash
pnpm run lint
```

Expected: PASS.

**Verification**: ESLint is absent from `package.json`, `eslint.config.ts` is
deleted, and `pnpm run lint` passes with oxfmt, oxlint, markdownlint, and tsc.

### [x] Task 8: Update Documentation

**Files:**

- Modify: `README.md`
- Modify: `DEVELOPMENT.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Update README command description**

Change the lint row in `README.md` to:

```markdown
| `make lint` | Oxfmt check + Oxlint + markdownlint + TypeScript (`tsc --noEmit`) |
```

If ESLint is kept temporarily, use:

```markdown
| `make lint` | Oxfmt check + Oxlint + ESLint parity checks + markdownlint + TypeScript (`tsc --noEmit`) |
```

- [x] **Step 2: Update DEVELOPMENT command reference**

Change the `pnpm run lint` row in `DEVELOPMENT.md` to:

```markdown
| `pnpm run lint` | **Oxfmt** check + **Oxlint** + **markdownlint** + **`tsc --noEmit`** (`.oxfmtrc.json`, `.oxlintrc.json`, `.markdownlint.json`, `tsconfig.json`) |
```

If ESLint is kept temporarily, include **ESLint parity checks** in the row.

- [x] **Step 3: Update no-formatter note**

Replace the existing `DEVELOPMENT.md` sentence:

```markdown
There is **no** `format` script — formatting is left to the editor; **lint** is the enforced check.
```

with:

```markdown
`pnpm run format` applies Oxfmt formatting. `pnpm run format:check` is part of `pnpm run lint`, so CI enforces the same formatting as local development.
```

- [x] **Step 4: Update AGENTS lint section**

Replace the lint row with wording that matches the final script. For full ESLint
removal, use:

```markdown
| **Lint** | **`pnpm run lint`** = **Oxfmt** formatting check + **Oxlint** + markdownlint + **`tsc --noEmit`** (`lint:types`). **Oxlint** does not replace the full TypeScript checker — type errors appear in the editor from **`tsc`**; **`lint:types`** aligns CI/terminal with that. |
```

If ESLint is kept temporarily, state that ESLint remains as parity backstop.

**Verification**: Docs match actual scripts and no longer say the repo has no
formatter.

## Final Verification

- [ ] Run formatter check: `pnpm run format:check`
- [ ] Run oxlint: `pnpm run lint:ox`
- [ ] Run full lint gate: `pnpm run lint`
- [ ] Run unit tests: `pnpm run test`
- [ ] Run build: `pnpm run build`
- [ ] Review mechanical formatting diff separately from lint-tool migration diff.
- [ ] Confirm no temporary `tmp/lint-parity` files remain.

## Notes

This is a configuration migration, but full ESLint removal is not a tiny safe
change because the current ESLint config encodes repository policy. The safe path
is: add `oxfmt`, add `oxlint`, keep ESLint briefly for parity, then remove ESLint
only after known policy checks are reproduced or intentionally dropped.
