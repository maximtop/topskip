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

    it('prints nothing under release-like defines (default gate)', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        DevConsole.info(['hello']);
        DevConsole.warn(['careful']);

        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('forwards every argument verbatim when enabled', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        DevConsole.info(['[TopSkip] availability →', 'raw', '→', 'mapped'], true);
        DevConsole.warn(['[TopSkip] failed:', { chunkIndex: 2 }], true);

        expect(info).toHaveBeenCalledWith(
            '[TopSkip] availability →',
            'raw',
            '→',
            'mapped',
        );
        expect(warn).toHaveBeenCalledWith('[TopSkip] failed:', { chunkIndex: 2 });
    });
});
