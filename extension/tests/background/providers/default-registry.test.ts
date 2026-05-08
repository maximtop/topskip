import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: vi.fn().mockResolvedValue({}),
                set: vi.fn().mockResolvedValue(undefined),
            },
        },
    },
}));

import { defaultRegistry } from '@/background/providers/default-registry';

describe('defaultRegistry', () => {
    it('registers both selectable providers for the options UI', () => {
        const ids = defaultRegistry
            .getAll()
            .map((adapter) => adapter.id)
            .sort();

        expect(ids).toEqual(['chrome-prompt-api', 'openrouter']);
    });
});
