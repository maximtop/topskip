import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackendPublicState } from '@topskip/backend/public-state';

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ARTIFACT_RETENTION_MS = 30 * DAY_MS;
const MAX_ARTIFACT_COUNT = 10_000;
const LOW_DISK_ARTIFACT_COUNT = 100;
const ARTIFACT_VIDEO_ID = 'dQw4w9WgXcQ';
const ARTIFACT_ALGORITHM_VERSION = 'server-v4';

function seedArtifacts(
    path: string,
    input: { count: number; firstCompletedAtMs: number },
): void {
    BackendPublicState.closeForTests();
    const database = new DatabaseSync(path);
    const insert = database.prepare(
        `INSERT INTO analysis_artifacts
            (record_id, video_id, algorithm_version, completed_at_ms, expires_at_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    database.exec('BEGIN IMMEDIATE');
    try {
        for (let index = 0; index < input.count; index += 1) {
            const recordId = `seed-${String(index)}`;
            const completedAtMs = input.firstCompletedAtMs + index;
            insert.run(
                recordId,
                ARTIFACT_VIDEO_ID,
                ARTIFACT_ALGORITHM_VERSION,
                completedAtMs,
                completedAtMs + ARTIFACT_RETENTION_MS,
                JSON.stringify({
                    recordId,
                    video: {
                        videoId: ARTIFACT_VIDEO_ID,
                        algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                    },
                    job: { completedAtMs },
                }),
            );
        }
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    } finally {
        database.close();
    }
    BackendPublicState.configureForTests(path);
}

describe('BackendPublicState', () => {
    let directory = '';

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'topskip-public-state-'));
        BackendPublicState.configureForTests(join(directory, 'topskip.sqlite'));
    });

    afterEach(() => {
        BackendPublicState.resetForTests();
        rmSync(directory, { force: true, recursive: true });
    });

    it('probes SQLite readiness before serving traffic', () => {
        expect(() => BackendPublicState.assertReady()).not.toThrow();
    });

    it('issues hashed installation credentials and distinguishes expiry', () => {
        const nowMs = 1_900_000_000_000;
        const issued = BackendPublicState.registerInstallation({
            ipHash: 'ip-hash',
            nowMs,
        });
        expect(issued.ok).toBe(true);
        if (!issued.ok) {
            throw new Error('Expected installation registration.');
        }

        expect(issued.token).toHaveLength(43);
        expect(
            BackendPublicState.authenticateInstallation({
                token: issued.token,
                nowMs,
            }),
        ).toEqual({ ok: true, installationHash: issued.installationHash });
        expect(
            BackendPublicState.authenticateInstallation({
                token: issued.token,
                nowMs: issued.expiresAtMs,
            }),
        ).toEqual({ ok: false, code: 'token_expired' });
        expect(BackendPublicState.snapshotForTests().serialized).not.toContain(
            issued.token,
        );
    });

    it('enforces ten registrations per IP and returns a retry delay', () => {
        const nowMs = 1_900_000_000_000;
        for (let index = 0; index < 10; index += 1) {
            expect(
                BackendPublicState.registerInstallation({
                    ipHash: 'same-ip',
                    nowMs: nowMs + index,
                }).ok,
            ).toBe(true);
        }

        const denied = BackendPublicState.registerInstallation({
            ipHash: 'same-ip',
            nowMs: nowMs + 11,
        });
        expect(denied.ok).toBe(false);
        if (denied.ok) {
            throw new Error('Expected registration quota denial.');
        }
        expect(denied.retryAfterSec).toBeGreaterThan(0);
    });

    it('allows 120 authenticated requests per minute before throttling', () => {
        const nowMs = 1_900_000_000_000;
        const decisions = Array.from({ length: 120 }, () =>
            BackendPublicState.consumeAuthenticatedRequest({
                installationHash: 'authenticated-installation',
                nowMs,
            }),
        );

        expect(decisions.every((decision) => decision.allowed)).toBe(true);
        expect(
            BackendPublicState.consumeAuthenticatedRequest({
                installationHash: 'authenticated-installation',
                nowMs,
            }),
        ).toEqual({ allowed: false, retryAfterSec: 60 });
        expect(
            BackendPublicState.consumeAuthenticatedRequest({
                installationHash: 'authenticated-installation',
                nowMs: nowMs + MINUTE_MS,
            }),
        ).toEqual({ allowed: true });
    });

    it('keeps cold quotas separate for installation and IP windows', () => {
        const nowMs = 1_900_000_000_000;
        for (let index = 0; index < 5; index += 1) {
            expect(
                BackendPublicState.consumeColdJobQuota({
                    installationHash: 'installation-a',
                    ipHash: 'ip-a',
                    nowMs: nowMs + index,
                }).allowed,
            ).toBe(true);
        }

        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'installation-a',
                ipHash: 'ip-a',
                nowMs: nowMs + 6,
            }),
        ).toMatchObject({ allowed: false });
        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'installation-b',
                ipHash: 'ip-a',
                nowMs: nowMs + 7,
            }).allowed,
        ).toBe(true);
    });

    it('enforces twenty cold jobs per installation across a day', () => {
        const nowMs = 1_900_000_000_000;
        for (let batchIndex = 0; batchIndex < 4; batchIndex += 1) {
            for (let jobIndex = 0; jobIndex < 5; jobIndex += 1) {
                expect(
                    BackendPublicState.consumeColdJobQuota({
                        installationHash: 'daily-installation',
                        ipHash: 'daily-installation-ip',
                        nowMs: nowMs + batchIndex * 2 * HOUR_MS + jobIndex,
                    }).allowed,
                ).toBe(true);
            }
        }

        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'daily-installation',
                ipHash: 'daily-installation-ip',
                nowMs: nowMs + 8 * HOUR_MS,
            }),
        ).toMatchObject({ allowed: false });
        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'daily-installation',
                ipHash: 'daily-installation-ip',
                nowMs: nowMs + DAY_MS,
            }),
        ).toEqual({ allowed: true });
    });

    it('enforces twenty cold jobs per IP across an hour', () => {
        const nowMs = 1_900_000_000_000;
        for (let index = 0; index < 20; index += 1) {
            expect(
                BackendPublicState.consumeColdJobQuota({
                    installationHash: `hourly-ip-installation-${String(index)}`,
                    ipHash: 'hourly-ip',
                    nowMs,
                }).allowed,
            ).toBe(true);
        }

        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'hourly-ip-denied-installation',
                ipHash: 'hourly-ip',
                nowMs,
            }),
        ).toEqual({ allowed: false, retryAfterSec: 3_600 });
        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'hourly-ip-reset-installation',
                ipHash: 'hourly-ip',
                nowMs: nowMs + HOUR_MS,
            }),
        ).toEqual({ allowed: true });
    });

    it('enforces sixty cold jobs per IP across a day', () => {
        const nowMs = 1_900_000_000_000;
        for (let batchIndex = 0; batchIndex < 3; batchIndex += 1) {
            for (let jobIndex = 0; jobIndex < 20; jobIndex += 1) {
                expect(
                    BackendPublicState.consumeColdJobQuota({
                        installationHash: `daily-ip-installation-${String(batchIndex)}-${String(jobIndex)}`,
                        ipHash: 'daily-ip',
                        nowMs: nowMs + batchIndex * 2 * HOUR_MS,
                    }).allowed,
                ).toBe(true);
            }
        }

        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'daily-ip-denied-installation',
                ipHash: 'daily-ip',
                nowMs: nowMs + 6 * HOUR_MS,
            }),
        ).toMatchObject({ allowed: false });
        expect(
            BackendPublicState.consumeColdJobQuota({
                installationHash: 'daily-ip-reset-installation',
                ipHash: 'daily-ip',
                nowMs: nowMs + DAY_MS,
            }),
        ).toEqual({ allowed: true });
    });

    it('reserves daily model budget atomically', () => {
        const nowMs = Date.UTC(2030, 0, 2);
        const reservations = Array.from({ length: 14 }, () =>
            BackendPublicState.reserveModelBudget({ nowMs }),
        );
        expect(reservations.every((reservation) => reservation !== null)).toBe(
            true,
        );
        expect(BackendPublicState.reserveModelBudget({ nowMs })).toBeNull();

        const first = reservations[0];
        if (first === null) {
            throw new Error('Expected a model budget reservation.');
        }
        BackendPublicState.settleModelBudget({
            reservationId: first.reservationId,
            costUsd: 0.01,
        });
        expect(BackendPublicState.reserveModelBudget({ nowMs })).not.toBeNull();
    });

    it('stops at the monthly model budget across independent daily periods', () => {
        const monthStartedAtMs = Date.UTC(2030, 0, 1);
        for (let dayIndex = 0; dayIndex < 20; dayIndex += 1) {
            const reservation = BackendPublicState.reserveModelBudget({
                nowMs: monthStartedAtMs + dayIndex * DAY_MS,
            });
            if (reservation === null) {
                throw new Error('Expected monthly model budget capacity.');
            }
            BackendPublicState.settleModelBudget({
                reservationId: reservation.reservationId,
                costUsd: 4.9,
            });
        }

        const finalReservation = BackendPublicState.reserveModelBudget({
            nowMs: monthStartedAtMs + 20 * DAY_MS,
        });
        if (finalReservation === null) {
            throw new Error('Expected final monthly model budget capacity.');
        }
        BackendPublicState.settleModelBudget({
            reservationId: finalReservation.reservationId,
            costUsd: 1.8,
        });

        expect(
            BackendPublicState.reserveModelBudget({
                nowMs: monthStartedAtMs + 20 * DAY_MS + 1,
            }),
        ).toBeNull();
        expect(
            BackendPublicState.reserveModelBudget({
                nowMs: Date.UTC(2030, 1, 1),
            }),
        ).not.toBeNull();
    });

    it('settles stale crash reservations during bounded housekeeping', () => {
        const nowMs = Date.UTC(2030, 0, 2);
        const reservation = BackendPublicState.reserveModelBudget({ nowMs });
        if (reservation === null) {
            throw new Error('Expected model budget reservation.');
        }

        BackendPublicState.registerInstallation({
            ipHash: 'housekeeping-ip',
            nowMs: nowMs + 60 * 60 * 1_000 + 1,
        });

        const snapshot = BackendPublicState.snapshotForTests().serialized;
        expect(snapshot).not.toContain(reservation.reservationId);
        expect(snapshot).toContain('"reserved_usd":0');
        expect(snapshot).toContain('"spent_usd":0.35');
    });

    it('persists artifacts and safe support failures across reopen', () => {
        const path = join(directory, 'topskip.sqlite');
        BackendPublicState.upsertArtifact({
            recordId: 'artifact-1',
            video: {
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v4',
            },
            job: { completedAtMs: 1_900_000_000_000 },
        });
        BackendPublicState.upsertArtifact({
            recordId: 'artifact-2',
            video: {
                videoId: 'M7lc1UVf-VE',
                algorithmVersion: 'server-v4',
            },
            job: { completedAtMs: 1_900_000_000_001 },
        });
        BackendPublicState.recordFailure({
            supportId: 'support-1',
            code: 'internal_error',
            videoId: 'dQw4w9WgXcQ',
            jobId: 'job-1',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_902_592_000_000,
        });

        BackendPublicState.closeForTests();
        BackendPublicState.configureForTests(path);

        expect(
            BackendPublicState.findArtifacts({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v4',
            }),
        ).toHaveLength(1);
        expect(BackendPublicState.findFailureForTests('support-1')).toEqual({
            supportId: 'support-1',
            code: 'internal_error',
            videoId: 'dQw4w9WgXcQ',
            jobId: 'job-1',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_902_592_000_000,
        });
    });

    it('expires artifacts and safe support failures after thirty days', () => {
        const completedAtMs = Date.now() + DAY_MS;
        const expiresAtMs = completedAtMs + ARTIFACT_RETENTION_MS;
        BackendPublicState.upsertArtifact({
            recordId: 'expiring-artifact',
            video: {
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
            },
            job: { completedAtMs },
        });
        BackendPublicState.recordFailure({
            supportId: 'expiring-support',
            code: 'internal_error',
            createdAtMs: completedAtMs,
            expiresAtMs,
        });

        expect(
            BackendPublicState.findArtifacts({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                nowMs: completedAtMs,
            }),
        ).toHaveLength(1);
        expect(
            BackendPublicState.findFailureForTests('expiring-support'),
        ).not.toBeNull();

        expect(
            BackendPublicState.findArtifacts({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                nowMs: expiresAtMs,
            }),
        ).toEqual([]);
        expect(
            BackendPublicState.findFailureForTests('expiring-support'),
        ).toBeNull();
    });

    it('retains at most ten thousand newest artifacts', () => {
        const path = join(directory, 'topskip.sqlite');
        const firstCompletedAtMs = Date.now() + DAY_MS;
        seedArtifacts(path, {
            count: MAX_ARTIFACT_COUNT,
            firstCompletedAtMs,
        });
        BackendPublicState.setStorageHeadroomForTests(true);
        BackendPublicState.upsertArtifact({
            recordId: 'count-limit-newest',
            video: {
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
            },
            job: { completedAtMs: firstCompletedAtMs + MAX_ARTIFACT_COUNT },
        });

        const artifacts = BackendPublicState.findArtifacts({
            videoId: ARTIFACT_VIDEO_ID,
            algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
            nowMs: firstCompletedAtMs,
        });
        expect(artifacts).toHaveLength(MAX_ARTIFACT_COUNT);
        expect(artifacts).not.toContainEqual(
            expect.objectContaining({ recordId: 'seed-0' }),
        );
        expect(artifacts).toContainEqual(
            expect.objectContaining({ recordId: 'count-limit-newest' }),
        );
    });

    it('retains only one hundred newest artifacts under low disk pressure', () => {
        const path = join(directory, 'topskip.sqlite');
        const firstCompletedAtMs = Date.now() + DAY_MS;
        seedArtifacts(path, {
            count: LOW_DISK_ARTIFACT_COUNT,
            firstCompletedAtMs,
        });
        BackendPublicState.setStorageHeadroomForTests(false);
        BackendPublicState.upsertArtifact({
            recordId: 'low-disk-newest',
            video: {
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
            },
            job: {
                completedAtMs: firstCompletedAtMs + LOW_DISK_ARTIFACT_COUNT,
            },
        });

        const artifacts = BackendPublicState.findArtifacts({
            videoId: ARTIFACT_VIDEO_ID,
            algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
            nowMs: firstCompletedAtMs,
        });
        expect(artifacts).toHaveLength(LOW_DISK_ARTIFACT_COUNT);
        expect(artifacts).not.toContainEqual(
            expect.objectContaining({ recordId: 'seed-0' }),
        );
        expect(artifacts).toContainEqual(
            expect.objectContaining({ recordId: 'low-disk-newest' }),
        );
    });
});
