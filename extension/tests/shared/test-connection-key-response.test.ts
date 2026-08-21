import { describe, expect, it } from 'vitest';

import {
    PROVIDER_CONNECTION_FAILURE_CODE,
    parseTestConnectionKeyResponse,
} from '@/shared/messages';
import { PROVIDER_ID } from '@/shared/providers';

describe('parseTestConnectionKeyResponse', () => {
    it.each([
        { ok: true, valid: true },
        { ok: true, valid: false, error: 'invalid key' },
        { ok: false, error: 'provider unavailable' },
        { ok: false, error: 'try later', retryable: true },
        {
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: PROVIDER_ID.OpenRouter,
        },
        {
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: PROVIDER_ID.OpenAI,
        },
    ])('accepts documented branch %#', (value) => {
        expect(parseTestConnectionKeyResponse(value)).toEqual(value);
    });

    it.each([
        null,
        [],
        { ok: true },
        { ok: true, valid: 'true' },
        { ok: true, valid: true, error: 'extra' },
        { ok: true, valid: false },
        { ok: false },
        { ok: false, error: 1 },
        { ok: false, error: 'failure', retryable: 'true' },
        { ok: false, error: 'failure', extra: true },
        {
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: 'unknown',
        },
        {
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: PROVIDER_ID.OpenAI,
            error: 'extra',
        },
    ])('rejects malformed response %#', (value) => {
        expect(parseTestConnectionKeyResponse(value)).toBeNull();
    });
});
