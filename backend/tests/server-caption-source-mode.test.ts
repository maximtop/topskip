import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@topskip/backend/cache-fixtures', () => ({
    BackendCacheFixtures: { findReady: vi.fn(() => null) },
}));

import { BackendPublicState } from '@topskip/backend/public-state';
import { BackendHttpServer } from '@topskip/backend/server';
import {
    BACKEND_CAPTION_SOURCE,
    type BackendCaptionSource,
} from '@topskip/backend/server-config';
import { BackendServerAnalysisBoundary } from '@topskip/backend/server-analysis-boundary';
import { YtDlpBinary } from '@topskip/backend/extraction/yt-dlp-binary';
import { MIME_APPLICATION_JSON } from '@topskip/common/constants';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';

const ORIGINAL_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_CAPTION_SOURCE = process.env.TOPSKIP_CAPTION_SOURCE;

function validPublicRequest(): unknown {
    return {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        languageCode: 'en',
        segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
        client: {
            source: 'chrome-extension',
            capabilities: ['typed-server-errors-v1'],
        },
    };
}

function validLegacyRequest(): unknown {
    return {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    };
}

function processingResponse(includeIdentity: boolean): unknown {
    return {
        status: 'processing',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        ...(includeIdentity
            ? {
                  languageCode: 'en',
                  transcriptHash: 'a'.repeat(64),
              }
            : {}),
        jobId: 'job-id',
        pollAfterSec: 3,
    };
}

function mockUnstartedServer(): Server {
    return {
        listen: vi.fn(
            (_port: number, _host: string, callback: () => void): void => {
                callback();
            },
        ),
    } as unknown as Server;
}

async function listenOnEphemeralPort(server: Server): Promise<string> {
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port.');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) {
                resolve();
                return;
            }
            reject(error);
        });
    });
}

describe('backend caption-source mode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        if (ORIGINAL_API_KEY === undefined) {
            delete process.env.OPENROUTER_API_KEY;
        } else {
            process.env.OPENROUTER_API_KEY = ORIGINAL_API_KEY;
        }
        if (ORIGINAL_CAPTION_SOURCE === undefined) {
            delete process.env.TOPSKIP_CAPTION_SOURCE;
        } else {
            process.env.TOPSKIP_CAPTION_SOURCE = ORIGINAL_CAPTION_SOURCE;
        }
    });

    it('asserts yt-dlp only for the explicit legacy startup mode', () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const createSpy = vi
            .spyOn(BackendHttpServer, 'create')
            .mockReturnValue(mockUnstartedServer());
        vi.spyOn(BackendPublicState, 'assertReady').mockImplementation(
            () => {},
        );
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const assertAvailable = vi
            .spyOn(YtDlpBinary, 'assertAvailable')
            .mockReturnValue('v-test');

        delete process.env.TOPSKIP_CAPTION_SOURCE;
        BackendHttpServer.listen();
        expect(assertAvailable).not.toHaveBeenCalled();
        expect(createSpy).toHaveBeenLastCalledWith({
            captionSource: BACKEND_CAPTION_SOURCE.ExtensionUpload,
        });
        expect(info).toHaveBeenLastCalledWith(
            expect.stringContaining('captionSource extension_upload'),
        );
        expect(info.mock.lastCall?.[0]).not.toContain('yt-dlp');

        process.env.TOPSKIP_CAPTION_SOURCE = BACKEND_CAPTION_SOURCE.LegacyYtDlp;
        BackendHttpServer.listen();
        expect(assertAvailable).toHaveBeenCalledOnce();
        expect(createSpy).toHaveBeenLastCalledWith({
            captionSource: BACKEND_CAPTION_SOURCE.LegacyYtDlp,
        });
    });

    it('preserves the actionable missing-binary failure in legacy mode', () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        process.env.TOPSKIP_CAPTION_SOURCE = BACKEND_CAPTION_SOURCE.LegacyYtDlp;
        vi.spyOn(BackendPublicState, 'assertReady').mockImplementation(
            () => {},
        );
        const failure = new Error(
            'yt-dlp is unavailable. Run `make yt-dlp-install` or set TOPSKIP_YT_DLP_PATH.',
        );
        vi.spyOn(YtDlpBinary, 'assertAvailable').mockImplementation(() => {
            throw failure;
        });

        expect(() => BackendHttpServer.listen()).toThrow(failure);
    });

    it.each([
        BACKEND_CAPTION_SOURCE.ExtensionUpload,
        BACKEND_CAPTION_SOURCE.LegacyYtDlp,
    ])(
        'keeps request parsing and response serialization inside %s',
        (source) => {
            const boundary = BackendServerAnalysisBoundary.forSource(source);
            const publicRequest = boundary.parseRequest(validPublicRequest());
            const legacyRequest = boundary.parseRequest(validLegacyRequest());

            if (source === BACKEND_CAPTION_SOURCE.ExtensionUpload) {
                expect(publicRequest.success).toBe(true);
                expect(legacyRequest.success).toBe(false);
                expect(() =>
                    boundary.serializeResponse(processingResponse(true)),
                ).not.toThrow();
                expect(() =>
                    boundary.serializeResponse(processingResponse(false)),
                ).toThrow();
                return;
            }

            expect(publicRequest.success).toBe(false);
            expect(legacyRequest.success).toBe(true);
            expect(() =>
                boundary.serializeResponse(processingResponse(false)),
            ).not.toThrow();
            expect(() =>
                boundary.serializeResponse(processingResponse(true)),
            ).toThrow();
        },
    );

    it('captures one immutable source instead of rereading the environment', async () => {
        const source: BackendCaptionSource =
            BACKEND_CAPTION_SOURCE.ExtensionUpload;
        const server = BackendHttpServer.create({ captionSource: source });
        const baseUrl = await listenOnEphemeralPort(server);
        try {
            process.env.TOPSKIP_CAPTION_SOURCE =
                BACKEND_CAPTION_SOURCE.LegacyYtDlp;
            const response = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: JSON.stringify(validLegacyRequest()),
            });

            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({
                status: 'error',
                error: { code: 'invalid_request' },
            });
        } finally {
            await closeServer(server);
        }
    });
});
