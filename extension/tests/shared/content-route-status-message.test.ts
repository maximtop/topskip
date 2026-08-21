import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
    contentRouteStatusRequestSchema,
    contentRouteStatusResponseSchema,
} from '@/shared/messages';

const RESPONSE = {
    ok: true,
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
    extensionVersion: '0.1.0',
    videoId: 'dQw4w9WgXcQ',
    enabled: true,
    analysisMode: 'server',
    serverSessionId: '00000000-0000-4000-8000-000000000001',
};

describe('content route status contract', () => {
    it('accepts only the typed request and complete current route response', () => {
        expect(
            v.safeParse(contentRouteStatusRequestSchema, {
                type: TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS,
            }).success,
        ).toBe(true);
        expect(v.safeParse(contentRouteStatusResponseSchema, RESPONSE).success)
            .toBe(true);
    });

    it('allows an inert content context with no route or session', () => {
        expect(
            v.safeParse(contentRouteStatusResponseSchema, {
                ...RESPONSE,
                videoId: null,
                enabled: false,
                analysisMode: null,
                serverSessionId: null,
            }).success,
        ).toBe(true);
    });

    it.each([
        ['missing version', { ...RESPONSE, extensionVersion: undefined }],
        ['wrong protocol', { ...RESPONSE, protocolVersion: 999 }],
        ['invalid mode', { ...RESPONSE, analysisMode: 'automatic' }],
        ['invalid session', { ...RESPONSE, serverSessionId: 'session' }],
        ['unknown field', { ...RESPONSE, url: 'https://secret.example/' }],
    ])('rejects %s', (_name, candidate) => {
        expect(
            v.safeParse(contentRouteStatusResponseSchema, candidate).success,
        ).toBe(false);
    });
});
