import {
    type ConnectionProviderId,
    type ProviderHostAccessRequiredFailure,
    type TestConnectionKeyResponse,
    parseTestConnectionKeyResponse,
} from '@/shared/messages';
import {
    PROVIDER_HOST_ACCESS_REQUEST_OUTCOME,
    PROVIDER_HOST_ACCESS_STATUS,
    type HostPermissionProviderId,
    type ProviderHostAccessRequestOutcome,
    type ProviderHostAccessStatus,
} from '@/shared/provider-host-permissions';

/**
 * Current row facts needed to choose an explicit access/test route.
 */
export type ProviderHostAccessActionInput = {
    providerId: ConnectionProviderId;
    hasCredential: boolean;
    hostAccessStatus: ProviderHostAccessStatus;
};

/**
 * UI and transport effects keep gesture ordering testable without rendering.
 */
export type ProviderHostAccessActionEffects = {
    request(
        providerId: HostPermissionProviderId,
    ): Promise<ProviderHostAccessRequestOutcome>;
    reload(): Promise<boolean>;
    sendTest(providerId: ConnectionProviderId): Promise<unknown>;
    showKeyRequired(providerId: ConnectionProviderId): void;
    showRequestOutcome(
        providerId: ConnectionProviderId,
        outcome: ProviderHostAccessRequestOutcome,
    ): void;
    applyTestResponse(
        providerId: ConnectionProviderId,
        value: TestConnectionKeyResponse,
    ): void;
    showTestUnavailable(providerId: ConnectionProviderId): void;
    showReloadUnavailable(providerId: ConnectionProviderId): void;
    clearFeedback(providerId: ConnectionProviderId): void;
    markAccessMissing(providerId: ConnectionProviderId): void;
};

/**
 * Coordinates user-initiated grants without introducing a pre-request await.
 *
 * Static API only.
 */
export class ProviderHostAccessActions {
    /**
     * One active action per provider prevents repeated clicks from opening
     * duplicate prompts or provider requests while the first one settles.
     */
    private static readonly activeProviderIds =
        new Set<ConnectionProviderId>();

    /**
     * Starts a grant synchronously and refreshes settings only after success.
     *
     * @param input - Provider row facts captured by the click handler.
     * @param effects - Injected permission and UI effects.
     * @returns Nothing; completion is reflected through effects.
     */
    static grant(
        input: ProviderHostAccessActionInput,
        effects: ProviderHostAccessActionEffects,
    ): void {
        if (ProviderHostAccessActions.isActive(input.providerId)) {
            return;
        }
        const request = effects.request(input.providerId);
        ProviderHostAccessActions.activeProviderIds.add(input.providerId);
        void ProviderHostAccessActions.finishGrant(
            input.providerId,
            request,
            effects,
        );
    }

    /**
     * Tests only when a credential exists, requesting missing access directly
     * from the same click stack.
     *
     * @param input - Provider row facts captured by the click handler.
     * @param effects - Injected permission, transport, and UI effects.
     * @returns Nothing; completion is reflected through effects.
     */
    static test(
        input: ProviderHostAccessActionInput,
        effects: ProviderHostAccessActionEffects,
    ): void {
        if (!input.hasCredential) {
            effects.showKeyRequired(input.providerId);
            return;
        }
        if (ProviderHostAccessActions.isActive(input.providerId)) {
            return;
        }
        if (
            input.hostAccessStatus ===
            PROVIDER_HOST_ACCESS_STATUS.Granted
        ) {
            ProviderHostAccessActions.activeProviderIds.add(
                input.providerId,
            );
            void ProviderHostAccessActions.finishTest(
                input.providerId,
                effects,
            );
            return;
        }

        const request = effects.request(input.providerId);
        ProviderHostAccessActions.activeProviderIds.add(input.providerId);
        void ProviderHostAccessActions.finishAccessThenTest(
            input.providerId,
            request,
            effects,
        );
    }

    /**
     * Reads the provider lock without performing UI, runtime, or permission I/O.
     *
     * @param providerId - Provider selected by the current click.
     * @returns Whether another action already owns that provider row.
     */
    private static isActive(providerId: ConnectionProviderId): boolean {
        return ProviderHostAccessActions.activeProviderIds.has(providerId);
    }

    /**
     * Releases only the provider that completed, allowing different providers
     * to remain independent.
     *
     * @param providerId - Provider whose action reached a terminal path.
     * @returns Nothing.
     */
    private static release(providerId: ConnectionProviderId): void {
        ProviderHostAccessActions.activeProviderIds.delete(providerId);
    }

