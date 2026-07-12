import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';

import { BackendAnalysisApi } from '@/backend/analysis-api';
import { MIME_APPLICATION_JSON } from '@/shared/constants';
import {
    errorResponseSchema,
    type ErrorResponse,
} from '@/shared/server-analysis-contract';

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8787;
const BACKEND_VERSION = '0.1.0';
const MAX_ANALYSIS_REQUEST_BODY_BYTES = 32_768;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const HTTP_STATUS_NOT_FOUND = 404;
const LOCAL_URL_BASE = 'http://127.0.0.1';
const CHROME_EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';
const FIXTURE_COMPLETION_ENABLED = process.env.NODE_ENV === 'test';

/**
 * Result of parsing the local API request body at the HTTP boundary.
 */
type ReadJsonBodyResult =
    | { ok: true; body: unknown }
    | { ok: false; statusCode: 400 | 413; body: ErrorResponse };

/**
 * Owns the minimal local HTTP server for the server-first tracer bullet;
 * static API only.
 */
export class BackendHttpServer {
    /**
     * Creates an unstarted Node HTTP server for tests or the dev script.
     *
     * @returns Local backend HTTP server.
     */
    static create(): Server {
        return createServer((req, res) => {
            void BackendHttpServer.route(req, res).catch(() => {
                BackendHttpServer.handleRouteFailure(res);
            });
        });
    }

    /**
     * Starts the local backend on the configured development address.
     *
     * @returns Nothing.
     */
    static listen(): void {
        const server = BackendHttpServer.create();
        server.listen(BACKEND_PORT, BACKEND_HOST, () => {
            console.info(
                `TopSkip backend listening on http://${BACKEND_HOST}:${BACKEND_PORT}`,
            );
        });
    }

    /**
     * Routes only the health and analysis endpoints needed by this slice.
     *
     * @param req - Incoming Node request.
     * @param res - Node response writer.
     * @returns Promise that resolves after the response is written.
     */
    private static async route(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const url = new URL(req.url ?? '/', LOCAL_URL_BASE);

        if (req.method === 'GET' && url.pathname === '/v1/health') {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_OK,
                BackendAnalysisApi.health(BACKEND_VERSION),
            );
            return;
        }

        if (req.method === 'POST' && url.pathname === '/v1/analysis') {
            await BackendHttpServer.handleAnalysis(req, res);
            return;
        }

        const jobRoute = BackendHttpServer.parseJobRoute(url);
        if (jobRoute !== null) {
            if (req.method === 'GET' && jobRoute.kind === 'status') {
                const result = BackendAnalysisApi.handleJobStatusRequest(
                    jobRoute.jobId,
                );
                BackendHttpServer.sendJson(res, result.statusCode, result.body);
                return;
            }

            if (
                FIXTURE_COMPLETION_ENABLED &&
                req.method === 'POST' &&
                jobRoute.kind === 'fixture-result'
            ) {
                await BackendHttpServer.handleFixtureCompletion(
                    req,
                    res,
                    jobRoute.jobId,
                );
                return;
            }
        }

