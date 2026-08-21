import { describe, expect, it } from 'vitest';

import {
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
    MAX_CAPTION_PAGE_BRIDGE_REQUEST_ID_LENGTH,
    parseCaptionPageBridgeCommandRequest,
    parseCaptionPageBridgeCommandResult,
} from '@/content/captions/caption-page-bridge-contract';

const REQUEST_ID = 'request-1';

const VALID_REQUEST = {
    source: CAPTION_PAGE_BRIDGE_SOURCE.Isolated,
    kind: 'command',
    protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    command: CAPTION_PAGE_BRIDGE_COMMAND.Activate,
};

const VALID_RESULT = {
    source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
    kind: 'command-result',
    protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    result: { ok: true },
};

function encode(value: unknown): string {
    return JSON.stringify(value);
}

describe('caption page bridge contract', () => {
    it('publishes the local command event names', () => {
        expect(CAPTION_PAGE_BRIDGE_EVENT).toEqual({
            Command: 'topskip:caption-capture-command',
            CommandResult: 'topskip:caption-capture-command-result',
            PageMessage: 'topskip:caption-capture-page',
        });
    });

    it('parses a complete command request from JSON detail', () => {
        expect(parseCaptionPageBridgeCommandRequest(encode(VALID_REQUEST)))
            .toEqual(VALID_REQUEST);
    });

    it.each([
        ['non-string detail', VALID_REQUEST],
        ['malformed JSON', '{'],
        ['null JSON', 'null'],
        ['array JSON', '[]'],
        [
            'wrong source',
            encode({ ...VALID_REQUEST, source: CAPTION_PAGE_BRIDGE_SOURCE.Main }),
        ],
        ['wrong kind', encode({ ...VALID_REQUEST, kind: 'request' })],
        [
            'wrong protocol',
            encode({ ...VALID_REQUEST, protocolVersion: 2 }),
        ],
        ['missing request id', encode({ ...VALID_REQUEST, requestId: undefined })],
        ['empty request id', encode({ ...VALID_REQUEST, requestId: '' })],
        ['non-string request id', encode({ ...VALID_REQUEST, requestId: 1 })],
        [
            'oversized request id',
            encode({
                ...VALID_REQUEST,
                requestId: 'x'.repeat(
                    MAX_CAPTION_PAGE_BRIDGE_REQUEST_ID_LENGTH + 1,
                ),
            }),
        ],
        ['missing command', encode({ ...VALID_REQUEST, command: undefined })],
        ['unknown command', encode({ ...VALID_REQUEST, command: 'capture' })],
        ['extra field', encode({ ...VALID_REQUEST, token: 'secret' })],
    ])('rejects a command request with %s', (_name, value) => {
        expect(parseCaptionPageBridgeCommandRequest(value)).toBeNull();
    });

    it.each(Object.values(CAPTION_PAGE_BRIDGE_COMMAND))(
        'accepts the %s command',
        (command) => {
            expect(
                parseCaptionPageBridgeCommandRequest(
                    encode({ ...VALID_REQUEST, command }),
                ),
            ).toEqual({ ...VALID_REQUEST, command });
        },
    );

    it('parses a complete command result with an opaque result value', () => {
        expect(parseCaptionPageBridgeCommandResult(encode(VALID_RESULT)))
            .toEqual(VALID_RESULT);
        expect(
            parseCaptionPageBridgeCommandResult(
                encode({ ...VALID_RESULT, result: null }),
            ),
        ).toEqual({ ...VALID_RESULT, result: null });
    });

    it.each([
        ['non-string detail', VALID_RESULT],
        ['malformed JSON', '{'],
        ['null JSON', 'null'],
        ['array JSON', '[]'],
        [
            'wrong source',
            encode({ ...VALID_RESULT, source: CAPTION_PAGE_BRIDGE_SOURCE.Isolated }),
        ],
        ['wrong kind', encode({ ...VALID_RESULT, kind: 'result' })],
        [
            'wrong protocol',
            encode({ ...VALID_RESULT, protocolVersion: 2 }),
        ],
        ['missing request id', encode({ ...VALID_RESULT, requestId: undefined })],
        ['empty request id', encode({ ...VALID_RESULT, requestId: '' })],
        ['non-string request id', encode({ ...VALID_RESULT, requestId: 1 })],
        [
            'oversized request id',
            encode({
                ...VALID_RESULT,
                requestId: 'x'.repeat(
                    MAX_CAPTION_PAGE_BRIDGE_REQUEST_ID_LENGTH + 1,
                ),
            }),
        ],
        [
            'missing result',
            encode({
                source: VALID_RESULT.source,
                kind: VALID_RESULT.kind,
                protocolVersion: VALID_RESULT.protocolVersion,
                requestId: VALID_RESULT.requestId,
            }),
        ],
        ['extra field', encode({ ...VALID_RESULT, command: 'activate-captions' })],
    ])('rejects a command result with %s', (_name, value) => {
        expect(parseCaptionPageBridgeCommandResult(value)).toBeNull();
    });
});
