import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import * as v from 'valibot';

import { BackendAnalysisApi } from '@topskip/backend/analysis-api';
import { YtDlpBinary } from '@topskip/backend/extraction/yt-dlp-binary';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';
import { BackendServerConfig } from '@topskip/backend/server-config';
import { BackendPublicState } from '@topskip/backend/public-state';
import { MIME_APPLICATION_JSON } from '@topskip/common/constants';
import {
    errorResponseSchema,
    installationRegistrationResponseSchema,
    isValidYouTubeVideoId,
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS,
    SERVER_ANALYSIS_FAILURE_CODE,
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
    serverAnalysisRequestSchema,
    serverConfigResponseSchema,
    TOPSKIP_CAPABILITIES_HEADER_NAME,
    type ErrorResponse,
} from '@topskip/common/server-analysis-contract';

const DEFAULT_BACKEND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 8787;
const MAX_ANALYSIS_REQUEST_BODY_BYTES = 32_768;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const HTTP_STATUS_NOT_FOUND = 404;
const LOCAL_URL_BASE = 'http://127.0.0.1';
const CHROME_EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';
const FIXTURE_COMPLETION_ENABLED = process.env.NODE_ENV === 'test';
const AUTHORIZATION_BEARER_PREFIX = 'Bearer ';
const IP_HMAC_SECRET_ENVIRONMENT_VARIABLE = 'TOPSKIP_IP_HMAC_SECRET';
const LOCAL_IP_HMAC_SECRET = 'topskip-local-development';
const MAX_CAPABILITIES_HEADER_BYTES = 2_048;
const MAX_CAPABILITIES_HEADER_COUNT = 16;
const MAX_CAPABILITY_NAME_LENGTH = 64;
const MAX_JOB_ID_LENGTH = 160;
const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOW_HEADERS = `Authorization, Content-Type, ${TOPSKIP_CAPABILITIES_HEADER_NAME}`;
const CORS_MAX_AGE_SEC = 86_400;

/**
 * Result of parsing the local API request body at the HTTP boundary.
 */
type ReadJsonBodyResult =
    | { ok: true; body: unknown }
    | { ok: false; statusCode: 400 | 413; body: ErrorResponse };

/**
 * Server factory options keep public auth tests explicit while preserving local fixtures.
 */
type BackendHttpServerOptions = {
    requireAuth?: boolean;
    now?: () => number;
    production?: boolean;
};

/**
 * Authenticated request identity contains hashes only.
 */
type AuthenticatedRequest = {
    installationHash: string;
    ipHash: string;
};

/**
 * Request-scoped negotiation and correlation prevent capabilities leaking across calls.
 */
type BackendHttpRequestContext = {
    requireAuth: boolean;
    production: boolean;
    now: () => number;
    requestId: string;
    typedErrors: boolean;
    extensionVersion: string | undefined;
};

/**
 * Bounded route templates prevent path parameters or arbitrary URLs entering logs.
 */
type BackendRouteTemplate =
    | '/v1/health'
    | '/v1/config'
    | '/v1/installations/register'
    | '/v1/analysis'
    | '/v1/analysis/jobs/{jobId}'
    | '/v1/analysis/jobs/{jobId}/fixture-result'
    | 'unmatched';

/**
 * Owns the minimal local HTTP server for the server-first tracer bullet;
 * static API only.
 */
export class BackendHttpServer {
    /**
     * Creates an unstarted Node HTTP server for tests or the dev script.
     *
     * @param options - Optional public-auth policy and deterministic clock.
     * @returns Local backend HTTP server.
     */
    static create(options: BackendHttpServerOptions = {}): Server {
        const requireAuth =
            options.requireAuth ?? process.env.NODE_ENV !== 'test';
        const production =
            options.production ?? process.env.NODE_ENV === 'production';
        const now = options.now ?? Date.now;
        return createServer((req, res) => {
            const startedAtMs = Date.now();
            const url = BackendHttpServer.parseRequestUrl(req.url);
            const requestContext: BackendHttpRequestContext = {
                requireAuth,
                production,
                now,
                requestId: `request-${randomUUID()}`,
                typedErrors: BackendHttpServer.headerSupportsTypedErrors(req),
                extensionVersion: undefined,
            };
            BackendHttpServer.applyCorsHeaders(req, res, production);
            const route = BackendHttpServer.routeTemplate(url);
            BackendServerAnalysisLog.info('http-received', {
                requestId: requestContext.requestId,
                method: req.method,
                route,
            });
            res.once('finish', () => {
                BackendServerAnalysisLog.info('http-completed', {
                    requestId: requestContext.requestId,
                    method: req.method,
                    route,
                    statusCode: res.statusCode,
                    elapsedMs: Date.now() - startedAtMs,
                });
            });
            void BackendHttpServer.route(req, res, requestContext).catch(() => {
                BackendHttpServer.handleRouteFailure(res, requestContext);
            });
        });
    }

