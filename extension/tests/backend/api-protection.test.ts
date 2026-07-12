import { beforeEach, describe, expect, it } from 'vitest';

import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@/backend/api-protection';

describe('BackendApiProtection', () => {
    beforeEach(() => {
        BackendApiProtection.resetForTests();
    });

    it('accounts cache lookups separately from cold job starts', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs: 1_900_000_000_000,
            }),
        ).toEqual({ allowed: true, costClass: 'cache_lookup' });

        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 1,
            jobJoins: 0,
            coldJobStarts: 0,
        });
    });

    it('accounts job joins separately from cold job starts', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
                nowMs: 1_900_000_000_000,
            }),
        ).toEqual({ allowed: true, costClass: 'job_join' });

        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 0,
            jobJoins: 1,
            coldJobStarts: 0,
        });
    });

    it('denies cold starts after the local bucket is exhausted', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_000_000,
            }).allowed,
        ).toBe(true);
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_001_000,
            }).allowed,
        ).toBe(true);

        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_002_000,
            }),
        ).toEqual({
            allowed: false,
            costClass: 'cold_job_start',
            retryAfterSec: 58,
        });
    });

    it('rolls the fixed window after the local bucket expires', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_000_000,
            }).allowed,
        ).toBe(true);
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_001_000,
            }).allowed,
        ).toBe(true);

        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_060_000,
            }).allowed,
        ).toBe(true);
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 0,
            jobJoins: 0,
            coldJobStarts: 1,
        });
    });
});
