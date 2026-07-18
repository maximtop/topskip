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
import { BackendServerAnalysisBoundary } from '@topskip/backend/server-analysis-boundary';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';
import {
    BACKEND_CAPTION_SOURCE,
    BackendServerConfig,
    type BackendCaptionSource,
} from '@topskip/backend/server-config';
import { BackendPublicState } from '@topskip/backend/public-state';
import { MIME_APPLICATION_JSON } from '@topskip/common/constants';
import {
    errorResponseSchema,
    installationRegistrationResponseEmissionSchema,
    isValidYouTubeVideoId,
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
    SERVER_ANALYSIS_MAX_REQUEST_BODY_BYTES,
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
    serverConfigResponseEmissionSchema,
    TOPSKIP_CAPABILITIES_HEADER_NAME,
    type ErrorResponse,
} from '@topskip/common/server-analysis-contract';

const DEFAULT_BACKEND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 8787;
const MAX_AUXILIARY_JSON_BODY_BYTES = 32_768;
const ANALYSIS_BODY_READ_TIMEOUT_MS = 12_000;
const MAX_CONCURRENT_ANALYSIS_BODY_READS = 4;
const CAPACITY_RETRY_AFTER_SEC = 3;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_CONTENT_TOO_LARGE = 413;
const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
const HTTP_STATUS_NOT_FOUND = 404;
const LOCAL_URL_BASE = 'http://127.0.0.1';
const CHROME_EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';
const FIXTURE_COMPLETION_ENABLED = process.env.NODE_ENV === 'test';
const AUTHORIZATION_BEARER_PREFIX = 'Bearer ';
const IP_HMAC_SECRET_ENVIRONMENT_VARIABLE = 'TOPSKIP_IP_HMAC_SECRET';
const LOCAL_IP_HMAC_SECRET = 'topskip-local-development';
const MAX_JOB_ID_LENGTH = 160;
const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
const CORS_ALLOW_HEADERS = `Authorization, Content-Type, ${TOPSKIP_CAPABILITIES_HEADER_NAME}`;
const CORS_MAX_AGE_SEC = 86_400;

let activeAnalysisBodyReads = 0;

/**
 * Result of parsing the local API request body at the HTTP boundary.
 */
type ReadJsonBodyResult =
    | { ok: true; body: unknown }
    | {
          ok: false;
          statusCode: 400 | 408 | 413 | 415 | 503;
          body: unknown;
          closeConnection?: boolean;
      };

/**
 * Raw reader settings keep the large public upload isolated from small fixture routes.
 */
type ReadJsonBodyOptions = {
    maxBytes: number;
    timeoutMs: number;
    reserveAnalysisSlot: boolean;
};

/**
 * Server factory options keep public auth tests explicit while preserving local fixtures.
 */
