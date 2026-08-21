import { PROVIDER_ID } from './providers.ts';

/**
 * Providers whose cross-origin network access is granted independently.
 */
export type HostPermissionProviderId =
    | typeof PROVIDER_ID.OpenRouter
    | typeof PROVIDER_ID.OpenAI;

/**
 * Connection rows and host grants cover the same provider set by design.
 */
export type ConnectionProviderId = HostPermissionProviderId;

/**
 * Exact optional host metadata shared by manifest composition and UI status.
 */
export type ProviderHostPermissionDefinition = {
    /**
     * Chrome match pattern requested for this provider.
     */
    origin: string;
    /**
     * Human-readable host shown without protocol or wildcard syntax.
     */
    hostLabel: string;
};

/**
 * Provider hosts remain optional until an explicit Private BYOK action.
 */
export const PROVIDER_HOST_PERMISSION = {
    [PROVIDER_ID.OpenRouter]: {
        origin: 'https://openrouter.ai/*',
        hostLabel: 'openrouter.ai',
    },
    [PROVIDER_ID.OpenAI]: {
        origin: 'https://api.openai.com/*',
        hostLabel: 'api.openai.com',
    },
} as const satisfies Record<
    HostPermissionProviderId,
    ProviderHostPermissionDefinition
>;

/**
 * Manifest optional hosts derive from the provider map to prevent drift.
 */
export const OPTIONAL_PROVIDER_HOST_PERMISSIONS = Object.values(
    PROVIDER_HOST_PERMISSION,
).map((definition) => definition.origin);

/**
 * Runtime-safe states keep saved credentials independent from current grants.
 */
export const PROVIDER_HOST_ACCESS_STATUS = {
    Granted: 'granted',
    Missing: 'missing',
} as const;

/**
 * Current optional-host access serialized to extension UI contexts.
 */
export type ProviderHostAccessStatus =
    (typeof PROVIDER_HOST_ACCESS_STATUS)[keyof typeof PROVIDER_HOST_ACCESS_STATUS];

/**
 * Explicit grant outcomes avoid exposing raw permission API failures.
 */
export const PROVIDER_HOST_ACCESS_REQUEST_OUTCOME = {
    Granted: 'granted',
    Denied: 'denied',
    Failed: 'failed',
} as const;

/**
 * Safe result of one user-initiated optional-host permission request.
 */
export type ProviderHostAccessRequestOutcome =
    (typeof PROVIDER_HOST_ACCESS_REQUEST_OUTCOME)[
        keyof typeof PROVIDER_HOST_ACCESS_REQUEST_OUTCOME
    ];
