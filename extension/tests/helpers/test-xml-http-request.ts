import { vi } from 'vitest';

/**
 * Minimal `XMLHttpRequest` stand-in: `open`/`send` forward to shared static
 * spies (one instance's mock calls would otherwise be lost once the caption
 * bridge swaps in its own subclass), and `response`/`responseText` are plain
 * writable fields so a test can set them directly before `loadend`.
 */
export class TestXmlHttpRequest extends EventTarget {
    static readonly originalOpen = vi.fn();

    static readonly originalSend = vi.fn();

    response: unknown = '';

    responseText = '';

    responseURL = '';

    status = 0;

    open(...args: unknown[]): void {
        TestXmlHttpRequest.originalOpen(...args);
    }

    send(...args: unknown[]): void {
        TestXmlHttpRequest.originalSend(...args);
    }

    getResponseHeader(): string | null {
        return 'application/json';
    }
}
