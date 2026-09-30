import { vi } from 'vitest';

/**
 * Minimal `Element`/`HTMLElement` stand-in: attribute storage, a fake
 * `classList.contains`, and a `remove()` that notifies whoever installed it
 * (mirrors the DOM removal the caption bridge relies on to detect teardown).
 */
export class TestElement extends EventTarget {
    id = '';

    textContent: string | null = null;

    offsetParent: object | null = {};

    readonly classList = {
        contains: vi.fn(() => false),
    };

    private readonly attributes = new Map<string, string>();

    private removeHandler: (() => void) | null = null;

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    setRemoveHandler(handler: () => void): void {
        this.removeHandler = handler;
    }

    remove(): void {
        this.removeHandler?.();
    }

    click(): void {
        this.dispatchEvent(new Event('click'));
    }
}
