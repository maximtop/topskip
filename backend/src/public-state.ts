import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MS_PER_SECOND, SECONDS_PER_HOUR } from '@topskip/common/constants';

const DATABASE_PATH_ENVIRONMENT_VARIABLE = 'TOPSKIP_DATABASE_PATH';
const DEFAULT_DATABASE_DIRECTORY = '.topskip-data';
const DEFAULT_DATABASE_FILE_NAME = 'topskip.sqlite';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const INSTALLATION_TOKEN_BYTES = 32;
const INSTALLATION_TTL_MS = 90 * 24 * SECONDS_PER_HOUR * MS_PER_SECOND;
const DAY_MS = 24 * SECONDS_PER_HOUR * MS_PER_SECOND;
const MINUTE_MS = 60 * MS_PER_SECOND;
const HOUR_MS = SECONDS_PER_HOUR * MS_PER_SECOND;
const REGISTRATION_LIMIT_PER_DAY = 10;
const AUTHENTICATED_REQUEST_LIMIT_PER_MINUTE = 120;
const COLD_INSTALLATION_LIMIT_PER_HOUR = 5;
const COLD_INSTALLATION_LIMIT_PER_DAY = 20;
const COLD_IP_LIMIT_PER_HOUR = 20;
const COLD_IP_LIMIT_PER_DAY = 60;
const MODEL_RESERVATION_USD = 0.35;
const MODEL_DAILY_BUDGET_USD = 5;
const MODEL_MONTHLY_BUDGET_USD = 100;
const ARTIFACT_RETENTION_MS = 30 * DAY_MS;
const MAX_ARTIFACT_RECORD_COUNT = 10_000;
const LOW_DISK_ARTIFACT_RECORD_COUNT = 100;
const MIN_FREE_STORAGE_BYTES = 512 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const SQLITE_MEMORY_PATH = ':memory:';
const HOUSEKEEPING_INTERVAL_MS = 5 * MINUTE_MS;
const STALE_MODEL_RESERVATION_MS = HOUR_MS;
const INCREMENTAL_VACUUM_PAGE_COUNT = 256;

/**
 * Successful anonymous credential issuance returns the raw token only to its caller.
 */
type InstallationRegistrationSuccess = {
    ok: true;
    token: string;
    installationHash: string;
    expiresAtMs: number;
};

/**
 * Registration denials expose only bounded retry metadata.
 */
type InstallationRegistrationFailure = {
    ok: false;
    retryAfterSec: number;
};

/**
 * Installation registration result keeps raw credentials out of persistence.
 */
export type InstallationRegistrationResult =
    | InstallationRegistrationSuccess
    | InstallationRegistrationFailure;

/**
 * Successful auth resolves the stored credential hash used for ownership and quotas.
 */
export type InstallationAuthenticationResult =
    | { ok: true; installationHash: string }
    | { ok: false; code: 'token_invalid' | 'token_expired' };

/**
 * Quota decisions are retryable without exposing counter internals.
 */
export type PublicQuotaDecision =
    | { allowed: true }
    | { allowed: false; retryAfterSec: number };

/**
 * Reservations prevent parallel model calls from overspending a shared period.
 */
export type ModelBudgetReservation = {
    reservationId: string;
    reservedUsd: number;
};

/**
 * Safe retained failures correlate user reports without retaining provider details.
 */
export type RetainedPublicFailure = {
    supportId: string;
    code: string;
    videoId?: string;
    jobId?: string;
    createdAtMs: number;
    expiresAtMs: number;
};

/**
 * Owns additive SQLite persistence for public-server credentials, quotas, budgets, and history.
 */
export class BackendPublicState {
    /**
     * One synchronous connection keeps quota and budget transactions process-atomic.
     */
    private static database: DatabaseSync | null = null;

    /**
     * Tests override the production path without touching workspace state.
     */
    private static databasePathForTests: string | null = null;

    /**
     * Housekeeping is throttled so request paths do not repeatedly scan bounded tables.
     */
    private static lastHousekeepingAtMs = 0;

    /**
     * Tests can deterministically exercise the low-disk pruning branch.
     */
    private static storageHeadroomForTests: boolean | null = null;

