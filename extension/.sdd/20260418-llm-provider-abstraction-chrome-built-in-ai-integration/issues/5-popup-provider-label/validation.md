# Issue Validation Report: Popup — Display Active Provider & Model Label

**Validated**: 2026-04-17
**Model**: github-copilot/claude-sonnet-4.6
**Issue**: `.sdd/.current/issues/5-popup-provider-label/issue.md`
**Plan**: `.sdd/.current/issues/5-popup-provider-label/plan.md`

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 5 | 0 | 0 | 5 |
| Acceptance Criteria | 6 | 0 | 0 | 6 |
| Entities | N/A | N/A | N/A | N/A |
| Contracts | 1 | 0 | 0 | 1 |
| Guidelines | 7 | 0 | 0 | 7 |

**Overall Status**: COMPLETE

One deviation from the plan narrative is noted (missing "Not configured" Badge
in the hero area), but it does not affect any explicit acceptance-criteria
checkbox and is documented under Issues Found below.

## Task Status

- [x] **Task 1**: Extend `GetActiveProviderResponse` with `modelName` — PASS
- [x] **Task 2**: Update `handleGetActive()` to populate `modelName` — PASS
- [x] **Task 3**: Add `providerDisplayName`/`modelDisplayName` to `PreferencesStore` — PASS
- [x] **Task 4**: Export `buildPopupViewModel` and add `providerLabel` to view model — PASS
- [x] **Task 5**: Full test suite and build verification — PASS

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `PreferencesStore.load()` fetches active provider info from background | MET | `preferences-store.ts:150–155` — `Promise.all` sends both `GET_PREFS` and `GET_ACTIVE_PROVIDER`; `preferences-store.test.ts:200–210` asserts `providerDisplayName` and `modelDisplayName` after `load()` |
| 2 | Provider + model label renders in the popup status area | MET | `PopupApp.tsx:557–563` — conditional `<Group>` renders `⚡ {view.providerLabel}` inside the hero `Paper`; `popup-view-model.test.ts:26–31` asserts `providerLabel` value |
| 3 | Label updates when provider changes (via port message) | MET | `preferences-store.ts:116–132` — `connectPort()` calls `refreshProviderDisplay()` when `msg.prefs.providerId !== prevProviderId`; `preferences-store.test.ts:234–274` asserts `providerDisplayName`/`modelDisplayName` update after port message |
| 4 | `not_configured` view-model state includes provider name | MET | `PopupApp.tsx` `not_configured` branch — description is `` `Configure ${providerDisplayName \|\| 'your LLM provider'} to enable…` ``; `popup-view-model.test.ts:44–56` asserts `vm.description` contains `'OpenRouter'` |
| 5 | Chrome Built-in label shows "Chrome Built-in · Gemini Nano" | MET | `provider-runtime-messages.ts:85–86` hardcodes `'Gemini Nano'`; `popup-view-model.test.ts:58–68` asserts `vm.providerLabel === 'Chrome Built-in · Gemini Nano'`; `provider-runtime-messages.test.ts:167–187` verifies background returns `modelName: 'Gemini Nano'` |
| 6 | `pnpm run lint` passes | MET | ESLint + markdownlint + `tsc --noEmit` all exit 0 |

## Entity Status

N/A — plan explicitly states "no new persistent entities."

## Contract Status

| Contract | Status | Notes |
| --- | --- | --- |
| `GetActiveProviderResponse` success branch gains `modelName: string` | PASS | `src/shared/messages.ts:115` — field present; background handler returns it; popup store consumes it; 3 background tests + 4 store tests cover the full round-trip |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| TypeScript only — no `.js`/`.mjs` source files | COMPLIANT | All new files are `.ts` or `.tsx` |
| TypeScript strict — avoid `any` | COMPLIANT | New code uses `unknown` + narrowing; `Reflect.get` results annotated `const type: unknown` |
| Avoid `as` — prefer narrowing | COMPLIANT | `isGetActiveProviderOk` narrows via `typeof` + `in` checks; no unsafe casts in new code |
| JSDoc on all `src/` functions and class methods | COMPLIANT | `isGetActiveProviderOk`, `refreshProviderDisplay`, updated `buildPopupViewModel` all have `/** … */` blocks with `@param`/`@returns` |
| `src/shared/` reserved for types/constants/pure helpers | COMPLIANT | `GetActiveProviderResponse` stays in `messages.ts`; `isGetActiveProviderOk` guard lives in `preferences-store.ts` (popup bundle) |
| MobX — use `runInAction` in async flows | COMPLIANT | `load()` and `refreshProviderDisplay()` both wrap mutations in `runInAction` |
| Mantine only in popup bundle | COMPLIANT | No Mantine imports added to background or content |

## Issues Found

1. **"Not configured" badge not implemented**
   - Location: `src/popup/PopupApp.tsx` hero area
   - Description: Plan step 3h and issue line 44 describe a `<Badge size="xs"
     color="warning" variant="light">Not configured</Badge>` that should render
     when `detectionState.status === 'not_configured' && store.providerId ===
     'openrouter' && store.modelDisplayName === ''`. The implementation omits
     this badge entirely. The provider label also reads `"OpenRouter"` (not
     `"OpenRouter · Not configured"`) in that state.
   - Impact: Low. No explicit acceptance-criteria checkbox requires the badge
     or the specific "· Not configured" label text. The `not_configured` state
     already shows a "Setup" badge in the hero and a "Continue setup" button;
     the omission does not break any user flow.
   - Recommendation: Add the badge in a follow-up if the UI sketch in the issue
     is considered binding. If not, update the issue narrative to match the
     implemented behaviour.

## Recommendations

- The implementation satisfies all six acceptance-criteria checkboxes and all
  five plan tasks. No blocking issues remain.
- Consider the "Not configured" badge as a low-priority follow-up or clarify
  with the product owner whether the issue-line-44 narrative is normative.