type BackendHttpServerOptions = {
    requireAuth?: boolean;
    now?: () => number;
    production?: boolean;
    captionSource?: BackendCaptionSource;
    analysisBodyReadTimeoutMs?: number;
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
    captionSource: BackendCaptionSource;
    requestId: string;
    extensionVersion: string | undefined;
    analysisBodyReadTimeoutMs: number;
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
        const captionSource =
            options.captionSource ?? BACKEND_CAPTION_SOURCE.ExtensionUpload;
        return createServer((req, res) => {
            const startedAtMs = Date.now();
            const url = BackendHttpServer.parseRequestUrl(req.url);
            const requestContext: BackendHttpRequestContext = {
                requireAuth,
                production,
                now,
                captionSource,
                requestId: `request-${randomUUID()}`,
                extensionVersion: undefined,
                analysisBodyReadTimeoutMs:
                    options.analysisBodyReadTimeoutMs ??
                    ANALYSIS_BODY_READ_TIMEOUT_MS,
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
        const runtimeConfig = BackendServerConfig.prepare();
        BackendPublicState.assertReady();
        BackendServerAnalysisLog.enable();
        if (
            runtimeConfig.captionSource === BACKEND_CAPTION_SOURCE.LegacyYtDlp
        ) {
            YtDlpBinary.assertAvailable();
        }
        const server = BackendHttpServer.create({
            captionSource: runtimeConfig.captionSource,
        });
        const host = process.env.TOPSKIP_HOST ?? DEFAULT_BACKEND_HOST;
        const port = BackendHttpServer.readPort(
            process.env.TOPSKIP_PORT,
            DEFAULT_BACKEND_PORT,
        );
        server.listen(port, host, () => {
            console.info(
                `TopSkip backend listening on http://${host}:${port} (captionSource ${runtimeConfig.captionSource})`,
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
                v.parse(serverConfigResponseEmissionSchema, {
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
                    BackendHttpServer.serializeAnalysisResponse(
                        result.body,
                        context,
                    ),
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
            BackendHttpServer.serializeAnalysisResponse(notFound, context),
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
            );
            return;
        }
        const authenticated = BackendHttpServer.authenticate(req, res, context);
        if (authenticated === null) {
            return;
        }
        const readResult = await BackendHttpServer.readJsonBody(req, {
            maxBytes: SERVER_ANALYSIS_MAX_REQUEST_BODY_BYTES,
            timeoutMs: context.analysisBodyReadTimeoutMs,
            reserveAnalysisSlot: true,
        });
        if (!readResult.ok) {
            BackendHttpServer.prepareBodyReadFailureConnection(
                req,
                res,
                readResult,
            );
            const body = BackendHttpServer.serializeAnalysisResponse(
                readResult.body,
                context,
            );
            BackendHttpServer.sendJson(res, readResult.statusCode, body);
            return;
        }

        const parsedRequest = BackendServerAnalysisBoundary.forSource(
            context.captionSource,
        ).parseRequest(readResult.body);
        if (!parsedRequest.success) {
            const failure = BackendHttpServer.error(
                SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
            );
            BackendHttpServer.sendJson(
                res,
                400,
                BackendHttpServer.serializeAnalysisResponse(failure, context),
            );
            return;
        }
        context.extensionVersion = parsedRequest.output.extensionVersion;

        const result = BackendAnalysisApi.handleAnalysisRequest(
            parsedRequest.output,
            {
                nowMs: context.now(),
                context: context.requireAuth
                    ? {
                          ...authenticated,
                          requestId: context.requestId,
                      }
                    : undefined,
                captionSource: context.captionSource,
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
            BackendHttpServer.serializeAnalysisResponse(result.body, context),
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
            );
            return;
        }
        BackendHttpServer.sendJson(
            res,
            201,
            v.parse(installationRegistrationResponseEmissionSchema, {
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
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
        const readResult = await BackendHttpServer.readJsonBody(req, {
            maxBytes: MAX_AUXILIARY_JSON_BODY_BYTES,
            timeoutMs: ANALYSIS_BODY_READ_TIMEOUT_MS,
            reserveAnalysisSlot: false,
        });
        if (!readResult.ok) {
            BackendHttpServer.prepareBodyReadFailureConnection(
                req,
                res,
                readResult,
            );
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
     * Reads raw JSON bytes within one deadline and an optional large-body slot.
     *
     * @param req - Incoming Node request stream.
     * @param options - Per-route byte, deadline, and concurrency policy.
     * @returns Parsed JSON body or a typed request error.
     */
    private static async readJsonBody(
        req: IncomingMessage,
        options: ReadJsonBodyOptions,
    ): Promise<ReadJsonBodyResult> {
        if (
            !BackendHttpServer.hasJsonContentType(req) ||
            !BackendHttpServer.hasIdentityContentEncoding(req)
        ) {
            return {
                ok: false,
                statusCode: HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
                body: BackendHttpServer.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
                closeConnection: true,
            };
        }

        const declaredLength = BackendHttpServer.readContentLength(req);
        if (declaredLength === 'invalid') {
            return {
                ok: false,
                statusCode: 400,
                body: BackendHttpServer.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
                closeConnection: true,
            };
        }
        if (
            typeof declaredLength === 'number' &&
            declaredLength > options.maxBytes
        ) {
            return {
                ok: false,
                statusCode: HTTP_STATUS_CONTENT_TOO_LARGE,
                body: BackendHttpServer.error(
                    SERVER_ANALYSIS_FAILURE_CODE.RequestBodyTooLarge,
                ),
                closeConnection: true,
            };
        }

        const releaseSlot = options.reserveAnalysisSlot
            ? BackendHttpServer.reserveAnalysisBodyReadSlot()
            : () => undefined;
        if (releaseSlot === null) {
            return {
                ok: false,
                statusCode: HTTP_STATUS_SERVICE_UNAVAILABLE,
                body: BackendHttpServer.rateLimitedError(
                    SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
                    CAPACITY_RETRY_AFTER_SEC,
                ),
                closeConnection: true,
            };
        }

        return await new Promise<ReadJsonBodyResult>((resolve) => {
            const chunks: Buffer[] = [];
            let byteLength = 0;
            let settled = false;

            const cleanup = (): void => {
                clearTimeout(timeout);
                req.off('data', onData);
                req.off('end', onEnd);
                req.off('aborted', onAborted);
                req.off('close', onClose);
                req.off('error', onError);
                releaseSlot();
            };
            const finish = (result: ReadJsonBodyResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(result);
            };
            const invalidRequest = (closeConnection: boolean): void => {
                finish({
                    ok: false,
                    statusCode: 400,
                    body: BackendHttpServer.error(
                        SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                    ),
                    ...(closeConnection ? { closeConnection: true } : {}),
                });
            };
            const onData = (chunk: Buffer): void => {
                byteLength += chunk.byteLength;
                if (byteLength > options.maxBytes) {
                    req.pause();
                    finish({
                        ok: false,
                        statusCode: HTTP_STATUS_CONTENT_TOO_LARGE,
                        body: BackendHttpServer.error(
                            SERVER_ANALYSIS_FAILURE_CODE.RequestBodyTooLarge,
                        ),
                        closeConnection: true,
                    });
                    return;
                }
                chunks.push(chunk);
            };
            const onEnd = (): void => {
                if (byteLength === 0) {
                    finish({ ok: true, body: {} });
                    return;
                }
                try {
                    const decoded = new TextDecoder('utf-8', {
                        fatal: true,
                    }).decode(Buffer.concat(chunks, byteLength));
                    finish({
                        ok: true,
                        body: JSON.parse(decoded) as unknown,
                    });
                } catch {
                    invalidRequest(false);
                }
            };
            const onAborted = (): void => invalidRequest(true);
            const onClose = (): void => {
                if (!req.complete) {
                    invalidRequest(true);
                }
            };
            const onError = (): void => invalidRequest(true);
            const timeout = setTimeout(() => {
                req.pause();
                finish({
                    ok: false,
                    statusCode: HTTP_STATUS_REQUEST_TIMEOUT,
                    body: BackendHttpServer.error(
                        SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                    ),
                    closeConnection: true,
                });
            }, options.timeoutMs);
            timeout.unref();

            req.on('data', onData);
            req.once('end', onEnd);
            req.once('aborted', onAborted);
            req.once('close', onClose);
            req.once('error', onError);
        });
    }

    /**
     * Reserves one of four process-wide upload buffers and returns an idempotent release.
     *
     * @returns Release callback, or `null` when the fail-fast capacity is full.
     */
    private static reserveAnalysisBodyReadSlot(): (() => void) | null {
        if (activeAnalysisBodyReads >= MAX_CONCURRENT_ANALYSIS_BODY_READS) {
            return null;
        }
        activeAnalysisBodyReads += 1;
        let released = false;
        return (): void => {
            if (released) {
                return;
            }
            released = true;
            activeAnalysisBodyReads -= 1;
        };
    }

    /**
     * Parses a decimal Content-Length without accepting ambiguous or unsafe values.
     *
     * @param req - Incoming request carrying the optional length header.
     * @returns Nonnegative length, `undefined`, or the invalid marker.
     */
    private static readContentLength(
        req: IncomingMessage,
    ): number | 'invalid' | undefined {
        const raw = req.headers['content-length'];
        if (raw === undefined) {
            return undefined;
        }
        if (!/^\d+$/u.test(raw)) {
            return 'invalid';
        }
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) ? parsed : 'invalid';
    }

    /**
     * Closes uploads that were deliberately left unread only after the safe response flushes.
     *
     * @param req - Incoming body stream to stop reusing.
     * @param res - Response whose completion precedes socket destruction.
     * @param failure - Body-read failure carrying the connection policy.
     * @returns Nothing.
     */
    private static prepareBodyReadFailureConnection(
        req: IncomingMessage,
        res: ServerResponse,
        failure: Extract<ReadJsonBodyResult, { ok: false }>,
    ): void {
        if (failure.closeConnection !== true) {
            return;
        }
        res.setHeader('connection', 'close');
        res.once('finish', () => req.destroy());
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
            BackendHttpServer.serializeAnalysisResponse(failure, context),
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
        if (typeof contentType !== 'string') {
            return false;
        }
        const separatorIndex = contentType.indexOf(';');
        const mediaType = contentType
            .slice(
                0,
                separatorIndex === -1 ? contentType.length : separatorIndex,
            )
            .trim()
            .toLowerCase();
        return mediaType === MIME_APPLICATION_JSON;
    }

    /**
     * Refuses compressed request bodies because the byte bound applies to wire input directly.
     *
     * @param req - Incoming request whose content encoding is evaluated.
     * @returns Whether the body is absent from encoding transforms.
     */
    private static hasIdentityContentEncoding(req: IncomingMessage): boolean {
        const contentEncoding = req.headers['content-encoding'];
        return (
            contentEncoding === undefined ||
            (typeof contentEncoding === 'string' &&
                contentEncoding.trim().toLowerCase() === 'identity')
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
                BackendHttpServer.serializeAnalysisResponse(failure, context),
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
     * Builds a bounded retry response for pre-buffer process capacity.
     *
     * @param code - Safe rate or capacity code.
     * @param retryAfterSec - Whole-second retry delay mirrored into HTTP headers.
     * @returns Strict response candidate for the process-selected serializer.
     */
    private static rateLimitedError(
        code: 'rate_limited' | 'capacity_limited',
        retryAfterSec: number,
    ): unknown {
        return {
            status: 'rate_limited',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code, retryAfterSec },
        };
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
     * Prevents a response from crossing the process-selected contract boundary.
     *
     * @param body - Candidate analysis response produced by backend orchestration.
     * @param context - Immutable caption-source selection captured by `create`.
     * @returns Strictly validated response for the selected process mode.
     */
    private static serializeAnalysisResponse(
        body: unknown,
        context: BackendHttpRequestContext,
    ): unknown {
        return BackendServerAnalysisBoundary.forSource(
            context.captionSource,
        ).serializeResponse(body);
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
