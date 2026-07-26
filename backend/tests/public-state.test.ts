import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackendPublicState } from '@topskip/backend/public-state';
import { FrozenPublicStateV2Reader } from './fixtures/public-state-v2-reader';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
} from '@topskip/common/server-analysis-contract';

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ARTIFACT_RETENTION_MS = 30 * DAY_MS;
const MAX_ARTIFACT_COUNT = 10_000;
const LOW_DISK_ARTIFACT_COUNT = 100;
const ARTIFACT_VIDEO_ID = 'dQw4w9WgXcQ';
const ARTIFACT_ALGORITHM_VERSION = 'server-v4';
const UPLOAD_ALGORITHM_VERSION = SERVER_ANALYSIS_ALGORITHM_VERSION;
const TRANSCRIPT_HASH = 'a'.repeat(64);
const OTHER_TRANSCRIPT_HASH = 'b'.repeat(64);

function buildArtifact(input: {
    recordId: string;
    algorithmVersion?: string;
    languageCode?: string;
    transcriptHash?: string;
    sourceType?:
        | 'extension_caption_upload'
        | 'local_fixture'
        | 'youtube_timedtext'
        | 'youtube_yt_dlp';
    completedAtMs?: number;
}): unknown {
    const algorithmVersion = input.algorithmVersion ?? UPLOAD_ALGORITHM_VERSION;
    const sourceType = input.sourceType ?? 'extension_caption_upload';
    const video = {
        videoId: ARTIFACT_VIDEO_ID,
        algorithmVersion,
        ...(input.languageCode === undefined
            ? {}
            : { languageCode: input.languageCode }),
        ...(input.transcriptHash === undefined
            ? {}
            : { transcriptHash: input.transcriptHash }),
        sourceType,
    };
    return {
        recordId: input.recordId,
        video,
        selectedTranscriptArtifact: {
            artifactId: `transcript-${input.recordId}`,
            videoId: ARTIFACT_VIDEO_ID,
            algorithmVersion,
            sourceType,
            languageCode: input.languageCode ?? null,
            ...(input.transcriptHash === undefined
                ? {}
                : { transcriptHash: input.transcriptHash }),
        },
        job: { completedAtMs: input.completedAtMs ?? Date.now() + DAY_MS },
    };
}

