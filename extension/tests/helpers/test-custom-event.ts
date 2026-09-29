/**
 * Minimal `CustomEvent` stand-in for environments (jsdom-less unit tests)
 * where the global does not carry a `detail` payload the way the DOM does.
 */
export class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T | undefined;

    constructor(type: string, init: { detail?: T } = {}) {
        super(type);
        this.detail = init.detail;
    }
}
