import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { DevConsole } from '@/background/dev-console';

describe('DevConsole', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Vitest compiles __TOPSKIP_INCLUDE_DEV_LOCAL__ to false (release-like),
    // so the observable contract here is silence; the dev branch is a
    // compile-time constant with no logic beyond console.* spreading.
    it('prints nothing under release-like defines', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        DevConsole.info('[TopSkip] availability →', 'raw', '→', 'mapped');
        DevConsole.warn('[TopSkip] failed:', { chunkIndex: 2 });

        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});
