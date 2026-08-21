import { describe, expect, it } from 'vitest';

import { formatLogFields, formatLogStage } from '@/shared/log-fields';

describe('formatLogFields', () => {
    it('renders scalars as bare key=value pairs in insertion order', () => {
        expect(
            formatLogFields({
                videoId: 'dQw4w9WgXcQ',
                tabId: 42,
                enabled: true,
                jobId: null,
            }),
        ).toBe('videoId=dQw4w9WgXcQ tabId=42 enabled=true jobId=null');
    });

    it('skips undefined fields and quotes strings that would blur into neighbours', () => {
        expect(
            formatLogFields({
                jobId: undefined,
                error: 'Timed out waiting',
                empty: '',
                expression: 'a=b',
            }),
        ).toBe('error="Timed out waiting" empty="" expression="a=b"');
    });

    it('keeps nested values on the same line as JSON', () => {
        expect(
            formatLogFields({
                urlShape: { pathname: '/api/timedtext', hasPot: true },
                actions: ['loadModule:captions', 'toggleSubtitlesOn'],
            }),
        ).toBe(
            'urlShape={"pathname":"/api/timedtext","hasPot":true} ' +
                'actions=["loadModule:captions","toggleSubtitlesOn"]',
        );
    });

    it('never throws on values JSON cannot serialize', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        expect(
            formatLogFields({ cyclic, big: BigInt(10), fn: () => 1 }),
        ).toBe(
            'cyclic=[unserializable] big=[unserializable] fn=[unserializable]',
        );
    });
});

describe('formatLogStage', () => {
    it('adds the inline fields only when there are any', () => {
        expect(formatLogStage('worker-started', {})).toEqual([
            'worker-started',
        ]);
        expect(
            formatLogStage('route-decision', { outcome: 'server-request' }),
        ).toEqual(['route-decision', 'outcome=server-request']);
    });
});