function createV2Database(path: string): void {
    const database = new DatabaseSync(path);
    const oldPayload = buildArtifact({
        recordId: 'legacy-v2-row',
        algorithmVersion: 'server-v4',
        sourceType: 'youtube_yt_dlp',
        completedAtMs: 1_900_000_000_000,
    });
    database.exec(`
        CREATE TABLE schema_metadata (schema_version INTEGER NOT NULL);
        INSERT INTO schema_metadata (schema_version) VALUES (2);
        CREATE TABLE analysis_artifacts (
            record_id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL,
            algorithm_version TEXT NOT NULL,
            completed_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX analysis_artifacts_lookup_idx
            ON analysis_artifacts (video_id, algorithm_version, completed_at_ms);
    `);
    database
        .prepare(
            `INSERT INTO analysis_artifacts
                (record_id, video_id, algorithm_version, completed_at_ms,
                 expires_at_ms, payload_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
            'legacy-v2-row',
            ARTIFACT_VIDEO_ID,
            'server-v4',
            1_900_000_000_000,
            2_100_000_000_000,
            JSON.stringify(oldPayload),
        );
    database.close();
}

function readStringField(value: unknown, key: string): string | null {
    if (value === null || typeof value !== 'object') {
        return null;
    }
    const field: unknown = Reflect.get(value, key);
    return typeof field === 'string' ? field : null;
}

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

    it('migrates v2 additively while a frozen v2 reader survives rollback', () => {
        const path = join(directory, 'v2.sqlite');
        BackendPublicState.closeForTests();
        createV2Database(path);
        expect(
            FrozenPublicStateV2Reader.readArtifacts(
                path,
                ARTIFACT_VIDEO_ID,
                'server-v4',
            ),
        ).toHaveLength(1);

        BackendPublicState.configureForTests(path);
        BackendPublicState.upsertArtifact(
            buildArtifact({
                recordId: 'v3-upload-row',
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
            }),
        );
        BackendPublicState.closeForTests();

        const migrated = new DatabaseSync(path);
        const columns = migrated
            .prepare('PRAGMA table_info(analysis_artifacts)')
            .all()
            .map((row) => Reflect.get(row, 'name'));
        expect(columns).toEqual(
            expect.arrayContaining([
                'language_code',
                'transcript_hash',
                'source_type',
            ]),
        );
        const exactIndex = migrated
            .prepare(
                `SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND name = 'analysis_artifacts_exact_lookup_idx'`,
            )
            .get();
        expect(readStringField(exactIndex, 'sql')).toContain(
            'WHERE language_code IS NOT NULL AND transcript_hash IS NOT NULL',
        );
        expect(
            migrated
                .prepare('SELECT schema_version FROM schema_metadata')
                .get(),
        ).toEqual({ schema_version: 3 });
        migrated.close();

        expect(
            FrozenPublicStateV2Reader.readArtifacts(
                path,
                ARTIFACT_VIDEO_ID,
                'server-v4',
            ).map((row) => row.recordId),
        ).toEqual(['legacy-v2-row']);
        expect(
            FrozenPublicStateV2Reader.readArtifacts(
                path,
                ARTIFACT_VIDEO_ID,
                UPLOAD_ALGORITHM_VERSION,
            ),
        ).toEqual([]);
        FrozenPublicStateV2Reader.writeArtifact(path, {
            recordId: 'rollback-v2-row',
            videoId: ARTIFACT_VIDEO_ID,
            algorithmVersion: 'server-v4',
            completedAtMs: 1_900_000_000_001,
            expiresAtMs: 2_100_000_000_001,
            payload: buildArtifact({
                recordId: 'rollback-v2-row',
                algorithmVersion: 'server-v4',
                sourceType: 'local_fixture',
                completedAtMs: 1_900_000_000_001,
            }),
        });
        expect(
            FrozenPublicStateV2Reader.readArtifacts(
                path,
                ARTIFACT_VIDEO_ID,
                'server-v4',
            ).map((row) => row.recordId),
        ).toEqual(['legacy-v2-row', 'rollback-v2-row']);

        BackendPublicState.configureForTests(path);
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
        const reservations = Array.from({ length: 10 }, () =>
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
            costUsd: 0,
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
        expect(snapshot).toContain('"spent_usd":1');
    });

    it('persists artifacts and safe support failures across reopen', () => {
        const path = join(directory, 'topskip.sqlite');
        BackendPublicState.upsertArtifact(
            buildArtifact({
                recordId: 'artifact-1',
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                completedAtMs: 1_900_000_000_000,
            }),
        );
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
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: '0.1.0',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_902_592_000_000,
        });

        BackendPublicState.closeForTests();
        BackendPublicState.configureForTests(path);

        expect(
            BackendPublicState.findArtifactsExact({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
            }),
        ).toHaveLength(1);
        expect(BackendPublicState.findFailureForTests('support-1')).toEqual({
            supportId: 'support-1',
            code: 'internal_error',
            videoId: 'dQw4w9WgXcQ',
            jobId: 'job-1',
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: '0.1.0',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_902_592_000_000,
        });
    });

    it('queries uploaded artifacts by every exact identity component', () => {
        const artifacts = [
            buildArtifact({
                recordId: 'exact-en-a',
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
            }),
            buildArtifact({
                recordId: 'exact-fr-a',
                languageCode: 'fr',
                transcriptHash: TRANSCRIPT_HASH,
            }),
            buildArtifact({
                recordId: 'exact-en-b',
                languageCode: 'en',
                transcriptHash: OTHER_TRANSCRIPT_HASH,
            }),
            buildArtifact({
                recordId: 'legacy-null-v5',
                sourceType: 'youtube_yt_dlp',
            }),
            buildArtifact({
                recordId: 'legacy-v4',
                algorithmVersion: 'server-v4',
                sourceType: 'local_fixture',
            }),
        ];
        for (const artifact of artifacts) {
            BackendPublicState.upsertArtifact(artifact);
        }

        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
            }),
        ).toEqual([artifacts[0]]);
        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'de',
                transcriptHash: TRANSCRIPT_HASH,
            }),
        ).toEqual([]);
        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: 'c'.repeat(64),
            }),
        ).toEqual([]);
    });

    it('adds safe failure versions without breaking legacy failure rows or readers', () => {
        const path = join(directory, 'legacy-topskip.sqlite');
        BackendPublicState.closeForTests();
        const legacyDatabase = new DatabaseSync(path);
        legacyDatabase.exec(`
            CREATE TABLE analysis_failures (
                support_id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                video_id TEXT,
                job_id TEXT,
                created_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL
            );
            INSERT INTO analysis_failures
                (support_id, code, video_id, job_id, created_at_ms, expires_at_ms)
            VALUES
                ('legacy-support', 'internal_error', NULL, NULL, 1900000000000, 1902592000000);
        `);
        legacyDatabase.close();

        BackendPublicState.configureForTests(path);

        expect(
            BackendPublicState.findFailureForTests('legacy-support'),
        ).toEqual({
            supportId: 'legacy-support',
            code: 'internal_error',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_902_592_000_000,
        });
        BackendPublicState.recordFailure({
            supportId: 'versioned-support',
            code: 'model_provider_error',
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: '0.2.0',
            createdAtMs: 1_900_000_000_001,
            expiresAtMs: 1_902_592_000_001,
        });
        expect(
            BackendPublicState.findFailureForTests('versioned-support'),
        ).toMatchObject({
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: '0.2.0',
        });

        BackendPublicState.closeForTests();
        const rollbackDatabase = new DatabaseSync(path);
        expect(
            rollbackDatabase
                .prepare(
                    `SELECT support_id, code, created_at_ms, expires_at_ms
                     FROM analysis_failures
                     WHERE support_id = ?`,
                )
                .get('versioned-support'),
        ).toMatchObject({
            support_id: 'versioned-support',
            code: 'model_provider_error',
        });
        rollbackDatabase.close();
        BackendPublicState.configureForTests(path);
    });

    it('expires artifacts and safe support failures after thirty days', () => {
        const completedAtMs = Date.now() + DAY_MS;
        const expiresAtMs = completedAtMs + ARTIFACT_RETENTION_MS;
        BackendPublicState.upsertArtifact(
            buildArtifact({
                recordId: 'expiring-artifact',
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                completedAtMs,
            }),
        );
        BackendPublicState.recordFailure({
            supportId: 'expiring-support',
            code: 'internal_error',
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            createdAtMs: completedAtMs,
            expiresAtMs,
        });

        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                nowMs: completedAtMs,
            }),
        ).toHaveLength(1);
        expect(
            BackendPublicState.findFailureForTests('expiring-support'),
        ).not.toBeNull();

        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: UPLOAD_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
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
        BackendPublicState.upsertArtifact(
            buildArtifact({
                recordId: 'count-limit-newest',
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                completedAtMs: firstCompletedAtMs + MAX_ARTIFACT_COUNT,
            }),
        );

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
        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                nowMs: firstCompletedAtMs,
            }),
        ).toEqual([
            buildArtifact({
                recordId: 'count-limit-newest',
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                completedAtMs: firstCompletedAtMs + MAX_ARTIFACT_COUNT,
            }),
        ]);
    });

    it('retains only one hundred newest artifacts under low disk pressure', () => {
        const path = join(directory, 'topskip.sqlite');
        const firstCompletedAtMs = Date.now() + DAY_MS;
        seedArtifacts(path, {
            count: LOW_DISK_ARTIFACT_COUNT,
            firstCompletedAtMs,
        });
        BackendPublicState.setStorageHeadroomForTests(false);
        BackendPublicState.upsertArtifact(
            buildArtifact({
                recordId: 'low-disk-newest',
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                completedAtMs: firstCompletedAtMs + LOW_DISK_ARTIFACT_COUNT,
            }),
        );

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
        expect(
            BackendPublicState.findArtifactsExact({
                videoId: ARTIFACT_VIDEO_ID,
                algorithmVersion: ARTIFACT_ALGORITHM_VERSION,
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                nowMs: firstCompletedAtMs,
            }),
        ).toHaveLength(1);
    });
});
