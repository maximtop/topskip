# Issue 9 — OpenRouter model slug validation

**Type**: Feature / UX
**Priority**: P2
**Blocked by**: Issue 4
**Status**: Validated
**User Stories**: US-7
**Success Criteria**: SC-004

## Goal

Validate custom OpenRouter model slugs at save time: enforce `owner/model-name` format always, and when an API key is configured, query the OpenRouter models API to verify the slug exists. Show clear error or "Unverified" badge.

## Scope

### New files

| File | Purpose |
|------|---------|
| `src/background/openrouter/openrouter-models-api.ts` | `fetchOpenRouterModelList(apiKey)` → `string[]` (cached per session). Queries `GET https://openrouter.ai/api/v1/models`. |
| `tests/background/openrouter/openrouter-models-api.test.ts` | Unit tests with mocked fetch |

### Modified files

| File | Change |
|------|--------|
| `src/shared/messages.ts` | Add `TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL` + request/response types. |
| `src/background/messaging/register-runtime-messages.ts` | Handle `VALIDATE_OPENROUTER_MODEL`: regex check → API check (if key present) → return `{ valid: boolean, error?: string, unverified?: boolean }`. |
| `src/options/OpenRouterConfigPanel.tsx` | On "Add custom model" submit, call `VALIDATE_OPENROUTER_MODEL` before saving. Show inline error for invalid format or "Model not found". Show "Unverified" badge if API check was skipped (no key). |

## Validation rules

1. **Format check** (always): slug must match `/^[a-z0-9_-]+\/[a-z0-9._-]+$/i`. If not, return `{ valid: false, error: 'Invalid format. Use owner/model-name.' }`.
2. **API check** (when API key present): query models list, check if slug is in the list. If not found, return `{ valid: false, error: 'Model not found on OpenRouter.' }`.
3. **No API key**: skip API check, return `{ valid: true, unverified: true }`.

### Session cache

The models list is fetched once and cached in a module-level variable. Cache is cleared when the service worker restarts (natural MV3 lifecycle). No explicit TTL needed.

## Acceptance criteria

- [ ] Slugs not matching `owner/model-name` are rejected with a clear error
- [ ] Well-formed slugs are checked against the OpenRouter API when a key is present
- [ ] Missing slugs show "Model not found on OpenRouter" error
- [ ] When no API key is configured, slugs are accepted with an "Unverified" badge
- [ ] Models API response is cached per session (no duplicate fetches)
- [ ] Network errors during API check result in `{ valid: true, unverified: true }` (graceful degradation)
- [ ] `pnpm run lint` passes

## Testing

- Unit: regex validation — valid slugs pass, invalid slugs rejected
- Unit: API check — mock fetch returning model list → slug found → valid
- Unit: API check — slug not in list → invalid with error
- Unit: no API key → unverified
- Unit: fetch error → unverified (graceful)
- Unit: cache hit — second call does not fetch again
