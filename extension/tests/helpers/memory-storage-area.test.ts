import { describe, expect, it, vi } from 'vitest';

const storage = await vi.hoisted(async () => {
    const { createMemoryStorageArea } = await import('./memory-storage-area');
    return { local: createMemoryStorageArea() };
});

vi.mock('@/shared/browser', () => ({
    default: { storage: { local: storage.local } },
}));

import browser from '@/shared/browser';

describe('createMemoryStorageArea', () => {
    it('round-trips through the mocked browser facade with Chrome-like get shapes', async () => {
        await browser.storage.local.set({ a: 1, b: { x: [1, 2] }, u: undefined });
        await expect(browser.storage.local.get('a')).resolves.toEqual({ a: 1 });
        await expect(browser.storage.local.get(null)).resolves.toEqual({
            a: 1,
            b: { x: [1, 2] },
        });
        await expect(browser.storage.local.get(['a', 'zzz'])).resolves.toEqual({ a: 1 });
        await expect(browser.storage.local.get({ zzz: 'dflt' })).resolves.toEqual({
            zzz: 'dflt',
        });
        await browser.storage.local.remove('a');
        expect(storage.local.data).toEqual({ b: { x: [1, 2] } });
        await expect(browser.storage.local.getBytesInUse(null)).resolves.toBe(
            1 + '{"x":[1,2]}'.length,
        );
        expect(storage.local.bytesInUse()).toBe(1 + '{"x":[1,2]}'.length);
    });

    it('returns clones, honours one-off overrides and restores the defaults', async () => {
        await browser.storage.local.set({ b: { x: [1] } });
        const read = await browser.storage.local.get('b');
        (read.b as { x: number[] }).x.push(2);
        await expect(browser.storage.local.get('b')).resolves.toEqual({ b: { x: [1] } });

        storage.local.set.mockRejectedValueOnce(new Error('boom'));
        await expect(browser.storage.local.set({ c: 1 })).rejects.toThrow('boom');
        await browser.storage.local.set({ c: 1 });
        expect(storage.local.data.c).toBe(1);

        storage.local.get.mockResolvedValue({ forced: true });
        await expect(browser.storage.local.get('c')).resolves.toEqual({ forced: true });
        storage.local.restore();
        await expect(browser.storage.local.get('c')).resolves.toEqual({ c: 1 });

        storage.local.reset();
        expect(storage.local.data).toEqual({});
        expect(storage.local.set).not.toHaveBeenCalled();
        await browser.storage.local.clear();
        expect(storage.local.data).toEqual({});
    });
});
