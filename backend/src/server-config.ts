import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
    serverConfigResponseSchema,
} from '@topskip/common/server-analysis-contract';

const ROOT_ENV_FILE_NAME = '.env';
const MIN_IP_HMAC_SECRET_LENGTH = 32;
const ALLOWED_EXTENSION_ORIGINS_ENVIRONMENT_VARIABLE =
    'TOPSKIP_ALLOWED_EXTENSION_ORIGINS';
const CHROME_EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/u;
const DEFAULT_SUPPORT_ISSUE_BASE_URL =
    'https://github.com/maximtop/topskip/issues/new';
const SUPPORT_ISSUE_BASE_URL_ENVIRONMENT_VARIABLE =
    'TOPSKIP_SUPPORT_ISSUE_BASE_URL';
const CAPTION_SOURCE_ENVIRONMENT_VARIABLE = 'TOPSKIP_CAPTION_SOURCE';

/**
 * Process-wide caption ownership cannot be selected or changed by a request.
 */
export const BACKEND_CAPTION_SOURCE = {
    ExtensionUpload: 'extension_upload',
    LegacyYtDlp: 'legacy_yt_dlp',
} as const;

/**
 * Allowed startup modes keep legacy extraction explicit and fail closed.
 */
export type BackendCaptionSource =
    (typeof BACKEND_CAPTION_SOURCE)[keyof typeof BACKEND_CAPTION_SOURCE];

/**
 * Frozen startup configuration prevents environment mutation from changing routing.
 */
export type BackendRuntimeConfig = Readonly<{
    captionSource: BackendCaptionSource;
}>;

/**
 * Loads local secrets and rejects incomplete server configuration before I/O starts.
 */
export class BackendServerConfig {
    /**
     * Applies the optional root env file while preserving exported shell values.
     *
     * @param envPath - Explicit path used by tests, or the workspace root `.env`.
     * @returns Frozen process-wide caption source configuration.
     */
    static prepare(
        envPath = resolve(process.cwd(), ROOT_ENV_FILE_NAME),
    ): BackendRuntimeConfig {
        if (existsSync(envPath)) {
            process.loadEnvFile(envPath);
        }
        if ((process.env.OPENROUTER_API_KEY ?? '').trim().length === 0) {
            throw new Error(
                'OPENROUTER_API_KEY is required. Add it to the root .env file or export it before running make server.',
            );
        }
        if (
            process.env.NODE_ENV === 'production' &&
            (process.env.TOPSKIP_IP_HMAC_SECRET ?? '').trim().length <
                MIN_IP_HMAC_SECRET_LENGTH
        ) {
            throw new Error(
                'TOPSKIP_IP_HMAC_SECRET must contain at least 32 characters in production.',
            );
        }
        const allowedOrigins = BackendServerConfig.allowedExtensionOrigins();
        if (
            process.env.NODE_ENV === 'production' &&
            allowedOrigins.length === 0
        ) {
            throw new Error(
                'TOPSKIP_ALLOWED_EXTENSION_ORIGINS must list at least one exact Chrome extension origin in production.',
            );
        }
        BackendServerConfig.supportIssueBaseUrl();
        return Object.freeze({
            captionSource: BackendServerConfig.captionSource(),
        });
    }

    /**
     * Parses exact release extension origins without wildcard or whitespace matching.
     *
     * @returns Unique configured `chrome-extension://<id>` origins.
     */
    static allowedExtensionOrigins(): readonly string[] {
        const raw =
            process.env[ALLOWED_EXTENSION_ORIGINS_ENVIRONMENT_VARIABLE] ?? '';
        if (raw.length === 0) {
            return [];
        }
        const origins = raw.split(',');
        if (
            origins.some(
                (origin) =>
                    origin !== origin.trim() ||
                    !CHROME_EXTENSION_ORIGIN_PATTERN.test(origin),
            ) ||
            new Set(origins).size !== origins.length
        ) {
            throw new Error(
                'TOPSKIP_ALLOWED_EXTENSION_ORIGINS must be a comma-separated list of unique exact chrome-extension:// origins.',
            );
        }
        return origins;
    }

    /**
     * Validates operator-configured GitHub support routing before the server listens.
     *
     * @returns Safe HTTPS GitHub new-issue URL exposed by `/v1/config`.
     */
    static supportIssueBaseUrl(): string {
        return v.parse(serverConfigResponseSchema, {
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            supportedCapabilities: [...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES],
            supportIssueBaseUrl:
                process.env[SUPPORT_ISSUE_BASE_URL_ENVIRONMENT_VARIABLE] ??
                DEFAULT_SUPPORT_ISSUE_BASE_URL,
        }).supportIssueBaseUrl;
    }

    /**
     * Accepts only exact operator values so typos cannot silently enable another path.
     *
     * @returns Valid process-wide caption source.
     */
    private static captionSource(): BackendCaptionSource {
        const raw = process.env[CAPTION_SOURCE_ENVIRONMENT_VARIABLE];
        if (
            raw === undefined ||
            raw === BACKEND_CAPTION_SOURCE.ExtensionUpload
        ) {
            return BACKEND_CAPTION_SOURCE.ExtensionUpload;
        }
        if (raw === BACKEND_CAPTION_SOURCE.LegacyYtDlp) {
            return BACKEND_CAPTION_SOURCE.LegacyYtDlp;
        }
        throw new Error(
            'TOPSKIP_CAPTION_SOURCE must be exactly extension_upload or legacy_yt_dlp.',
        );
    }
}