    /**
     * Starts the local backend on the configured development address.
     *
     * @returns Nothing.
     */
    static listen(): void {
        BackendServerConfig.prepare();
        BackendPublicState.assertReady();
        BackendServerAnalysisLog.enable();
        const ytDlpVersion = YtDlpBinary.assertAvailable();
        const server = BackendHttpServer.create();
        const host = process.env.TOPSKIP_HOST ?? DEFAULT_BACKEND_HOST;
        const port = BackendHttpServer.readPort(
            process.env.TOPSKIP_PORT,
            DEFAULT_BACKEND_PORT,
        );
        server.listen(port, host, () => {
            console.info(
                `TopSkip backend listening on http://${host}:${port} (yt-dlp ${ytDlpVersion})`,
            );
        });
    }

    /**
     * Routes only the health and analysis endpoints needed by this slice.
     *
     * @param req - Incoming Node request.
     * @param res - Node response writer.
     * @param context - Request-scoped auth, clock, correlation, and capabilities.
     * @returns Promise that resolves after the response is written.
     */
    private static async route(
        req: IncomingMessage,
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): Promise<void> {
        const url = BackendHttpServer.parseRequestUrl(req.url);

        if (req.method === 'OPTIONS') {
            BackendHttpServer.handleCorsPreflight(req, res, context);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/v1/health') {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_OK,
                BackendAnalysisApi.health(),
            );
            return;
        }

