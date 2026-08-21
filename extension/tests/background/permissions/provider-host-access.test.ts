import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_HOST_ACCESS_STATUS,
    PROVIDER_HOST_PERMISSION,
} from '@/shared/provider-host-permissions';
import { PROVIDER_ID } from '@/shared/providers';

const permissionsContains = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: {
        permissions: {
            contains: (permissions: unknown): Promise<unknown> => {
                const result: unknown = permissionsContains(permissions);
                return Promise.resolve(result);
            },
        },
    },
}));

const { ProviderHostAccess } =
    await import('@/background/permissions/provider-host-access');

describe('ProviderHostAccess', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        PROVIDER_ID.OpenRouter,
        PROVIDER_ID.OpenAI,
    ] as const)('checks the exact optional origin for %s', async (providerId) => {
        permissionsContains.mockResolvedValue(true);

        await expect(ProviderHostAccess.status(providerId)).resolves.toBe(
            PROVIDER_HOST_ACCESS_STATUS.Granted,
        );
        expect(permissionsContains).toHaveBeenCalledWith({
            origins: [PROVIDER_HOST_PERMISSION[providerId].origin],
        });
    });

    it('maps a missing grant to the missing status', async () => {
        permissionsContains.mockResolvedValue(false);

        await expect(
            ProviderHostAccess.status(PROVIDER_ID.OpenRouter),
        ).resolves.toBe(PROVIDER_HOST_ACCESS_STATUS.Missing);
        await expect(
            ProviderHostAccess.isGranted(PROVIDER_ID.OpenRouter),
        ).resolves.toBe(false);
    });

    it('treats permission API rejection as missing access', async () => {
        permissionsContains.mockRejectedValue(new Error('permission failure'));

        await expect(
            ProviderHostAccess.status(PROVIDER_ID.OpenAI),
        ).resolves.toBe(PROVIDER_HOST_ACCESS_STATUS.Missing);
        await expect(
            ProviderHostAccess.isGranted(PROVIDER_ID.OpenAI),
        ).resolves.toBe(false);
    });

    it('returns both provider statuses in deterministic provider order', async () => {
        permissionsContains
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        await expect(ProviderHostAccess.all()).resolves.toEqual({
            [PROVIDER_ID.OpenRouter]: PROVIDER_HOST_ACCESS_STATUS.Missing,
            [PROVIDER_ID.OpenAI]: PROVIDER_HOST_ACCESS_STATUS.Granted,
        });
        expect(permissionsContains.mock.calls).toEqual([
            [
                {
                    origins: [
                        PROVIDER_HOST_PERMISSION[PROVIDER_ID.OpenRouter].origin,
                    ],
                },
            ],
            [
                {
                    origins: [
                        PROVIDER_HOST_PERMISSION[PROVIDER_ID.OpenAI].origin,
                    ],
                },
            ],
        ]);
    });
});
