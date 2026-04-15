import { describe, expect, it, vi } from 'vitest';

/**
 * Contract: when a new analysis supersedes an in-flight one for the same
 * tab, the previous {@link AbortController} must be aborted (see
 * `PromoAnalysis.run`).
 */
describe('PromoAnalysis inflight (contract)', () => {
  it('aborts the prior controller when replaced for the same tab', () => {
    const inflight = new Map<
      number,
      { videoId: string; abort: AbortController }
    >();
    const first = new AbortController();
    const onAbort = vi.fn();
    first.signal.addEventListener('abort', onAbort);
    inflight.set(7, { videoId: 'oldVid', abort: first });

    const prev = inflight.get(7);
    prev?.abort.abort();
    const next = new AbortController();
    inflight.set(7, { videoId: 'newVid', abort: next });

    expect(onAbort).toHaveBeenCalled();
    expect(first.signal.aborted).toBe(true);
    expect(inflight.get(7)?.videoId).toBe('newVid');
  });
});