    /**
     * Names the extension-only stale-grant branch before applying UI effects.
     *
     * @param response - Strictly parsed connection-test response.
     * @returns Whether background reports that this provider lost host access.
     */
    private static isHostAccessRequired(
        response: TestConnectionKeyResponse,
    ): response is ProviderHostAccessRequiredFailure {
        return !response.ok && 'code' in response;
    }

    /**
     * Converts settings refresh failures into one safe UI effect without
     * exposing runtime response or exception text.
     *
     * @param providerId - Provider whose action requires fresh settings.
     * @param effects - Injected settings and safe-state effects.
     * @returns Whether the settings snapshot refreshed successfully.
     */
    private static async reloadSettings(
        providerId: ConnectionProviderId,
        effects: ProviderHostAccessActionEffects,
    ): Promise<boolean> {
        try {
            if (await effects.reload()) {
                return true;
            }
        } catch {
            // The safe effect below intentionally replaces raw runtime text.
        }
        effects.showReloadUnavailable(providerId);
        return false;
    }

    /**
     * Keeps denied and failed grants local while a successful grant refreshes
     * the permission snapshot once.
     *
     * @param providerId - Provider whose request is settling.
     * @param request - Promise started synchronously by the public entrypoint.
     * @param effects - Injected settings effects.
     * @returns Promise settled after the chosen UI effect completes.
     */
    private static async finishGrant(
        providerId: ConnectionProviderId,
        request: Promise<ProviderHostAccessRequestOutcome>,
        effects: ProviderHostAccessActionEffects,
    ): Promise<void> {
        try {
            const outcome = await request;
            if (outcome === PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted) {
                effects.clearFeedback(providerId);
                await ProviderHostAccessActions.reloadSettings(
                    providerId,
                    effects,
                );
                return;
            }
            effects.showRequestOutcome(providerId, outcome);
        } finally {
            ProviderHostAccessActions.release(providerId);
        }
    }

    /**
     * Continues a connection test only after Chrome confirms the explicit grant.
     *
     * @param providerId - Provider selected by the click.
     * @param request - Promise started synchronously by the public entrypoint.
     * @param effects - Injected settings and test effects.
     * @returns Promise settled after grant handling and any test request.
     */
    private static async finishAccessThenTest(
        providerId: ConnectionProviderId,
        request: Promise<ProviderHostAccessRequestOutcome>,
        effects: ProviderHostAccessActionEffects,
    ): Promise<void> {
        try {
            const outcome = await request;
            if (outcome !== PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted) {
                effects.showRequestOutcome(providerId, outcome);
                return;
            }
            effects.clearFeedback(providerId);
            const settingsAvailable =
                await ProviderHostAccessActions.reloadSettings(
                    providerId,
                    effects,
                );
            if (!settingsAvailable) {
                return;
            }
            await ProviderHostAccessActions.applyTestResult(
                providerId,
                effects,
            );
        } finally {
            ProviderHostAccessActions.release(providerId);
        }
    }

    /**
     * Classifies the untrusted runtime reply before any UI state can consume it.
     *
     * @param providerId - Provider whose credential is tested.
     * @param effects - Injected transport and safe-state effects.
     * @returns Promise settled after the response is classified.
     */
    private static async finishTest(
        providerId: ConnectionProviderId,
        effects: ProviderHostAccessActionEffects,
    ): Promise<void> {
        try {
            await ProviderHostAccessActions.applyTestResult(
                providerId,
                effects,
            );
        } finally {
            ProviderHostAccessActions.release(providerId);
        }
    }

    /**
     * Applies one test result while the caller retains ownership of the provider
     * lock across an optional grant and settings reload.
     *
     * @param providerId - Provider whose credential is tested.
     * @param effects - Injected transport and safe-state effects.
     * @returns Promise settled after the response is classified.
     */
    private static async applyTestResult(
        providerId: ConnectionProviderId,
        effects: ProviderHostAccessActionEffects,
    ): Promise<void> {
        let rawResponse: unknown;
        try {
            rawResponse = await effects.sendTest(providerId);
        } catch {
            effects.showTestUnavailable(providerId);
            return;
        }
        const response = parseTestConnectionKeyResponse(rawResponse);
        if (response === null) {
            effects.showTestUnavailable(providerId);
            return;
        }
        if (ProviderHostAccessActions.isHostAccessRequired(response)) {
            if (response.providerId !== providerId) {
                effects.showTestUnavailable(providerId);
                return;
            }
            effects.markAccessMissing(providerId);
            effects.applyTestResponse(providerId, response);
            return;
        }
        if (!response.ok) {
            effects.showTestUnavailable(providerId);
            return;
        }
        effects.applyTestResponse(providerId, response);
    }
}