    /**
     * Opens and probes production persistence before the HTTP listener becomes healthy.
     */
    static assertReady(): void {
        const database = BackendPublicState.getDatabase();
        database.exec('BEGIN IMMEDIATE');
        try {
            database.exec(
                'UPDATE schema_metadata SET schema_version = schema_version',
            );
            database.exec('ROLLBACK');
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Issues a random installation credential after enforcing the IP registration quota.
     *
     * @param input - HMAC IP identity and deterministic registration timestamp.
     * @returns Raw one-time credential or retry metadata.
     */
    static registerInstallation(input: {
        ipHash: string;
        nowMs: number;
    }): InstallationRegistrationResult {
        BackendPublicState.runHousekeeping(input.nowMs);
        const database = BackendPublicState.getDatabase();
        const windowStartedAtMs = input.nowMs - DAY_MS;
        database.exec('BEGIN IMMEDIATE');
        try {
            const count = BackendPublicState.countEvents(database, {
                kind: 'registration',
                subjectHash: input.ipHash,
                sinceMs: windowStartedAtMs,
            });
            if (count >= REGISTRATION_LIMIT_PER_DAY) {
                const retryAfterSec = BackendPublicState.retryAfterOldestEvent(
                    database,
                    {
                        kind: 'registration',
                        subjectHash: input.ipHash,
                        sinceMs: windowStartedAtMs,
                        windowMs: DAY_MS,
                        nowMs: input.nowMs,
                    },
                );
                database.exec('ROLLBACK');
                return { ok: false, retryAfterSec };
            }

            const token = randomBytes(INSTALLATION_TOKEN_BYTES).toString(
                'base64url',
            );
            const installationHash = BackendPublicState.hashToken(token);
            const expiresAtMs = input.nowMs + INSTALLATION_TTL_MS;
            database
                .prepare(
                    `INSERT INTO installations
                        (installation_hash, created_at_ms, expires_at_ms)
                     VALUES (?, ?, ?)`,
                )
                .run(installationHash, input.nowMs, expiresAtMs);
            BackendPublicState.insertEvent(database, {
                kind: 'registration',
                subjectHash: input.ipHash,
                nowMs: input.nowMs,
            });
            database.exec('COMMIT');
            return { ok: true, token, installationHash, expiresAtMs };
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Resolves a bearer credential to its hash without ever storing the raw token.
     *
     * @param input - Raw credential and deterministic auth timestamp.
     * @returns Authenticated installation identity or a stable failure code.
     */
    static authenticateInstallation(input: {
        token: string;
        nowMs: number;
    }): InstallationAuthenticationResult {
        BackendPublicState.runHousekeeping(input.nowMs);
        const installationHash = BackendPublicState.hashToken(input.token);
        const row = BackendPublicState.getDatabase()
            .prepare(
                `SELECT expires_at_ms
                 FROM installations
                 WHERE installation_hash = ?`,
            )
            .get(installationHash);
        if (row === undefined) {
            return { ok: false, code: 'token_invalid' };
        }
        const expiresAtMs = BackendPublicState.readNumber(row, 'expires_at_ms');
        if (expiresAtMs === null || input.nowMs >= expiresAtMs) {
            return { ok: false, code: 'token_expired' };
        }
        return { ok: true, installationHash };
    }

    /**
     * Applies the minute-level request ceiling to all authenticated analysis traffic.
     *
     * @param input - Installation identity and request timestamp.
     * @returns Allow or bounded retry decision.
     */
    static consumeAuthenticatedRequest(input: {
        installationHash: string;
        nowMs: number;
    }): PublicQuotaDecision {
        BackendPublicState.runHousekeeping(input.nowMs);
        return BackendPublicState.consumeSingleQuota({
            kind: 'authenticated-request',
            subjectHash: input.installationHash,
            nowMs: input.nowMs,
            windowMs: MINUTE_MS,
            limit: AUTHENTICATED_REQUEST_LIMIT_PER_MINUTE,
        });
    }

    /**
     * Atomically spends both installation and IP cold-work quota only after cache/join misses.
     *
     * @param input - Hashed installation/IP identities and cold-start timestamp.
     * @returns Allow or the longest relevant retry delay.
     */
    static consumeColdJobQuota(input: {
        installationHash: string;
        ipHash: string;
        nowMs: number;
    }): PublicQuotaDecision {
        BackendPublicState.runHousekeeping(input.nowMs);
        const database = BackendPublicState.getDatabase();
        const checks = [
            {
                kind: 'cold-installation',
                subjectHash: input.installationHash,
                windowMs: HOUR_MS,
                limit: COLD_INSTALLATION_LIMIT_PER_HOUR,
            },
            {
                kind: 'cold-installation',
                subjectHash: input.installationHash,
                windowMs: DAY_MS,
                limit: COLD_INSTALLATION_LIMIT_PER_DAY,
            },
            {
                kind: 'cold-ip',
                subjectHash: input.ipHash,
                windowMs: HOUR_MS,
                limit: COLD_IP_LIMIT_PER_HOUR,
            },
            {
                kind: 'cold-ip',
                subjectHash: input.ipHash,
                windowMs: DAY_MS,
                limit: COLD_IP_LIMIT_PER_DAY,
            },
        ] as const;

        database.exec('BEGIN IMMEDIATE');
        try {
            const retryDelays = checks
                .filter(
                    (check) =>
                        BackendPublicState.countEvents(database, {
                            kind: check.kind,
                            subjectHash: check.subjectHash,
                            sinceMs: input.nowMs - check.windowMs,
                        }) >= check.limit,
                )
                .map((check) =>
                    BackendPublicState.retryAfterOldestEvent(database, {
                        kind: check.kind,
                        subjectHash: check.subjectHash,
                        sinceMs: input.nowMs - check.windowMs,
                        windowMs: check.windowMs,
                        nowMs: input.nowMs,
                    }),
                );
            if (retryDelays.length > 0) {
                database.exec('ROLLBACK');
                return {
                    allowed: false,
                    retryAfterSec: Math.max(...retryDelays),
                };
            }

            BackendPublicState.insertEvent(database, {
                kind: 'cold-installation',
                subjectHash: input.installationHash,
                nowMs: input.nowMs,
            });
            BackendPublicState.insertEvent(database, {
                kind: 'cold-ip',
                subjectHash: input.ipHash,
                nowMs: input.nowMs,
            });
            database.exec('COMMIT');
            return { allowed: true };
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Reserves provider spend in both current UTC periods before a model call begins.
     *
     * @param input - Deterministic reservation timestamp.
     * @returns Reservation identity, or `null` when either budget is exhausted.
     */
    static reserveModelBudget(input: {
        nowMs: number;
    }): ModelBudgetReservation | null {
        BackendPublicState.runHousekeeping(input.nowMs);
        const database = BackendPublicState.getDatabase();
        const periods = BackendPublicState.periodKeys(input.nowMs);
        database.exec('BEGIN IMMEDIATE');
        try {
            const daily = BackendPublicState.readBudgetPeriod(
                database,
                periods.day,
            );
            const monthly = BackendPublicState.readBudgetPeriod(
                database,
                periods.month,
            );
            if (
                daily.spentUsd + daily.reservedUsd + MODEL_RESERVATION_USD >
                    MODEL_DAILY_BUDGET_USD ||
                monthly.spentUsd + monthly.reservedUsd + MODEL_RESERVATION_USD >
                    MODEL_MONTHLY_BUDGET_USD
            ) {
                database.exec('ROLLBACK');
                return null;
            }

            BackendPublicState.addBudgetReservation(
                database,
                periods.day,
                MODEL_RESERVATION_USD,
            );
            BackendPublicState.addBudgetReservation(
                database,
                periods.month,
                MODEL_RESERVATION_USD,
            );
            const reservationId = randomUUID();
            database
                .prepare(
                    `INSERT INTO model_budget_reservations
                        (reservation_id, day_key, month_key, reserved_usd, created_at_ms)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(
                    reservationId,
                    periods.day,
                    periods.month,
                    MODEL_RESERVATION_USD,
                    input.nowMs,
                );
            database.exec('COMMIT');
            return {
                reservationId,
                reservedUsd: MODEL_RESERVATION_USD,
            };
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Converts one reservation into reported spend or the conservative full reserve.
     *
     * @param input - Reservation identity and optional validated provider cost.
     */
    static settleModelBudget(input: {
        reservationId: string;
        costUsd?: number;
    }): void {
        const database = BackendPublicState.getDatabase();
        database.exec('BEGIN IMMEDIATE');
        try {
            const row = database
                .prepare(
                    `SELECT day_key, month_key, reserved_usd
                     FROM model_budget_reservations
                     WHERE reservation_id = ?`,
                )
                .get(input.reservationId);
            if (row === undefined) {
                database.exec('ROLLBACK');
                return;
            }
            const dayKey = BackendPublicState.readString(row, 'day_key');
            const monthKey = BackendPublicState.readString(row, 'month_key');
            const reservedUsd = BackendPublicState.readNumber(
                row,
                'reserved_usd',
            );
            if (dayKey === null || monthKey === null || reservedUsd === null) {
                throw new Error('Invalid model budget reservation.');
            }
            const costUsd =
                input.costUsd !== undefined &&
                Number.isFinite(input.costUsd) &&
                input.costUsd >= 0
                    ? input.costUsd
                    : reservedUsd;
            BackendPublicState.settleBudgetPeriod(
                database,
                dayKey,
                reservedUsd,
                costUsd,
            );
            BackendPublicState.settleBudgetPeriod(
                database,
                monthKey,
                reservedUsd,
                costUsd,
            );
            database
                .prepare(
                    'DELETE FROM model_budget_reservations WHERE reservation_id = ?',
                )
                .run(input.reservationId);
            database.exec('COMMIT');
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Upserts one validated artifact without materializing unrelated transcripts.
     *
     * @param record - Validated backend artifact record from the repository boundary.
     */
    static upsertArtifact(record: unknown): void {
        const identity = BackendPublicState.readArtifactIdentity(record);
        const nowMs = Date.now();
        BackendPublicState.runHousekeeping(nowMs);
        const database = BackendPublicState.getDatabase();
        database.exec('BEGIN IMMEDIATE');
        try {
            database
                .prepare(
                    `INSERT INTO analysis_artifacts
                        (record_id, video_id, algorithm_version, completed_at_ms, expires_at_ms, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(record_id) DO UPDATE SET
                        video_id = excluded.video_id,
                        algorithm_version = excluded.algorithm_version,
                        completed_at_ms = excluded.completed_at_ms,
                        expires_at_ms = excluded.expires_at_ms,
                        payload_json = excluded.payload_json`,
                )
                .run(
                    identity.recordId,
                    identity.videoId,
                    identity.algorithmVersion,
                    identity.completedAtMs,
                    identity.completedAtMs + ARTIFACT_RETENTION_MS,
                    JSON.stringify(record),
                );
            BackendPublicState.pruneArtifactRows(database, nowMs);
            database.exec('COMMIT');
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
        BackendPublicState.maintainSqliteFileSafely(database);
    }

    /**
     * Queries only one video's retained rows, optionally constrained to one algorithm.
     *
     * @param input - Indexed artifact identity and deterministic read timestamp.
     * @returns Parsed unknown payloads for validation by the artifact repository.
     */
    static findArtifacts(input: {
        videoId: string;
        algorithmVersion?: string;
        nowMs?: number;
    }): unknown[] {
        const nowMs = input.nowMs ?? Date.now();
        BackendPublicState.runHousekeeping(nowMs);
        const database = BackendPublicState.getDatabase();
        const rows =
            input.algorithmVersion === undefined
                ? database
                      .prepare(
                          `SELECT payload_json
                           FROM analysis_artifacts
                           WHERE video_id = ? AND expires_at_ms > ?
                           ORDER BY completed_at_ms ASC`,
                      )
                      .all(input.videoId, nowMs)
                : database
                      .prepare(
                          `SELECT payload_json
                           FROM analysis_artifacts
                           WHERE video_id = ?
                             AND algorithm_version = ?
                             AND expires_at_ms > ?
                           ORDER BY completed_at_ms ASC`,
                      )
                      .all(input.videoId, input.algorithmVersion, nowMs);
        return rows.flatMap((row) => {
            const payload = BackendPublicState.readString(row, 'payload_json');
            if (payload === null) {
                return [];
            }
            try {
                return [JSON.parse(payload) as unknown];
            } catch {
                return [];
            }
        });
    }

    /**
     * Retains one stable failure record for support correlation.
     *
     * @param input - Allow-listed failure metadata without raw diagnostics.
     */
    static recordFailure(input: RetainedPublicFailure): void {
        BackendPublicState.runHousekeeping(input.createdAtMs);
        BackendPublicState.getDatabase()
            .prepare(
                `INSERT OR REPLACE INTO analysis_failures
                    (support_id, code, video_id, job_id, created_at_ms, expires_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.supportId,
                input.code,
                input.videoId ?? null,
                input.jobId ?? null,
                input.createdAtMs,
                input.expiresAtMs,
            );
    }

    /**
     * Creates an opaque support identity that reveals no job or video metadata.
     *
     * @returns Random support identifier safe to return to the extension.
     */
    static createSupportId(): string {
        return `support-${randomUUID()}`;
    }

    /**
     * Selects one isolated SQLite database and initializes its additive schema.
     *
     * @param path - Test-owned SQLite file path or `:memory:`.
     */
    static configureForTests(path: string = SQLITE_MEMORY_PATH): void {
        BackendPublicState.closeDatabase();
        BackendPublicState.databasePathForTests = path;
        BackendPublicState.lastHousekeepingAtMs = 0;
        BackendPublicState.getDatabase();
    }

    /**
     * Closes the current handle while preserving the test-owned database file.
     */
    static closeForTests(): void {
        BackendPublicState.closeDatabase();
    }

    /**
     * Overrides filesystem headroom only for isolated retention tests.
     *
     * @param hasHeadroom - Forced branch, or `null` to restore statfs checks.
     */
    static setStorageHeadroomForTests(hasHeadroom: boolean | null): void {
        BackendPublicState.storageHeadroomForTests = hasHeadroom;
    }

    /**
     * Clears the isolated test database without touching production state.
     */
    static resetForTests(): void {
        const path = BackendPublicState.databasePathForTests;
        BackendPublicState.closeDatabase();
        if (path !== null && path !== SQLITE_MEMORY_PATH) {
            rmSync(path, { force: true });
            rmSync(`${path}-shm`, { force: true });
            rmSync(`${path}-wal`, { force: true });
        }
        BackendPublicState.databasePathForTests = null;
        BackendPublicState.lastHousekeepingAtMs = 0;
        BackendPublicState.storageHeadroomForTests = null;
    }

    /**
     * Exposes only serialized persisted rows to prove raw tokens never enter SQLite.
     *
     * @returns Test-safe database snapshot.
     */
    static snapshotForTests(): { serialized: string } {
        const database = BackendPublicState.getDatabase();
        return {
            serialized: JSON.stringify({
                installations: database
                    .prepare('SELECT * FROM installations')
                    .all(),
                quotaEvents: database
                    .prepare('SELECT * FROM quota_events')
                    .all(),
                budgetPeriods: database
                    .prepare('SELECT * FROM model_budget_periods')
                    .all(),
                budgetReservations: database
                    .prepare('SELECT * FROM model_budget_reservations')
                    .all(),
                failures: database
                    .prepare('SELECT * FROM analysis_failures')
                    .all(),
            }),
        };
    }

    /**
     * Reads one retained support record for persistence tests.
     *
     * @param supportId - Opaque returned support identity.
     * @returns Safe retained metadata, or `null` when absent.
     */
    static findFailureForTests(
        supportId: string,
    ): RetainedPublicFailure | null {
        const row = BackendPublicState.getDatabase()
            .prepare(
                `SELECT support_id, code, video_id, job_id, created_at_ms, expires_at_ms
                 FROM analysis_failures
                 WHERE support_id = ?`,
            )
            .get(supportId);
        if (row === undefined) {
            return null;
        }
        const read = {
            supportId: BackendPublicState.readString(row, 'support_id'),
            code: BackendPublicState.readString(row, 'code'),
            videoId: BackendPublicState.readString(row, 'video_id'),
            jobId: BackendPublicState.readString(row, 'job_id'),
            createdAtMs: BackendPublicState.readNumber(row, 'created_at_ms'),
            expiresAtMs: BackendPublicState.readNumber(row, 'expires_at_ms'),
        };
        if (
            read.supportId === null ||
            read.code === null ||
            read.createdAtMs === null ||
            read.expiresAtMs === null
        ) {
            return null;
        }
        return {
            supportId: read.supportId,
            code: read.code,
            ...(read.videoId === null ? {} : { videoId: read.videoId }),
            ...(read.jobId === null ? {} : { jobId: read.jobId }),
            createdAtMs: read.createdAtMs,
            expiresAtMs: read.expiresAtMs,
        };
    }

    /**
     * Opens the configured database lazily and applies additive migrations.
     *
     * @returns Shared synchronous SQLite connection.
     */
    private static getDatabase(): DatabaseSync {
        if (BackendPublicState.database !== null) {
            return BackendPublicState.database;
        }
        const path = BackendPublicState.resolveDatabasePath();
        const databaseFileExists =
            path !== SQLITE_MEMORY_PATH && existsSync(path);
        if (path !== SQLITE_MEMORY_PATH) {
            mkdirSync(dirname(path), {
                recursive: true,
                mode: PRIVATE_DIRECTORY_MODE,
            });
            chmodSync(dirname(path), PRIVATE_DIRECTORY_MODE);
        }
        const database = new DatabaseSync(path);
        database.exec(
            'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL;',
        );
        if (path !== SQLITE_MEMORY_PATH) {
            if (
                databaseFileExists &&
                BackendPublicState.readPragmaNumber(database, 'auto_vacuum') !==
                    2
            ) {
                database.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
            }
            database.exec('PRAGMA journal_mode = WAL;');
            chmodSync(path, PRIVATE_FILE_MODE);
        }
        BackendPublicState.migrate(database);
        BackendPublicState.database = database;
        return database;
    }

    /**
     * Resolves test overrides before the production environment/default path.
     *
     * @returns SQLite database path for this process.
     */
    private static resolveDatabasePath(): string {
        if (
            BackendPublicState.databasePathForTests === null &&
            (process.env.VITEST === 'true' || process.env.VITEST === '1')
        ) {
            return SQLITE_MEMORY_PATH;
        }
        return (
            BackendPublicState.databasePathForTests ??
            process.env[DATABASE_PATH_ENVIRONMENT_VARIABLE] ??
            join(
                process.cwd(),
                DEFAULT_DATABASE_DIRECTORY,
                DEFAULT_DATABASE_FILE_NAME,
            )
        );
    }

    /**
     * Applies only additive table/index creation so older images can roll back safely.
     *
     * @param database - Open SQLite connection.
     */
    private static migrate(database: DatabaseSync): void {
        database.exec(`
            CREATE TABLE IF NOT EXISTS schema_metadata (
                schema_version INTEGER NOT NULL
            );
            INSERT INTO schema_metadata (schema_version)
            SELECT ${SCHEMA_VERSION}
            WHERE NOT EXISTS (SELECT 1 FROM schema_metadata);

            CREATE TABLE IF NOT EXISTS installations (
                installation_hash TEXT PRIMARY KEY,
                created_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS installations_expiry_idx
                ON installations (expires_at_ms);

            CREATE TABLE IF NOT EXISTS quota_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_kind TEXT NOT NULL,
                subject_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS quota_events_lookup_idx
                ON quota_events (event_kind, subject_hash, created_at_ms);

            CREATE TABLE IF NOT EXISTS model_budget_periods (
                period_key TEXT PRIMARY KEY,
                spent_usd REAL NOT NULL DEFAULT 0,
                reserved_usd REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS model_budget_reservations (
                reservation_id TEXT PRIMARY KEY,
                day_key TEXT NOT NULL,
                month_key TEXT NOT NULL,
                reserved_usd REAL NOT NULL,
                created_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS analysis_artifacts (
                record_id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                algorithm_version TEXT NOT NULL,
                completed_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS analysis_artifacts_lookup_idx
                ON analysis_artifacts (video_id, algorithm_version, completed_at_ms);
            CREATE INDEX IF NOT EXISTS analysis_artifacts_expiry_idx
                ON analysis_artifacts (expires_at_ms);

            CREATE TABLE IF NOT EXISTS analysis_failures (
                support_id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                video_id TEXT,
                job_id TEXT,
                created_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS analysis_failures_expiry_idx
                ON analysis_failures (expires_at_ms);
        `);
    }

    /**
     * Applies one sliding-window quota in a short write transaction.
     *
     * @param input - Quota identity, window, limit, and timestamp.
     * @returns Allow or retry decision.
     */
    private static consumeSingleQuota(input: {
        kind: string;
        subjectHash: string;
        nowMs: number;
        windowMs: number;
        limit: number;
    }): PublicQuotaDecision {
        const database = BackendPublicState.getDatabase();
        database.exec('BEGIN IMMEDIATE');
        try {
            const sinceMs = input.nowMs - input.windowMs;
            const count = BackendPublicState.countEvents(database, {
                kind: input.kind,
                subjectHash: input.subjectHash,
                sinceMs,
            });
            if (count >= input.limit) {
                const retryAfterSec = BackendPublicState.retryAfterOldestEvent(
                    database,
                    { ...input, sinceMs },
                );
                database.exec('ROLLBACK');
                return { allowed: false, retryAfterSec };
            }
            BackendPublicState.insertEvent(database, input);
            database.exec('COMMIT');
            return { allowed: true };
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }

    /**
     * Counts one quota subject within a sliding window.
     *
     * @param database - Active transaction connection.
     * @param input - Event identity and inclusive lower timestamp.
     * @returns Number of matching events.
     */
    private static countEvents(
        database: DatabaseSync,
        input: { kind: string; subjectHash: string; sinceMs: number },
    ): number {
        const row = database
            .prepare(
                `SELECT COUNT(*) AS event_count
                 FROM quota_events
                 WHERE event_kind = ? AND subject_hash = ? AND created_at_ms > ?`,
            )
            .get(input.kind, input.subjectHash, input.sinceMs);
        return BackendPublicState.readNumber(row, 'event_count') ?? 0;
    }

    /**
     * Records a quota event without retaining a raw token or IP address.
     *
     * @param database - Active transaction connection.
     * @param input - Stable event kind, hashed identity, and timestamp.
     */
    private static insertEvent(
        database: DatabaseSync,
        input: { kind: string; subjectHash: string; nowMs: number },
    ): void {
        database
            .prepare(
                `INSERT INTO quota_events (event_kind, subject_hash, created_at_ms)
                 VALUES (?, ?, ?)`,
            )
            .run(input.kind, input.subjectHash, input.nowMs);
    }

    /**
     * Computes a positive retry delay from the oldest event still in a window.
     *
     * @param database - Active transaction connection.
     * @param input - Event/window identity and current timestamp.
     * @returns Positive whole-second retry delay.
     */
    private static retryAfterOldestEvent(
        database: DatabaseSync,
        input: {
            kind: string;
            subjectHash: string;
            sinceMs: number;
            windowMs: number;
            nowMs: number;
        },
    ): number {
        const row = database
            .prepare(
                `SELECT MIN(created_at_ms) AS oldest_at_ms
                 FROM quota_events
                 WHERE event_kind = ? AND subject_hash = ? AND created_at_ms > ?`,
            )
            .get(input.kind, input.subjectHash, input.sinceMs);
        const oldestAtMs =
            BackendPublicState.readNumber(row, 'oldest_at_ms') ?? input.nowMs;
        return Math.max(
            1,
            Math.ceil(
                (oldestAtMs + input.windowMs - input.nowMs) / MS_PER_SECOND,
            ),
        );
    }

    /**
     * Reads current spend/reserve values and creates a missing period lazily.
     *
     * @param database - Active transaction connection.
     * @param periodKey - UTC day or month key.
     * @returns Current period accounting.
     */
    private static readBudgetPeriod(
        database: DatabaseSync,
        periodKey: string,
    ): { spentUsd: number; reservedUsd: number } {
        database
            .prepare(
                `INSERT OR IGNORE INTO model_budget_periods
                    (period_key, spent_usd, reserved_usd)
                 VALUES (?, 0, 0)`,
            )
            .run(periodKey);
        const row = database
            .prepare(
                `SELECT spent_usd, reserved_usd
                 FROM model_budget_periods
                 WHERE period_key = ?`,
            )
            .get(periodKey);
        return {
            spentUsd: BackendPublicState.readNumber(row, 'spent_usd') ?? 0,
            reservedUsd:
                BackendPublicState.readNumber(row, 'reserved_usd') ?? 0,
        };
    }

    /**
     * Adds reserved capacity to a budget period inside the caller transaction.
     *
     * @param database - Active transaction connection.
     * @param periodKey - UTC day or month key.
     * @param amountUsd - Conservative reservation amount.
     */
    private static addBudgetReservation(
        database: DatabaseSync,
        periodKey: string,
        amountUsd: number,
    ): void {
        database
            .prepare(
                `UPDATE model_budget_periods
                 SET reserved_usd = reserved_usd + ?
                 WHERE period_key = ?`,
            )
            .run(amountUsd, periodKey);
    }

    /**
     * Converts reserved capacity to settled spend in one budget period.
     *
     * @param database - Active transaction connection.
     * @param periodKey - UTC day or month key.
     * @param reservedUsd - Reservation being released.
     * @param costUsd - Reported or conservative settled cost.
     */
    private static settleBudgetPeriod(
        database: DatabaseSync,
        periodKey: string,
        reservedUsd: number,
        costUsd: number,
    ): void {
        database
            .prepare(
                `UPDATE model_budget_periods
                 SET reserved_usd = MAX(0, reserved_usd - ?),
                     spent_usd = spent_usd + ?
                 WHERE period_key = ?`,
            )
            .run(reservedUsd, costUsd, periodKey);
    }

    /**
     * Produces deterministic UTC keys independent of the server timezone.
     *
     * @param nowMs - Timestamp to bucket.
     * @returns Day and month keys.
     */
    private static periodKeys(nowMs: number): { day: string; month: string } {
        const iso = new Date(nowMs).toISOString();
        return {
            day: `day:${iso.slice(0, 10)}`,
            month: `month:${iso.slice(0, 7)}`,
        };
    }

    /**
     * Extracts bounded artifact identity before a JSON payload enters SQLite.
     *
     * @param record - Validated artifact record from its owning repository.
     * @returns Indexed artifact fields.
     */
    private static readArtifactIdentity(record: unknown): {
        recordId: string;
        videoId: string;
        algorithmVersion: string;
        completedAtMs: number;
    } {
        if (record === null || typeof record !== 'object') {
            throw new Error('Invalid artifact record.');
        }
        const recordId = BackendPublicState.readString(record, 'recordId');
        const video: unknown = Reflect.get(record, 'video');
        const job: unknown = Reflect.get(record, 'job');
        const videoId = BackendPublicState.readString(video, 'videoId');
        const algorithmVersion = BackendPublicState.readString(
            video,
            'algorithmVersion',
        );
        const completedAtMs = BackendPublicState.readNumber(
            job,
            'completedAtMs',
        );
        if (
            recordId === null ||
            videoId === null ||
            algorithmVersion === null ||
            completedAtMs === null
        ) {
            throw new Error('Invalid artifact record.');
        }
        return { recordId, videoId, algorithmVersion, completedAtMs };
    }

    /**
     * Enforces TTL, row-count, and low-disk retention entirely inside SQLite.
     *
     * @param database - Connection inside the caller's write transaction.
     * @param nowMs - Current retention timestamp.
     */
    private static pruneArtifactRows(
        database: DatabaseSync,
        nowMs: number,
    ): void {
        database
            .prepare('DELETE FROM analysis_artifacts WHERE expires_at_ms <= ?')
            .run(nowMs);
        const artifactLimit = BackendPublicState.hasStorageHeadroom()
            ? MAX_ARTIFACT_RECORD_COUNT
            : LOW_DISK_ARTIFACT_RECORD_COUNT;
        const row = database
            .prepare(
                'SELECT COUNT(*) AS artifact_count FROM analysis_artifacts',
            )
            .get();
        const artifactCount =
            BackendPublicState.readNumber(row, 'artifact_count') ?? 0;
        const excessCount = Math.max(0, artifactCount - artifactLimit);
        if (excessCount === 0) {
            return;
        }
        database
            .prepare(
                `DELETE FROM analysis_artifacts
                 WHERE record_id IN (
                    SELECT record_id
                    FROM analysis_artifacts
                    ORDER BY completed_at_ms ASC, record_id ASC
                    LIMIT ?
                 )`,
            )
            .run(excessCount);
    }

    /**
     * Checkpoints WAL pages and incrementally releases free pages after pruning.
     *
     * @param database - Open persistence connection.
     */
    private static maintainSqliteFileSafely(database: DatabaseSync): void {
        if (BackendPublicState.resolveDatabasePath() === SQLITE_MEMORY_PATH) {
            return;
        }
        try {
            database.exec(
                `PRAGMA wal_checkpoint(PASSIVE);
                 PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGE_COUNT});`,
            );
        } catch {
            // Retention rows are already committed; maintenance can retry later.
        }
    }

    /**
     * Reads one numeric PRAGMA without trusting driver-specific row typing.
     *
     * @param database - Open SQLite connection.
     * @param pragmaName - Hard-coded PRAGMA identifier selected by this module.
     * @returns Numeric PRAGMA value, or `null` when unavailable.
     */
    private static readPragmaNumber(
        database: DatabaseSync,
        pragmaName: 'auto_vacuum',
    ): number | null {
        const row = database.prepare(`PRAGMA ${pragmaName}`).get();
        return BackendPublicState.readNumber(row, pragmaName);
    }

    /**
     * Stops retained debugging history from consuming the operator's last disk space.
     *
     * @returns Whether the configured database filesystem has the safety reserve.
     */
    private static hasStorageHeadroom(): boolean {
        if (BackendPublicState.storageHeadroomForTests !== null) {
            return BackendPublicState.storageHeadroomForTests;
        }
        const path = BackendPublicState.resolveDatabasePath();
        if (path === SQLITE_MEMORY_PATH) {
            return true;
        }
        try {
            const stats = statfsSync(dirname(path));
            return stats.bavail * stats.bsize >= MIN_FREE_STORAGE_BYTES;
        } catch {
            return false;
        }
    }

    /**
     * Hashes bearer credentials into a fixed-length database identity.
     *
     * @param token - Raw installation credential held by the extension.
     * @returns Lowercase SHA-256 digest.
     */
    private static hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    /**
     * Reads a finite number from an untrusted SQLite row.
     *
     * @param row - Unknown query result.
     * @param key - Allow-listed numeric column.
     * @returns Finite number or `null`.
     */
    private static readNumber(row: unknown, key: string): number | null {
        if (row === null || typeof row !== 'object') {
            return null;
        }
        const value: unknown = Reflect.get(row, key);
        return typeof value === 'number' && Number.isFinite(value)
            ? value
            : null;
    }

    /**
     * Reads a string from an untrusted SQLite row or nested artifact object.
     *
     * @param row - Unknown query/object result.
     * @param key - Allow-listed string field.
     * @returns String or `null`.
     */
    private static readString(row: unknown, key: string): string | null {
        if (row === null || typeof row !== 'object') {
            return null;
        }
        const value: unknown = Reflect.get(row, key);
        return typeof value === 'string' ? value : null;
    }

    /**
     * Avoids masking an original transaction failure with a rollback error.
     *
     * @param database - Connection whose transaction may still be active.
     */
    private static rollbackSafely(database: DatabaseSync): void {
        try {
            database.exec('ROLLBACK');
        } catch {
            // The original database error is more useful than a redundant rollback failure.
        }
    }

    /**
     * Releases the singleton connection before tests switch paths or clean files.
     */
    private static closeDatabase(): void {
        if (BackendPublicState.database !== null) {
            BackendPublicState.maintainSqliteFileSafely(
                BackendPublicState.database,
            );
        }
        BackendPublicState.database?.close();
        BackendPublicState.database = null;
    }

    /**
     * Bounds event/history growth and conservatively settles model reservations left by crashes.
     *
     * @param nowMs - Current request timestamp used for retention cutoffs.
     */
    private static runHousekeeping(nowMs: number): void {
        if (
            BackendPublicState.lastHousekeepingAtMs !== 0 &&
            nowMs >= BackendPublicState.lastHousekeepingAtMs &&
            nowMs - BackendPublicState.lastHousekeepingAtMs <
                HOUSEKEEPING_INTERVAL_MS
        ) {
            return;
        }
        const database = BackendPublicState.getDatabase();
        database.exec('BEGIN IMMEDIATE');
        try {
            const staleReservations = database
                .prepare(
                    `SELECT reservation_id, day_key, month_key, reserved_usd
                     FROM model_budget_reservations
                     WHERE created_at_ms <= ?`,
                )
                .all(nowMs - STALE_MODEL_RESERVATION_MS);
            for (const row of staleReservations) {
                const reservationId = BackendPublicState.readString(
                    row,
                    'reservation_id',
                );
                const dayKey = BackendPublicState.readString(row, 'day_key');
                const monthKey = BackendPublicState.readString(
                    row,
                    'month_key',
                );
                const reservedUsd = BackendPublicState.readNumber(
                    row,
                    'reserved_usd',
                );
                if (
                    reservationId === null ||
                    dayKey === null ||
                    monthKey === null ||
                    reservedUsd === null
                ) {
                    continue;
                }
                BackendPublicState.settleBudgetPeriod(
                    database,
                    dayKey,
                    reservedUsd,
                    reservedUsd,
                );
                BackendPublicState.settleBudgetPeriod(
                    database,
                    monthKey,
                    reservedUsd,
                    reservedUsd,
                );
                database
                    .prepare(
                        'DELETE FROM model_budget_reservations WHERE reservation_id = ?',
                    )
                    .run(reservationId);
            }
            database
                .prepare('DELETE FROM quota_events WHERE created_at_ms <= ?')
                .run(nowMs - DAY_MS);
            database
                .prepare('DELETE FROM installations WHERE expires_at_ms <= ?')
                .run(nowMs - 30 * DAY_MS);
            database
                .prepare(
                    'DELETE FROM analysis_failures WHERE expires_at_ms <= ?',
                )
                .run(nowMs);
            BackendPublicState.pruneArtifactRows(database, nowMs);
            database.exec('COMMIT');
            BackendPublicState.lastHousekeepingAtMs = nowMs;
            BackendPublicState.maintainSqliteFileSafely(database);
        } catch (error) {
            BackendPublicState.rollbackSafely(database);
            throw error;
        }
    }
}
