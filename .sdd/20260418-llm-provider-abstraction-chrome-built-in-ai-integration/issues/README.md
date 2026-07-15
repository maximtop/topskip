# Issues — LLM Provider Abstraction & Chrome Built-in AI

9 vertical-slice issues derived from [prd.md](../prd.md).

## Dependency graph

```text
1 ─────────────┬──────────────────────────────┐
               │                              │
2 ← 1         3 ← 1, 2                      6 ← 1, 3
               │                              │
4 ← 2, 3      │                      7 ← 4, 6
               │                              │
5 ← 4         │                      8 ← 5, 6
               │
9 ← 4         │
```

## Issue list

| # | Title | Priority | Blocked by | Dir |
|---|-------|----------|------------|-----|
| 1 | Adapter interface + registry + OpenRouter adapter wrap | P1 | — | [1-adapter-interface/](1-adapter-interface/issue.md) |
| 2 | Unify `enabled` flags into `providerId` + migration | P1 | 1 | [2-unify-enabled-provider-id/](2-unify-enabled-provider-id/issue.md) |
| 3 | Wire `PromoAnalysis` pipeline to registry | P1 | 1, 2 | [3-wire-pipeline-to-registry/](3-wire-pipeline-to-registry/issue.md) |
| 4 | Provider messaging + options provider selector UI | P1 | 2, 3 | [4-provider-messaging-options-ui/](4-provider-messaging-options-ui/issue.md) |
| 5 | Popup: display active provider & model label | P1 | 4 | [5-popup-provider-label/](5-popup-provider-label/issue.md) |
| 6 | Chrome Prompt API adapter | P1 | 1, 3 | [6-chrome-prompt-api-adapter/](6-chrome-prompt-api-adapter/issue.md) |
| 7 | Options: Chrome Built-in onboarding widget | P1 | 4, 6 | [7-chrome-builtin-onboarding/](7-chrome-builtin-onboarding/issue.md) |
| 8 | Popup: Chrome Built-in model readiness status | P2 | 5, 6 | [8-popup-chrome-readiness/](8-popup-chrome-readiness/issue.md) |
| 9 | OpenRouter model slug validation | P2 | 4 | [9-openrouter-slug-validation/](9-openrouter-slug-validation/issue.md) |

## Suggested implementation order

1. **Issue 1** — foundation types, no behavior change
2. **Issue 2** — storage + schema refactor
3. **Issue 3** — pipeline rewiring (adapter actually used)
4. **Issue 6** — Chrome adapter (can parallelize with 4 after 3 merges)
5. **Issue 4** — options UI + messaging
6. **Issue 5** — popup label
7. **Issue 7** — onboarding widget (needs 4 + 6)
8. **Issue 9** — slug validation (independent P2)
9. **Issue 8** — popup chrome status (last P2)
