import { describe, expect, it } from 'vitest';

import {
    MAX_PLAYBACK_DELTA_SEC,
    computeSkipTarget,
    evaluateSkipOnTimeUpdate,
} from '@/content/skip-logic';

describe('computeSkipTarget', () => {
    it('returns null when duration below skip start', () => {
        expect(computeSkipTarget(25)).toBeNull();
    });

    it('returns null for non-finite duration', () => {
        expect(computeSkipTarget(Number.NaN)).toBeNull();
        expect(computeSkipTarget(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('returns skip end for long videos', () => {
        expect(computeSkipTarget(120)).toBe(60);
    });

    it('returns duration when between 30 and 60', () => {
        expect(computeSkipTarget(45)).toBe(45);
    });
});

describe('evaluateSkipOnTimeUpdate', () => {
    const base = {
        skipFired: false,
        enabled: true,
        duration: 120,
        isSeeking: false,
    };

    it('fires skip when crossing 30 with small delta', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            prevTime: 29.5,
            currentTime: 30.1,
        });
        expect(r).toEqual({ action: 'skip', targetTime: 60 });
    });

    it('does not fire when disabled', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            enabled: false,
            prevTime: 29,
            currentTime: 30.5,
        });
        expect(r.action).toBe('none');
    });

    it('does not fire when already skipped', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            skipFired: true,
            prevTime: 29,
            currentTime: 31,
        });
        expect(r.action).toBe('none');
    });

    it('does not fire when seeking', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            isSeeking: true,
            prevTime: 10,
            currentTime: 35,
        });
        expect(r.action).toBe('none');
    });

    it('does not fire on large delta (seek)', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            prevTime: 0,
            currentTime: 45,
        });
        expect(r.action).toBe('none');
    });

    it('does not fire when landing in range without crossing from below 30', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            prevTime: 40,
            currentTime: 45,
        });
        expect(r.action).toBe('none');
    });

    it('does not re-fire at boundary above skip end window', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            prevTime: 29,
            currentTime: 61,
        });
        expect(r.action).toBe('none');
    });

    it('allows delta up to MAX_PLAYBACK_DELTA_SEC', () => {
        const r = evaluateSkipOnTimeUpdate({
            ...base,
            prevTime: 29,
            currentTime: 29 + MAX_PLAYBACK_DELTA_SEC,
        });
        expect(r.action).toBe('skip');
    });
});
