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
    it('registers selectable providers for the options UI', () => {
        const ids = defaultRegistry
            .getAll()
            .map((adapter) => adapter.id)
            .sort();

        expect(ids).toEqual(['openai', 'openrouter']);
    });

    it('omits Chrome built-in AI while the build flag is off', () => {
        // Compiled out after benchmarking: 0.054 mean IoU against the annotated
        // fixture. See INCLUDE_CHROME_BUILTIN_PROVIDER in build-modes.ts.
        expect(defaultRegistry.get('chrome-prompt-api')).toBeUndefined();
    });
});
