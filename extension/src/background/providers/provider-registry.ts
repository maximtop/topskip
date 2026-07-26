import type { LlmProviderAdapter } from '@/background/providers/llm-provider-adapter';

/**
 * Immutable lookup of registered LLM provider adapters.
 * Created once at background init; not modifiable afterward.
 */
export class ProviderRegistry {
    /**
     * Frozen id → adapter map built in the constructor.
     */
    private readonly adapters: ReadonlyMap<string, LlmProviderAdapter>;

    /**
     * Builds a frozen registry from the given adapters.
     * If duplicate IDs are provided, the last entry wins.
     *
     * @param adapters - Adapters to register.
     */
    constructor(adapters: LlmProviderAdapter[]) {
        const map = new Map<string, LlmProviderAdapter>();
        for (const a of adapters) {
            map.set(a.id, a);
        }
        this.adapters = map;
    }

    /**
     * Looks up an adapter by its unique identifier.
     *
     * @param id - Provider identifier (e.g. `'openrouter'`).
     * @returns The adapter, or `undefined` if not registered.
     */
    get(id: string | null | undefined): LlmProviderAdapter | undefined {
        if (typeof id !== 'string' || id.length === 0) {
            return undefined;
        }
        return this.adapters.get(id);
    }

    /**
     * Returns all registered adapters in registration order.
     *
     * @returns Array of all adapters.
     */
    getAll(): LlmProviderAdapter[] {
        return [...this.adapters.values()];
    }
}