        if (req.method === 'GET' && url.pathname === '/v1/config') {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_OK,
                v.parse(serverConfigResponseSchema, {
                    apiVersion: SERVER_ANALYSIS_API_VERSION,
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    supportedCapabilities: [
                        ...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
                    ],
                    supportIssueBaseUrl:
                        BackendServerConfig.supportIssueBaseUrl(),
                }),
            );
            return;
        }

        if (
            req.method === 'POST' &&
            url.pathname === '/v1/installations/register'
        ) {
            BackendHttpServer.handleRegistration(req, res, context);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/v1/analysis') {
            await BackendHttpServer.handleAnalysis(req, res, context);
            return;
        }

        const jobRoute = BackendHttpServer.parseJobRoute(url);
        if (jobRoute !== null) {
            if (req.method === 'GET' && jobRoute.kind === 'status') {
                const authenticated = BackendHttpServer.authenticate(
                    req,
                    res,
                    context,
                );
                if (authenticated === null) {
                    return;
                }
                const result = BackendAnalysisApi.handleJobStatusRequest(
                    jobRoute.jobId,
                    {
                        nowMs: context.now(),
                        installationHash: authenticated.installationHash,
                    },
                );
                BackendHttpServer.sendJson(
                    res,
                    result.statusCode,
                    context.requireAuth
                        ? BackendHttpServer.formatNegotiatedResponse(
                              result.body,
                              context.typedErrors,
                          )
                        : result.body,
                );
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

        const notFound = BackendHttpServer.error(
            SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
        );
        BackendHttpServer.sendJson(
            res,
            HTTP_STATUS_NOT_FOUND,
            context.requireAuth
                ? BackendHttpServer.formatNegotiatedResponse(
                      notFound,
                      context.typedErrors,
                  )
                : notFound,
        );
    }

    /**
     * Converts request-body failures into typed responses before API handling.
     *
     * @param req - Incoming analysis request stream.
     * @param res - Node response writer.
     * @param context - Request-scoped auth, clock, correlation, and capabilities.
     * @returns Promise that resolves after the response is written.
     */
    private static async handleAnalysis(
        req: IncomingMessage,
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): Promise<void> {
        if (!BackendHttpServer.isTrustedMutation(req, context.production)) {
            const failure = BackendHttpServer.error(
                SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
            );
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_NOT_FOUND,
                context.requireAuth
                    ? BackendHttpServer.formatNegotiatedResponse(
                          failure,
                          context.typedErrors,
                      )
                    : failure,
            );
            return;
        }
        const authenticated = BackendHttpServer.authenticate(req, res, context);
        if (authenticated === null) {
            return;
        }
        const readResult = await BackendHttpServer.readJsonBody(req);
        if (!readResult.ok) {
            const body = context.requireAuth
                ? BackendHttpServer.formatNegotiatedResponse(
                      readResult.body,
                      context.typedErrors,
                  )
                : readResult.body;
            BackendHttpServer.sendJson(res, readResult.statusCode, body);
            return;
        }

        context.typedErrors =
            context.typedErrors ||
            BackendHttpServer.validBodySupportsTypedErrors(readResult.body);
        const parsedRequest = v.safeParse(
            serverAnalysisRequestSchema,
            readResult.body,
        );
        if (parsedRequest.success) {
            context.extensionVersion = parsedRequest.output.extensionVersion;
        }

        const result = BackendAnalysisApi.handleAnalysisRequest(
            readResult.body,
            {
                nowMs: context.now(),
                context: context.requireAuth
                    ? {
                          ...authenticated,
                          requestId: context.requestId,
                      }
                    : undefined,
            },
        );
        BackendServerAnalysisLog.info('analysis-request-handled', {
            requestId: context.requestId,
            videoId: BackendHttpServer.readValidatedVideoId(readResult.body),
            resultStatus: result.body.status,
            jobId:
                result.body.status === 'processing'
                    ? result.body.jobId
                    : undefined,
        });
        BackendHttpServer.sendJson(
            res,
            result.statusCode,
            context.requireAuth
                ? BackendHttpServer.formatNegotiatedResponse(
                      result.body,
                      context.typedErrors,
                  )
                : result.body,
        );
    }

    /**
     * Issues a bounded anonymous credential without accepting a request body.
     *
     * @param req - Registration request used only for trusted origin and IP identity.
     * @param res - Response writer.
     * @param context - Request negotiation and deterministic registration clock.
     */
    private static handleRegistration(
        req: IncomingMessage,
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): void {
        if (!BackendHttpServer.isTrustedMutation(req, context.production)) {
            const failure = BackendHttpServer.error(
                SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
            );
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_NOT_FOUND,
                context.requireAuth
                    ? BackendHttpServer.formatNegotiatedResponse(
                          failure,
                          context.typedErrors,
                      )
                    : failure,
            );
            return;
        }
        const registration = BackendPublicState.registerInstallation({
            ipHash: BackendHttpServer.hashRequestIp(req),
            nowMs: context.now(),
        });
        if (!registration.ok) {
            const failure = {
                status: 'rate_limited',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                    retryAfterSec: registration.retryAfterSec,
                },
            };
            BackendHttpServer.sendJson(
                res,
                429,
                context.requireAuth
                    ? BackendHttpServer.formatNegotiatedResponse(
                          failure,
                          context.typedErrors,
                      )
                    : failure,
            );
            return;
        }
        BackendHttpServer.sendJson(
            res,
            201,
            v.parse(installationRegistrationResponseSchema, {
                status: 'registered',
                token: registration.token,
                expiresAtMs: registration.expiresAtMs,
            }),
        );
    }

    /**
     * Authenticates analysis traffic and spends the global per-install request quota.
     *
     * @param req - Incoming analysis or polling request.
     * @param res - Response writer used for typed auth failures.
     * @param context - Public-auth mode, negotiation, and deterministic clock.
     * @returns Hashed request identity or `null` after an error response.
     */
    private static authenticate(
        req: IncomingMessage,
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): AuthenticatedRequest | null {
        if (!context.requireAuth) {
            return {
                installationHash: 'local-development',
                ipHash: 'local-development',
            };
        }
        const authorization = req.headers.authorization;
        if (
            typeof authorization !== 'string' ||
            !authorization.startsWith(AUTHORIZATION_BEARER_PREFIX)
        ) {
            const failure = BackendHttpServer.error(
                SERVER_ANALYSIS_FAILURE_CODE.TokenMissing,
            );
            BackendHttpServer.sendJson(
                res,
                401,
                BackendHttpServer.formatNegotiatedResponse(
                    failure,
                    context.typedErrors,
                ),
            );
            return null;
        }
        const token = authorization.slice(AUTHORIZATION_BEARER_PREFIX.length);
        const authenticated = BackendPublicState.authenticateInstallation({
            token,
            nowMs: context.now(),
        });
        if (!authenticated.ok) {
            const failure = BackendHttpServer.error(authenticated.code);
            BackendHttpServer.sendJson(
                res,
                401,
                BackendHttpServer.formatNegotiatedResponse(
                    failure,
                    context.typedErrors,
                ),
            );
            return null;
        }
        const quota = BackendPublicState.consumeAuthenticatedRequest({
            installationHash: authenticated.installationHash,
            nowMs: context.now(),
        });
        if (!quota.allowed) {
            const failure = {
                status: 'rate_limited',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                    retryAfterSec: quota.retryAfterSec,
                },
            };
            BackendHttpServer.sendJson(
                res,
                429,
                BackendHttpServer.formatNegotiatedResponse(
                    failure,
                    context.typedErrors,
                ),
            );
            return null;
        }
        return {
            installationHash: authenticated.installationHash,
            ipHash: BackendHttpServer.hashRequestIp(req),
        };
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
        if (!BackendHttpServer.isTrustedMutation(req, false)) {
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_NOT_FOUND,
                BackendHttpServer.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
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
     * Maps raw request paths onto a fixed template vocabulary for logging.
     *
     * @param url - Parsed URL containing an untrusted path.
     * @returns Known route template or the bounded unmatched marker.
     */
    private static routeTemplate(url: URL): BackendRouteTemplate {
        if (url.pathname === '/v1/health') {
            return '/v1/health';
        }
        if (url.pathname === '/v1/config') {
            return '/v1/config';
        }
        if (url.pathname === '/v1/installations/register') {
            return '/v1/installations/register';
        }
        if (url.pathname === '/v1/analysis') {
            return '/v1/analysis';
        }
        const jobRoute = BackendHttpServer.parseJobRoute(url);
        if (jobRoute?.kind === 'status') {
            return '/v1/analysis/jobs/{jobId}';
        }
        if (jobRoute?.kind === 'fixture-result') {
            return '/v1/analysis/jobs/{jobId}/fixture-result';
        }
        return 'unmatched';
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
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
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
                    SERVER_ANALYSIS_FAILURE_CODE.RequestBodyTooLarge,
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
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
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
        const retryAfterSec = BackendHttpServer.readResponseRetryAfterSec(body);
        if (retryAfterSec !== null) {
            res.setHeader('retry-after', String(retryAfterSec));
        }
        res.statusCode = statusCode;
        res.setHeader('content-type', MIME_APPLICATION_JSON);
        res.end(`${JSON.stringify(body)}\n`);
    }

    /**
     * Allows extension and non-browser development clients to mutate the loopback API.
     *
     * @param req - Incoming request whose origin is evaluated.
     * @param production - Whether missing or non-allow-listed origins must be denied.
     * @returns Whether the request can reach a state-changing endpoint.
     */
    private static isTrustedMutation(
        req: IncomingMessage,
        production: boolean,
    ): boolean {
        const origin = req.headers.origin;
        if (origin === undefined) {
            return !production;
        }
        return BackendHttpServer.isAllowedCorsOrigin(origin, production);
    }

    /**
     * Echoes only an approved extension origin and fixed CORS policy headers.
     *
     * @param req - Incoming browser request.
     * @param res - Response receiving CORS headers before routing.
     * @param production - Whether the configured exact allow-list is required.
     */
    private static applyCorsHeaders(
        req: IncomingMessage,
        res: ServerResponse,
        production: boolean,
    ): void {
        const origin = req.headers.origin;
        if (
            typeof origin !== 'string' ||
            !BackendHttpServer.isAllowedCorsOrigin(origin, production)
        ) {
            return;
        }
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', CORS_ALLOW_METHODS);
        res.setHeader('access-control-allow-headers', CORS_ALLOW_HEADERS);
        res.setHeader('access-control-max-age', String(CORS_MAX_AGE_SEC));
    }

    /**
     * Answers browser preflight only for an allowed exact extension origin.
     *
     * @param req - OPTIONS request carrying the candidate origin.
     * @param res - Response writer.
     * @param context - Production policy and negotiated error mode.
     */
    private static handleCorsPreflight(
        req: IncomingMessage,
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): void {
        const origin = req.headers.origin;
        if (
            typeof origin === 'string' &&
            BackendHttpServer.isAllowedCorsOrigin(origin, context.production)
        ) {
            res.statusCode = HTTP_STATUS_NO_CONTENT;
            res.end();
            return;
        }
        const failure = BackendHttpServer.error(
            SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
        );
        BackendHttpServer.sendJson(
            res,
            HTTP_STATUS_NOT_FOUND,
            context.requireAuth
                ? BackendHttpServer.formatNegotiatedResponse(
                      failure,
                      context.typedErrors,
                  )
                : failure,
        );
    }

    /**
     * Requires exact configured release origins while keeping local extension IDs usable.
     *
     * @param origin - Browser Origin header value.
     * @param production - Whether wildcard development matching is disabled.
     * @returns Whether CORS may echo this origin.
     */
    private static isAllowedCorsOrigin(
        origin: string,
        production: boolean,
    ): boolean {
        return production
            ? BackendServerConfig.allowedExtensionOrigins().includes(origin)
            : origin.startsWith(CHROME_EXTENSION_ORIGIN_PREFIX);
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
     * Logs a video identity only after the shared 11-character validation passes.
     *
     * @param input - Parsed untrusted request value.
     * @returns Validated video ID or `undefined` when absent or malformed.
     */
    private static readValidatedVideoId(input: unknown): string | undefined {
        if (
            input === null ||
            typeof input !== 'object' ||
            !('videoId' in input)
        ) {
            return undefined;
        }
        const value: unknown = input.videoId;
        return typeof value === 'string' && isValidYouTubeVideoId(value)
            ? value
            : undefined;
    }

    /**
     * Enforces the public identifier bound while decoding poll route parameters.
     *
     * @param rawJobId - Percent-encoded route segment.
     * @returns Decoded job id, or `null` for malformed encoding.
     */
    private static decodeJobId(rawJobId: string): string | null {
        try {
            const jobId = decodeURIComponent(rawJobId);
            return jobId.length > 0 && jobId.length <= MAX_JOB_ID_LENGTH
                ? jobId
                : null;
        } catch {
            return null;
        }
    }

    /**
     * Keeps malformed request targets inside normal unmatched-route handling.
     *
     * @param raw - Optional raw Node request target.
     * @returns Parsed URL or a fixed unmatched sentinel URL.
     */
    private static parseRequestUrl(raw: string | undefined): URL {
        try {
            return new URL(raw ?? '/', LOCAL_URL_BASE);
        } catch {
            return new URL('/__invalid_request_target__', LOCAL_URL_BASE);
        }
    }

    /**
     * Prevents request-level faults from becoming process-level unhandled rejections.
     *
     * @param res - Response writer that may still accept an error response.
     * @param context - Request correlation and negotiated error mode.
     */
    private static handleRouteFailure(
        res: ServerResponse,
        context: BackendHttpRequestContext,
    ): void {
        const supportId = BackendHttpServer.recordRequestFailureSafely(context);
        if (!res.headersSent && !res.writableEnded) {
            const failure = BackendHttpServer.error(
                SERVER_ANALYSIS_FAILURE_CODE.InternalError,
                supportId,
            );
            BackendHttpServer.sendJson(
                res,
                HTTP_STATUS_INTERNAL_SERVER_ERROR,
                context.requireAuth
                    ? BackendHttpServer.formatNegotiatedResponse(
                          failure,
                          context.typedErrors,
                      )
                    : failure,
            );
        }
        BackendServerAnalysisLog.warn('request-failed', {
            requestId: context.requestId,
            code: SERVER_ANALYSIS_FAILURE_CODE.InternalError,
            supportId,
        });
    }

    /**
     * Builds typed error responses so server and OpenAPI stay aligned.
     *
     * @param code - Stable error code from the local backend contract.
     * @param supportId - Optional persisted correlation for internal faults.
     * @returns Validated error response.
     */
    private static error(
        code:
            | 'invalid_video_id'
            | 'invalid_request'
            | 'request_body_too_large'
            | 'job_not_found'
            | 'token_missing'
            | 'token_invalid'
            | 'token_expired'
            | 'internal_error',
        supportId?: string,
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code, ...(supportId === undefined ? {} : { supportId }) },
        });
    }

    /**
     * Persists one unexpected request failure without risking a second throw.
     *
     * @param context - Request identity and timestamp source.
     * @returns Support identity only when durable recording succeeded.
     */
    private static recordRequestFailureSafely(
        context: BackendHttpRequestContext,
    ): string | undefined {
        try {
            const nowMs = context.now();
            const supportId = BackendPublicState.createSupportId();
            BackendPublicState.recordFailure({
                supportId,
                code: SERVER_ANALYSIS_FAILURE_CODE.InternalError,
                apiVersion: SERVER_ANALYSIS_API_VERSION,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                ...(context.extensionVersion === undefined
                    ? {}
                    : { extensionVersion: context.extensionVersion }),
                createdAtMs: nowMs,
                expiresAtMs: nowMs + FAILURE_RETENTION_MS,
            });
            return supportId;
        } catch {
            return undefined;
        }
    }

    /**
     * Hashes only the trusted Cloudflare client-IP header and otherwise uses a shared unknown bucket.
     *
     * @param req - Incoming request received from loopback/cloudflared.
     * @returns HMAC identity safe for quota persistence.
     */
    private static hashRequestIp(req: IncomingMessage): string {
        const header = req.headers['cf-connecting-ip'];
        const clientIp = typeof header === 'string' ? header : 'unknown';
        const configuredSecret =
            process.env[IP_HMAC_SECRET_ENVIRONMENT_VARIABLE];
        if (
            process.env.NODE_ENV === 'production' &&
            (configuredSecret ?? '').trim().length < 32
        ) {
            throw new Error(
                'TOPSKIP_IP_HMAC_SECRET is required for production IP quotas.',
            );
        }
        const secret = configuredSecret ?? LOCAL_IP_HMAC_SECRET;
        return createHmac('sha256', secret).update(clientIp).digest('hex');
    }

    /**
     * Reads a bounded comma-separated capability header before auth or body parsing.
     *
     * @param req - Incoming public API request.
     * @returns Whether this request explicitly opts into typed errors.
     */
    private static headerSupportsTypedErrors(req: IncomingMessage): boolean {
        const raw = req.headers[TOPSKIP_CAPABILITIES_HEADER_NAME.toLowerCase()];
        if (typeof raw !== 'string') {
            return false;
        }
        if (Buffer.byteLength(raw, 'utf8') > MAX_CAPABILITIES_HEADER_BYTES) {
            return false;
        }
        const capabilities = raw
            .split(',')
            .map((capability) => capability.trim());
        if (
            capabilities.length > MAX_CAPABILITIES_HEADER_COUNT ||
            capabilities.some(
                (capability) =>
                    capability.length === 0 ||
                    capability.length > MAX_CAPABILITY_NAME_LENGTH,
            ) ||
            new Set(capabilities).size !== capabilities.length
        ) {
            return false;
        }
        return capabilities.includes(SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS);
    }

    /**
     * Accepts body negotiation only after the entire analysis request validates.
     *
     * @param raw - Parsed request body at the analysis boundary.
     * @returns Whether a valid analysis body opts into typed errors.
     */
    private static validBodySupportsTypedErrors(raw: unknown): boolean {
        const parsed = v.safeParse(serverAnalysisRequestSchema, raw);
        return (
            parsed.success &&
            parsed.output.client.capabilities.includes(
                SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS,
            )
        );
    }

    /**
     * Maps stable typed failures onto the previous safe v1 envelopes for old installations.
     *
     * @param body - Typed API response produced by current backend code.
     * @param typedErrors - Request-scoped capability negotiation result.
     * @returns Typed response or a message-bearing legacy envelope with no provider details.
     */
    private static formatNegotiatedResponse(
        body: unknown,
        typedErrors: boolean,
    ): unknown {
        if (typedErrors || body === null || typeof body !== 'object') {
            return body;
        }
        const status: unknown = Reflect.get(body, 'status');
        const error: unknown = Reflect.get(body, 'error');
        const errorCode = BackendHttpServer.readErrorCode(error);
        if (status === 'rate_limited') {
            const retryAfterSec = BackendHttpServer.readRetryAfterSec(error);
            return {
                status: 'rate_limited',
                retryAfterSec,
                error: {
                    code: 'rate_limited',
                    message: 'Server analysis is temporarily limited.',
                },
            };
        }
        if (status === 'unavailable') {
            const videoId: unknown = Reflect.get(body, 'videoId');
            const algorithmVersion: unknown = Reflect.get(
                body,
                'algorithmVersion',
            );
            if (
                typeof videoId !== 'string' ||
                typeof algorithmVersion !== 'string'
            ) {
                return body;
            }
            return {
                status: 'unavailable',
                videoId,
                algorithmVersion,
                reason:
                    errorCode === 'fixture_unavailable'
                        ? 'fixture_unavailable'
                        : 'caption_extraction_failed',
                message: 'Caption extraction failed for this video.',
            };
        }
        if (status !== 'error') {
            return body;
        }
        const videoId: unknown = Reflect.get(body, 'videoId');
        const algorithmVersion: unknown = Reflect.get(body, 'algorithmVersion');
        if (
            typeof videoId === 'string' &&
            typeof algorithmVersion === 'string'
        ) {
            return {
                status: 'error',
                videoId,
                algorithmVersion,
                error: {
                    code: BackendHttpServer.legacyTerminalCode(errorCode),
                    message: 'Server analysis failed.',
                },
            };
        }
        return {
            status: 'invalid_request',
            error: {
                code: BackendHttpServer.legacyRequestCode(errorCode),
                message: 'The server could not process this request.',
            },
        };
    }

    /**
     * Reads one stable error code from a typed failure object.
     *
     * @param error - Unknown failure details.
     * @returns Stable code or a generic fallback.
     */
    private static readErrorCode(error: unknown): string {
        if (error === null || typeof error !== 'object') {
            return 'internal_error';
        }
        const code: unknown = Reflect.get(error, 'code');
        return typeof code === 'string' ? code : 'internal_error';
    }

    /**
     * Reads bounded retry metadata for a legacy rate envelope.
     *
     * @param error - Unknown typed failure details.
     * @returns Positive retry seconds.
     */
    private static readRetryAfterSec(error: unknown): number {
        if (error !== null && typeof error === 'object') {
            const retryAfterSec: unknown = Reflect.get(error, 'retryAfterSec');
            if (
                typeof retryAfterSec === 'number' &&
                Number.isInteger(retryAfterSec) &&
                retryAfterSec > 0
            ) {
                return retryAfterSec;
            }
        }
        return 1;
    }

    /**
     * Mirrors retry metadata into the normative HTTP `Retry-After` header.
     *
     * @param body - Typed or safe legacy retry response.
     * @returns Positive whole seconds, or `null` for non-retry responses.
     */
    private static readResponseRetryAfterSec(body: unknown): number | null {
        if (body === null || typeof body !== 'object') {
            return null;
        }
        const status: unknown = Reflect.get(body, 'status');
        if (status !== 'rate_limited') {
            return null;
        }
        const direct: unknown = Reflect.get(body, 'retryAfterSec');
        if (
            typeof direct === 'number' &&
            Number.isInteger(direct) &&
            direct > 0
        ) {
            return direct;
        }
        const error: unknown = Reflect.get(body, 'error');
        if (error === null || typeof error !== 'object') {
            return null;
        }
        const nested: unknown = Reflect.get(error, 'retryAfterSec');
        return typeof nested === 'number' &&
            Number.isInteger(nested) &&
            nested > 0
            ? nested
            : null;
    }

    /**
     * Keeps legacy terminal codes inside the old extension's allow-list.
     *
     * @param code - Current stable failure code.
     * @returns Compatible terminal error code.
     */
    private static legacyTerminalCode(
        code: string,
    ):
        | 'fixture_error'
        | 'invalid_model_response'
        | 'unsafe_model_blocks'
        | 'model_provider_error' {
        if (
            code === 'fixture_error' ||
            code === 'invalid_model_response' ||
            code === 'unsafe_model_blocks' ||
            code === 'model_provider_error'
        ) {
            return code;
        }
        return 'model_provider_error';
    }

    /**
     * Keeps legacy request codes inside the old extension's allow-list.
     *
     * @param code - Current stable failure code.
     * @returns Compatible request error code.
     */
    private static legacyRequestCode(
        code: string,
    ):
        | 'invalid_video_id'
        | 'invalid_request'
        | 'request_body_too_large'
        | 'job_not_found' {
        if (
            code === 'invalid_video_id' ||
            code === 'request_body_too_large' ||
            code === 'job_not_found'
        ) {
            return code;
        }
        return 'invalid_request';
    }

    /**
     * Parses an environment port without allowing invalid listener configuration.
     *
     * @param raw - Optional decimal port string.
     * @param fallback - Development port used when absent.
     * @returns Valid TCP port.
     */
    private static readPort(raw: string | undefined, fallback: number): number {
        if (raw === undefined) {
            return fallback;
        }
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
            throw new Error('TOPSKIP_PORT must be a valid TCP port.');
        }
        return port;
    }
}

if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    BackendHttpServer.listen();
}
