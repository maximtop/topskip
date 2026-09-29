/**
 * Minimal `MessageEvent` stand-in for a stubbed `window` that only needs the
 * `type`/`data`/`source` fields the `message` listener reads.
 */
export class TestMessageEvent<T = unknown> {
    readonly type: string;

    readonly data: T | undefined;

    readonly source: unknown;

    constructor(type: string, init: { data?: T; source?: unknown } = {}) {
        this.type = type;
        this.data = init.data;
        this.source = init.source;
    }
}
