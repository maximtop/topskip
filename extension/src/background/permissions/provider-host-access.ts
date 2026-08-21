import browser from '@/shared/browser';
import {
    PROVIDER_HOST_ACCESS_STATUS,
    PROVIDER_HOST_PERMISSION,
    type HostPermissionProviderId,
    type ProviderHostAccessStatus,
} from '@/shared/provider-host-permissions';
import { PROVIDER_ID } from '@/shared/providers';

/**
 * Reads optional provider grants at the background-owned network boundary.
 */
export class ProviderHostAccess {
    /**
     * Permission API failures are conservative because provider I/O must not
     * proceed unless Chrome positively confirms the exact optional origin.
     *
     * @param providerId - Provider whose current host grant is inspected.
     * @returns Granted only when Chrome confirms the provider origin.
     */
    static async status(
        providerId: HostPermissionProviderId,
    ): Promise<ProviderHostAccessStatus> {
        try {
            const isGranted = await browser.permissions.contains({
                origins: [PROVIDER_HOST_PERMISSION[providerId].origin],
            });
            return isGranted
                ? PROVIDER_HOST_ACCESS_STATUS.Granted
                : PROVIDER_HOST_ACCESS_STATUS.Missing;
        } catch {
            return PROVIDER_HOST_ACCESS_STATUS.Missing;
        }
    }

    /**
     * Gives provider call sites a boolean guard while preserving one source of
     * permission semantics in `status()`.
     *
     * @param providerId - Provider whose current host grant is inspected.
     * @returns Whether Chrome currently confirms the provider origin.
     */
    static async isGranted(
        providerId: HostPermissionProviderId,
    ): Promise<boolean> {
        const status = await ProviderHostAccess.status(providerId);
        return status === PROVIDER_HOST_ACCESS_STATUS.Granted;
    }

    /**
     * Produces a stable settings snapshot in provider display order.
     *
     * @returns Access statuses for every optional provider host.
     */
    static async all(): Promise<
        Record<HostPermissionProviderId, ProviderHostAccessStatus>
    > {
        const [openRouterStatus, openAiStatus] = await Promise.all([
            ProviderHostAccess.status(PROVIDER_ID.OpenRouter),
            ProviderHostAccess.status(PROVIDER_ID.OpenAI),
        ]);
        return {
            [PROVIDER_ID.OpenRouter]: openRouterStatus,
            [PROVIDER_ID.OpenAI]: openAiStatus,
        };
    }
}
