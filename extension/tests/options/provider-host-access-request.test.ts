import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_HOST_ACCESS_REQUEST_OUTCOME,
    PROVIDER_HOST_PERMISSION,
} from '@/shared/provider-host-permissions';
import { PROVIDER_ID } from '@/shared/providers';

const permissionsContains = vi.fn();
const permissionsRequest = vi.fn();
const runtimeSendMessage = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: {
        permissions: {
            contains: permissionsContains,
            request: permissionsRequest,
        },
        runtime: {
            sendMessage: runtimeSendMessage,
        },
    },
}));

const { ProviderHostAccessRequest } =
    await import('@/options/provider-host-access-request');

describe('ProviderHostAccessRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        PROVIDER_ID.OpenRouter,
        PROVIDER_ID.OpenAI,
    ] as const)(
        'starts the exact %s request synchronously without a preflight',
        async (providerId) => {
            let resolveRequest: ((granted: boolean) => void) | undefined;
            permissionsRequest.mockImplementation(
                () =>
                    new Promise<boolean>((resolve) => {
                        resolveRequest = resolve;
                    }),
            );

            const result = ProviderHostAccessRequest.request(providerId);

            expect(permissionsRequest).toHaveBeenCalledWith({
                origins: [PROVIDER_HOST_PERMISSION[providerId].origin],
            });
            expect(permissionsContains).not.toHaveBeenCalled();
            expect(runtimeSendMessage).not.toHaveBeenCalled();

            resolveRequest?.(true);
            await expect(result).resolves.toBe(
                PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted,
            );
        },
    );

    it('maps an explicit refusal to denied', async () => {
        permissionsRequest.mockResolvedValue(false);

        await expect(
            ProviderHostAccessRequest.request(PROVIDER_ID.OpenRouter),
        ).resolves.toBe(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied);
    });

    it('maps a rejected permission request to a safe failure', async () => {
        permissionsRequest.mockRejectedValue(new Error('raw rejection'));

        await expect(
            ProviderHostAccessRequest.request(PROVIDER_ID.OpenAI),
        ).resolves.toBe(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed);
    });

    it('maps a synchronous browser API failure to a safe failure', async () => {
        permissionsRequest.mockImplementation(() => {
            throw new Error('raw synchronous failure');
        });

        await expect(
            ProviderHostAccessRequest.request(PROVIDER_ID.OpenRouter),
        ).resolves.toBe(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed);
    });
});
