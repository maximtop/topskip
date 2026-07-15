import { describe, expect, it, vi } from 'vitest';

const operationOrder: string[] = [];
const setAccessLevel = vi.fn(() => {
    operationOrder.push('access');
    return Promise.resolve();
});
const storageGet = vi.fn(() => {
    operationOrder.push('get');
    return Promise.resolve({});
});
const storageSet = vi.fn().mockResolvedValue(undefined);

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                setAccessLevel,
                get: storageGet,
                set: storageSet,
            },
        },
    },
}));

const { PrefsSyncStorage } = await import('@/background/storage/prefs-sync');

describe('PrefsSyncStorage access boundary', () => {
    it('enforces trusted contexts before its first local storage read', async () => {
        await PrefsSyncStorage.ready();

        expect(operationOrder.slice(0, 2)).toEqual(['access', 'get']);
    });
});