        BackendHttpServer.sendJson(
            res,
            HTTP_STATUS_NOT_FOUND,
            BackendHttpServer.error('invalid_request', 'Unknown route.'),
        );
    }

    /**
     * Converts request-body failures into typed responses before API handling.
     *
     * @param req - Incoming analysis request stream.
     * @param res - Node response writer.
     * @returns Promise that resolves after the response is written.
     */
    private static async handleAnalysis(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        if (!BackendHttpServer.isTrustedMutation(req)) {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_NOT_FOUND,
                BackendHttpServer.error('invalid_request', 'Unknown route.'),
            );
            return;
        }
        const readResult = await BackendHttpServer.readJsonBody(req);
        if (!readResult.ok) {
            BackendHttpServer.sendJson(
                res,
                readResult.statusCode,
                readResult.body,
            );
            return;
        }

        const result = BackendAnalysisApi.handleAnalysisRequest(
            readResult.body,
        );
        BackendHttpServer.sendJson(res, result.statusCode, result.body);
    }

    /**
     * Converts fixture-completion bodies into terminal local job responses.
     *
     * @param req - Incoming completion request stream.
     * @param res - Node response writer.
     * @param jobId - Local job id decoded from the route.
     * @returns Promise that resolves after the response is written.
     */
    private static async handleFixtureCompletion(
        req: IncomingMessage,
        res: ServerResponse,
        jobId: string,
    ): Promise<void> {
        if (!BackendHttpServer.isTrustedMutation(req)) {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_NOT_FOUND,
                BackendHttpServer.error('invalid_request', 'Unknown route.'),
            );
            return;
        }
        const readResult = await BackendHttpServer.readJsonBody(req);
        if (!readResult.ok) {
            BackendHttpServer.sendJson(
                res,
                readResult.statusCode,
                readResult.body,
            );
            return;
        }

        const result = BackendAnalysisApi.handleFixtureCompletionRequest(
            jobId,
            readResult.body,
        );
        BackendHttpServer.sendJson(res, result.statusCode, result.body);
    }

    /**
     * Extracts the supported local job routes without matching unknown paths.
     *
     * @param url - Parsed request URL.
     * @returns Job route data, or `null` when the path is not a job route.
     */
    private static parseJobRoute(
        url: URL,
    ): { kind: 'status' | 'fixture-result'; jobId: string } | null {
        const parts = url.pathname.split('/').filter((part) => part.length > 0);
        if (
            parts.length === 4 &&
            parts[0] === 'v1' &&
            parts[1] === 'analysis' &&
            parts[2] === 'jobs'
        ) {
            const jobId = BackendHttpServer.decodeJobId(parts[3]);
            return jobId === null ? null : { kind: 'status', jobId };
        }

        if (
            parts.length === 5 &&
            parts[0] === 'v1' &&
            parts[1] === 'analysis' &&
            parts[2] === 'jobs' &&
            parts[4] === 'fixture-result'
        ) {
            const jobId = BackendHttpServer.decodeJobId(parts[3]);
            return jobId === null ? null : { kind: 'fixture-result', jobId };
        }

        return null;
    }

    /**
     * Reads JSON while bounding stored body text and guarding parse failures.
     *
     * @param req - Incoming Node request stream.
     * @returns Parsed JSON body or a typed request error.
     */
    private static async readJsonBody(
        req: IncomingMessage,
    ): Promise<ReadJsonBodyResult> {
        if (!BackendHttpServer.hasJsonContentType(req)) {
            return {
                ok: false,
                statusCode: 400,
                body: BackendHttpServer.error(
                    'invalid_request',
                    'Requests must use application/json.',
                ),
            };
        }
        let body = '';
        let byteLength = 0;
        let tooLarge = false;

        req.setEncoding('utf8');
        for await (const chunk of req) {
            const text = String(chunk);
            byteLength += Buffer.byteLength(text, 'utf8');
            if (byteLength > MAX_ANALYSIS_REQUEST_BODY_BYTES) {
                tooLarge = true;
                continue;
            }
            body += text;
        }

        if (tooLarge) {
            return {
                ok: false,
                statusCode: 413,
                body: BackendHttpServer.error(
                    'request_body_too_large',
                    'Request body exceeds the local API limit.',
                ),
            };
        }

        if (body.length === 0) {
            return { ok: true, body: {} };
        }

        try {
            return { ok: true, body: JSON.parse(body) as unknown };
        } catch {
            return {
                ok: false,
                statusCode: 400,
                body: BackendHttpServer.error(
                    'invalid_request',
                    'Malformed JSON request body.',
                ),
            };
        }
    }

    /**
     * Serializes a typed JSON response with the shared content type.
     *
     * @param res - Node response writer.
     * @param statusCode - HTTP status code.
     * @param body - JSON-serializable response body.
     * @returns Nothing.
     */
    private static sendJson(
        res: ServerResponse,
        statusCode: number,
        body: unknown,
    ): void {
        res.writeHead(statusCode, { 'content-type': MIME_APPLICATION_JSON });
        res.end(`${JSON.stringify(body)}\n`);
    }

    /**
     * Allows extension and non-browser development clients to mutate the loopback API.
     *
     * @param req - Incoming request whose origin is evaluated.
     * @returns Whether the request can reach a state-changing endpoint.
     */
    private static isTrustedMutation(req: IncomingMessage): boolean {
        const origin = req.headers.origin;
        return (
            origin === undefined ||
            origin.startsWith(CHROME_EXTENSION_ORIGIN_PREFIX)
        );
    }

    /**
     * Requires a non-safelisted JSON media type before accepting a mutation.
     *
     * @param req - Incoming request whose content type is evaluated.
     * @returns Whether the request declares a JSON body.
     */
    private static hasJsonContentType(req: IncomingMessage): boolean {
        const contentType = req.headers['content-type'];
        return (
            typeof contentType === 'string' &&
            contentType.toLowerCase().startsWith(MIME_APPLICATION_JSON)
        );
    }

    /**
     * Converts encoded route parameters without allowing malformed paths to reject routing.
     *
     * @param rawJobId - Percent-encoded route segment.
     * @returns Decoded job id, or `null` for malformed encoding.
     */
    private static decodeJobId(rawJobId: string): string | null {
        try {
            return decodeURIComponent(rawJobId);
        } catch {
            return null;
        }
    }

    /**
     * Prevents request-level faults from becoming process-level unhandled rejections.
     *
     * @param res - Response writer that may still accept an error response.
     */
    private static handleRouteFailure(res: ServerResponse): void {
        if (res.headersSent || res.writableEnded) {
            return;
        }
        BackendHttpServer.sendJson(
            res,
            HTTP_STATUS_INTERNAL_SERVER_ERROR,
            BackendHttpServer.error(
                'invalid_request',
                'Internal server error.',
            ),
        );
    }

    /**
     * Builds typed error responses so server and OpenAPI stay aligned.
     *
     * @param code - Stable error code from the local backend contract.
     * @param message - User-safe error summary.
     * @returns Validated error response.
     */
    private static error(
        code:
            | 'invalid_video_id'
            | 'invalid_request'
            | 'request_body_too_large'
            | 'job_not_found',
        message: string,
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'invalid_request',
            error: { code, message },
        });
    }
}

if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    BackendHttpServer.listen();
}
