import { vi, type Mock } from 'vitest';

/**
 * Key selector shapes `chrome.storage.StorageArea.get` accepts.
 */
export type StorageKeys =
    | string
    | string[]
    | Record<string, unknown>
    | null
    | undefined;

/**
 * In-memory stand-in for one `browser.storage` area. Every method is a
 * `vi.fn` so a test can override one call (`mockRejectedValueOnce`) and then
 * `restore()` the Chrome-like defaults; `data` is the backing object.
 */
export type MemoryStorageArea = {
    data: Record<string, unknown>;
    get: Mock<(keys?: StorageKeys) => Promise<Record<string, unknown>>>;
    set: Mock<(items: Record<string, unknown>) => Promise<void>>;
    remove: Mock<(keys: string | string[]) => Promise<void>>;
    clear: Mock<() => Promise<void>>;
    getBytesInUse: Mock<(keys?: string | string[] | null) => Promise<number>>;
    bytesInUse(): number;
    restore(): void;
    reset(): void;
};

const UTF8 = new TextEncoder();

/**
 * Normalizes a key selector to the list of keys it names.
 *
 * @param keys - Selector (`null`/`undefined` = every key).
 * @param all - Every key currently stored.
 * @returns Keys to read.
 */
function toKeyList(keys: string | string[] | null | undefined, all: string[]): string[] {
    if (keys === null || keys === undefined) {
        return all;
    }
    return typeof keys === 'string' ? [keys] : keys;
}

/**
 * Chrome's byte accounting: UTF-8 length of the key plus the JSON value.
 *
 * @param data - Backing object.
 * @param wanted - Keys to account for.
 * @returns Accounted bytes.
 */
function bytesOf(data: Record<string, unknown>, wanted: ReadonlySet<string>): number {
    return Object.entries(data)
        .filter(([key]) => wanted.has(key))
        .reduce(
            (sum, [key, value]) =>
                sum +
                UTF8.encode(key).byteLength +
                UTF8.encode(JSON.stringify(value) ?? '').byteLength,
            0,
        );
}

/**
 * Creates a fresh in-memory storage area with Chrome-like semantics.
 *
 * @returns Storage area whose methods are `vi.fn` mocks.
 */
export function createMemoryStorageArea(): MemoryStorageArea {
    const data: Record<string, unknown> = {};
    const area: MemoryStorageArea = {
        data,
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
        getBytesInUse: vi.fn(),
        bytesInUse: () => bytesOf(data, new Set(Object.keys(data))),
        restore: () => {
            area.get.mockImplementation((keys) => {
                if (keys !== null && typeof keys === 'object' && !Array.isArray(keys)) {
                    const out: Record<string, unknown> = {};
                    for (const [key, fallback] of Object.entries(keys)) {
                        out[key] = key in data ? structuredClone(data[key]) : fallback;
                    }
                    return Promise.resolve(out);
                }
                const out: Record<string, unknown> = {};
                for (const key of toKeyList(keys, Object.keys(data))) {
                    if (key in data) {
                        out[key] = structuredClone(data[key]);
                    }
                }
                return Promise.resolve(out);
            });
            area.set.mockImplementation((items) => {
                for (const [key, value] of Object.entries(items)) {
                    if (value !== undefined) {
                        data[key] = structuredClone(value);
                    }
                }
                return Promise.resolve();
            });
            area.remove.mockImplementation((keys) => {
                for (const key of toKeyList(keys, [])) {
                    delete data[key];
                }
                return Promise.resolve();
            });
            area.clear.mockImplementation(() => {
                for (const key of Object.keys(data)) {
                    delete data[key];
                }
                return Promise.resolve();
            });
            area.getBytesInUse.mockImplementation((keys) =>
                Promise.resolve(bytesOf(data, new Set(toKeyList(keys, Object.keys(data))))),
            );
        },
        reset: () => {
            for (const key of Object.keys(data)) {
                delete data[key];
            }
            area.get.mockReset();
            area.set.mockReset();
            area.remove.mockReset();
            area.clear.mockReset();
            area.getBytesInUse.mockReset();
            area.restore();
        },
    };
    area.restore();
    return area;
}
