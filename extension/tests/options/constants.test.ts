import { describe, expect, it } from 'vitest';

import {
    OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS,
    OPTIONS_DIAGNOSTICS_REFRESH_MS,
    OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS,
    OPTIONS_SECTION_HASH_PREFIX,
} from '@/options/constants';

const DIAGNOSTICS_REFRESH_UPPER_BOUND_MS = 5_000;
const BUNDLE_TIMEOUT_UPPER_BOUND_MS = 3_000;

describe('options constants', () => {
    it('keeps the Diagnostics status cadence within the five-second bound', () => {
        expect(OPTIONS_DIAGNOSTICS_REFRESH_MS).toBeGreaterThan(0);
        expect(OPTIONS_DIAGNOSTICS_REFRESH_MS).toBeLessThanOrEqual(
            DIAGNOSTICS_REFRESH_UPPER_BOUND_MS,
        );
    });

    it('keeps the on-click bundle read inside transient activation', () => {
        expect(OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS).toBeGreaterThan(0);
        expect(OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS).toBeLessThanOrEqual(
            BUNDLE_TIMEOUT_UPPER_BOUND_MS,
        );
        expect(OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it('revokes object URLs well after the browser started the download', () => {
        expect(OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS).toBeGreaterThanOrEqual(
            OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS,
        );
        expect(OPTIONS_SECTION_HASH_PREFIX).toBe('#');
    });
});
