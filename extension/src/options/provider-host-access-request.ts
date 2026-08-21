import browser from '@/shared/browser';
import {
    PROVIDER_HOST_ACCESS_REQUEST_OUTCOME,
    PROVIDER_HOST_PERMISSION,
    type HostPermissionProviderId,
    type ProviderHostAccessRequestOutcome,
} from '@/shared/provider-host-permissions';

/**
 * Starts optional-host grants inside the originating options-page gesture.
 *
 * Static API only.
 */
export class ProviderHostAccessRequest {
    /**
     * Calls Chrome before any asynchronous boundary can consume user activation.
     *
     * @param providerId - Provider whose single optional origin is requested.
     * @returns Safe grant outcome without exposing browser exception text.
     */
    static request(
        providerId: HostPermissionProviderId,
    ): Promise<ProviderHostAccessRequestOutcome> {
        let request: Promise<boolean>;
        try {
            request = browser.permissions.request({
                origins: [PROVIDER_HOST_PERMISSION[providerId].origin],
            });
        } catch {
            return Promise.resolve(
                PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed,
            );
        }
        return request.then(
            (granted) =>
                granted
                    ? PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted
                    : PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied,
            () => PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed,
        );
    }
}
