import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';

import {
    analysisRunArtifactSchema,
    BACKEND_ANALYSIS_PROVIDER_ID,
    BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH,
    type AnalysisRunArtifact,
} from '@topskip/backend/analysis/promo-analysis-types';
import {
    subtitleExtractionAttemptSchema,
    transcriptArtifactSchema,
    type SubtitleExtractionAttempt,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    noPromoResponseSchema,
    readyResponseSchema,
    terminalErrorResponseSchema,
    unavailableResponseSchema,
} from '@topskip/common/server-analysis-contract';
import { MS_PER_SECOND, SECONDS_PER_HOUR } from '@topskip/common/constants';
import { BackendPublicState } from '@topskip/backend/public-state';

const TEST_TRANSCRIPT_TEXT =
    'Intro content. This segment is sponsored by a local fixture.';
const TEST_RAW_MODEL_RESPONSE =
    '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24,"confidence":"high"}]}';
const TEST_RAW_NO_PROMO_MODEL_RESPONSE = '{"hasPromo":false}';
const TEST_JOB_ID = 'local-dQw4w9WgXcQ-server-v1';
const TEST_COMPLETED_AT_MS = 1_900_000_001_000;
const TEST_CREATED_AT_MS = 1_900_000_000_000;
const TEST_EXPIRES_AT_MS = 4_102_444_800_000;
const TEST_DURATION_SEC = 120;
const ARTIFACT_STORE_SCHEMA_VERSION = 1;
const DEFAULT_ARTIFACT_STORAGE_DIRECTORY = '.topskip-data';
const ARTIFACT_STORAGE_FILE_NAME = 'analysis-artifacts.json';
const VITEST_ENVIRONMENT_VARIABLE = 'VITEST';
const VITEST_POOL_ID_ENVIRONMENT_VARIABLE = 'VITEST_POOL_ID';
const VITEST_WORKER_ID_ENVIRONMENT_VARIABLE = 'VITEST_WORKER_ID';
const VITEST_ARTIFACT_STORAGE_DIRECTORY_PREFIX =
    'topskip-vitest-analysis-artifacts';
const DEFAULT_VITEST_WORKER_ID = 'main';
const FILE_ENCODING = 'utf8';
const HOURS_PER_DAY = 24;
const ARTIFACT_RETENTION_DAYS = 30;
const MAX_ARTIFACT_RECORD_COUNT = 10_000;
const ARTIFACT_RETENTION_MS =
    ARTIFACT_RETENTION_DAYS * HOURS_PER_DAY * SECONDS_PER_HOUR * MS_PER_SECOND;
const TEMPORARY_FILE_SUFFIX = '.tmp';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CORRUPT_FILE_SUFFIX = '.corrupt';

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Epoch milliseconds must be finite.',
    ),
    v.integer(),
    v.minValue(1),
);

const safeOperationalValueSchema = v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
]);

const operationalArtifactSourceSchema = v.picklist([
    'local_backend',
    'test_fixture',
] as const);

const operationalProviderSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u),
);

/**
 * Only non-payload identifiers may survive in durable operational diagnostics.
 */
type SafeOperationalDiagnostics = {
    artifactSource?: v.InferOutput<typeof operationalArtifactSourceSchema>;
    provider?: string;
};

const safeOperationalDiagnosticsSchema = v.pipe(
    v.record(v.string(), safeOperationalValueSchema),
    v.transform((input): SafeOperationalDiagnostics => {
        const diagnostics: SafeOperationalDiagnostics = {};
        const artifactSource = v.safeParse(
            operationalArtifactSourceSchema,
            input.artifactSource,
        );
        if (artifactSource.success) {
            diagnostics.artifactSource = artifactSource.output;
        }
        const provider = v.safeParse(operationalProviderSchema, input.provider);
        if (provider.success) {
            diagnostics.provider = provider.output;
        }
        return diagnostics;
    }),
    v.strictObject({
        artifactSource: v.optional(operationalArtifactSourceSchema),
        provider: v.optional(operationalProviderSchema),
    }),
);

const legacyUnavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    reason: v.picklist([
        'fixture_unavailable',
        'caption_extraction_failed',
    ] as const),
    message: v.pipe(v.string(), v.minLength(1)),
});

const legacyTerminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: v.picklist([
            'fixture_error',
            'invalid_model_response',
            'unsafe_model_blocks',
            'model_provider_error',
        ] as const),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

const legacyReadyResponseSchema = v.strictObject({
    status: v.literal('ready'),
    videoId: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    source: v.literal('server_cache'),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: v.strictObject({
        expiresAtMs: finiteEpochMsSchema,
    }),
    promoBlocks: v.pipe(
        v.array(
            v.strictObject({
                startSec: v.pipe(v.number(), v.minValue(0)),
                endSec: v.optional(v.pipe(v.number(), v.minValue(0))),
                confidence: v.optional(
                    v.picklist(['low', 'medium', 'high'] as const),
                ),
            }),
        ),
        v.minLength(1),
    ),
});

const legacyNoPromoResponseSchema = v.strictObject({
    status: v.literal('no_promo'),
    videoId: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: v.strictObject({
        expiresAtMs: finiteEpochMsSchema,
    }),
});

const legacyStructuredUnavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: v.pipe(v.string(), v.minLength(1)),
        supportId: v.optional(v.pipe(v.string(), v.minLength(1))),
        retryAfterSec: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(1)),
        ),
    }),
});

const legacyStructuredTerminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: v.optional(v.pipe(v.string(), v.minLength(1))),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: v.pipe(v.string(), v.minLength(1)),
        supportId: v.optional(v.pipe(v.string(), v.minLength(1))),
        retryAfterSec: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(1)),
        ),
    }),
});

const terminalResponseSchema = v.union([
    readyResponseSchema,
    noPromoResponseSchema,
    unavailableResponseSchema,
    terminalErrorResponseSchema,
    legacyReadyResponseSchema,
    legacyNoPromoResponseSchema,
    legacyStructuredUnavailableResponseSchema,
    legacyStructuredTerminalErrorResponseSchema,
    legacyUnavailableResponseSchema,
    legacyTerminalErrorResponseSchema,
]);

const storedTranscriptHashSchema = v.pipe(
    v.string(),
    v.regex(/^[0-9a-f]{64}$/u),
);

const storedSourceTypeSchema = v.picklist([
    'extension_caption_upload',
    'local_fixture',
    'youtube_timedtext',
    'youtube_yt_dlp',
] as const);

/**
 * Bounded metadata keeps operational history useful without persisting payloads.
 */
export const analysisOperationalMetadataSchema = v.strictObject({
    promptVersion: v.pipe(v.string(), v.minLength(1)),
    modelVersion: v.pipe(v.string(), v.minLength(1)),
    timing: v.strictObject({
        queuedAtMs: finiteEpochMsSchema,
        startedAtMs: finiteEpochMsSchema,
        completedAtMs: finiteEpochMsSchema,
        totalLatencyMs: v.pipe(v.number(), v.minValue(0)),
    }),
    cost: v.strictObject({
        estimatedUsd: v.nullable(v.number()),
        inputTokens: v.nullable(v.number()),
        outputTokens: v.nullable(v.number()),
    }),
    diagnostics: safeOperationalDiagnosticsSchema,
});

const analysisArtifactBaseRecordSchema = v.strictObject({
    recordId: v.pipe(v.string(), v.minLength(1)),
    video: v.strictObject({
        videoId: v.pipe(v.string(), v.minLength(1)),
        durationSec: v.optional(v.pipe(v.number(), v.minValue(0.001))),
        algorithmVersion: v.pipe(v.string(), v.minLength(1)),
        languageCode: v.optional(
            v.nullable(v.pipe(v.string(), v.minLength(1))),
        ),
        transcriptHash: v.optional(v.nullable(storedTranscriptHashSchema)),
        sourceType: v.optional(v.nullable(storedSourceTypeSchema)),
    }),
    job: v.strictObject({
        jobId: v.pipe(v.string(), v.minLength(1)),
        createdAtMs: finiteEpochMsSchema,
        completedAtMs: finiteEpochMsSchema,
        retryCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
        joinedRequestCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
        finalStatus: v.picklist([
            'ready',
            'no_promo',
            'unavailable',
            'error',
        ] as const),
    }),
    extractionAttempts: v.array(subtitleExtractionAttemptSchema),
    selectedTranscriptArtifact: v.nullable(transcriptArtifactSchema),
    analysisRun: v.nullable(analysisRunArtifactSchema),
    terminalResponse: terminalResponseSchema,
    operationalMetadata: analysisOperationalMetadataSchema,
});

/**
 * Ready records require worker artifacts; legacy terminal history remains readable but is revalidated before cache reuse.
 */
export const analysisArtifactRecordSchema = v.pipe(
    analysisArtifactBaseRecordSchema,
    v.check((record) => {
        if (
            record.terminalResponse.status !== 'ready' &&
            record.terminalResponse.status !== 'no_promo'
        ) {
            return true;
        }
        if (
            record.terminalResponse.status === 'no_promo' &&
            record.selectedTranscriptArtifact === null &&
            record.analysisRun === null
        ) {
            return true;
        }
        return AnalysisArtifactStore.hasValidCacheArtifacts(record);
    }),
);

const persistedArtifactStoreSchema = v.strictObject({
    schemaVersion: v.literal(ARTIFACT_STORE_SCHEMA_VERSION),
    records: v.array(analysisArtifactRecordSchema),
});

/**
 * Operational metadata retained next to a completed analysis artifact.
 */
export type AnalysisOperationalMetadata = v.InferOutput<
    typeof analysisOperationalMetadataSchema
>;

/**
 * Backend-owned terminal response shape stored in artifact history.
 */
export type AnalysisArtifactTerminalResponse = v.InferOutput<
    typeof terminalResponseSchema
>;

/**
 * Completed backend analysis history record.
 */
export type AnalysisArtifactRecord = v.InferOutput<
    typeof analysisArtifactRecordSchema
>;

/**
 * Untrusted artifact input is parsed before entering the repository.
 */
export type AnalysisArtifactRecordInput = v.InferInput<
    typeof analysisArtifactRecordSchema
>;

/**
 * Test helper input keeps fixtures concise while still passing production validation.
 */
type BuildRecordForTestsInput = {
    videoId: string;
    algorithmVersion: string;
    terminalStatus: AnalysisArtifactTerminalResponse['status'];
    completedAtMs?: number;
    selectedTranscriptArtifact?: TranscriptArtifact | null;
    analysisRun?: AnalysisRunArtifact | null;
    operationalMetadata?: Partial<AnalysisOperationalMetadata> & {
        diagnostics?: Record<string, string | number | boolean | null>;
    };
};

/**
 * Query key used by artifact history reads.
 */
type ArtifactVideoQuery = {
    videoId: string;
    algorithmVersion?: string;
};

/**
 * Exact uploaded-transcript identity prevents cache reuse across caption variants.
 */
export type ExactArtifactIdentity = {
    videoId: string;
    algorithmVersion: string;
    languageCode: string;
    transcriptHash: string;
};

/**
 * Owns durable local backend analysis artifacts behind a stable repository API.
 *
 * History is retained for 30 days, while ready cache records expire earlier when
 * their server freshness deadline passes. The local backend does not persist raw
 * audio or video media; atomic write temporary files are removed after each save.
 */
export class AnalysisArtifactStore {
    /**
     * Legacy JSON/test records; production SQLite never materializes global history.
     */
    private static recordsById: Map<string, AnalysisArtifactRecord> | null =
        null;

    /**
     * Test-only path override keeps persistence tests isolated from local data.
     */
    private static storagePathForTests: string | null = null;

    /**
     * Saves one validated artifact record after filtering operational metadata.
     *
     * @param record - Completed artifact record from a backend job.
     * @returns Defensive copy of the saved record.
     */
    static save(record: AnalysisArtifactRecordInput): AnalysisArtifactRecord {
        const parsed = v.parse(analysisArtifactRecordSchema, {
            ...record,
            operationalMetadata:
                AnalysisArtifactStore.redactOperationalMetadata(
                    record.operationalMetadata,
                ),
        });
        if (AnalysisArtifactStore.usesSqlitePersistence()) {
            BackendPublicState.upsertArtifact(parsed);
            return structuredClone(parsed);
        }
        const records = AnalysisArtifactStore.getRecords();
        AnalysisArtifactStore.pruneExpiredRecords(records);
        records.set(parsed.recordId, structuredClone(parsed));
        AnalysisArtifactStore.pruneExcessRecords(records);
        AnalysisArtifactStore.persistRecords(records);
        return structuredClone(parsed);
    }

    /**
     * Returns all history for one video, preserving per-version records.
     *
     * @param input - Video key and optional algorithm version.
     * @returns Completed records sorted by completion timestamp.
     */
    static findHistory(input: ArtifactVideoQuery): AnalysisArtifactRecord[] {
        if (AnalysisArtifactStore.usesSqlitePersistence()) {
            return BackendPublicState.findArtifacts(input)
                .flatMap((record) => {
                    const parsed = v.safeParse(
                        analysisArtifactRecordSchema,
                        record,
                    );
                    return parsed.success ? [parsed.output] : [];
                })
                .map((record) => structuredClone(record));
        }
        const records = AnalysisArtifactStore.getRecords();
        AnalysisArtifactStore.pruneExpiredRecords(records);
        return [...records.values()]
            .filter(
                (record) =>
                    record.video.videoId === input.videoId &&
                    (input.algorithmVersion === undefined ||
                        record.video.algorithmVersion ===
                            input.algorithmVersion),
            )
            .sort(
                (left, right) =>
                    left.job.completedAtMs - right.job.completedAtMs,
            )
            .map((record) => structuredClone(record));
    }

    /**
     * Finds the newest cacheable ready artifact for a video and algorithm.
     *
     * @param input - Exact video and algorithm version cache key.
     * @returns Latest ready artifact record, or `null` when absent.
     */
    static findLatestReady(input: {
        videoId: string;
        algorithmVersion: string;
    }): AnalysisArtifactRecord | null {
        const latest = AnalysisArtifactStore.findHistory(input)
            .filter(
                (record) =>
                    record.terminalResponse.status === 'ready' &&
                    Date.now() < record.terminalResponse.freshness.expiresAtMs,
            )
            .at(-1);
        return latest ?? null;
    }

    /**
     * Temporarily preserves the pre-v5 lookup until all legacy call sites are isolated.
     *
     * @param input - Exact video and algorithm version cache key.
     * @returns Latest ready or no-promo artifact record, or `null` when absent.
     * @deprecated Call the explicit exact or legacy method after routing by startup mode.
     */
    static findLatestCacheable(input: {
        videoId: string;
        algorithmVersion: string;
    }): AnalysisArtifactRecord | null {
        return AnalysisArtifactStore.findLatestLegacyCacheable(
            input.videoId,
            input.algorithmVersion,
        );
    }

    /**
     * Finds only an uploaded-caption result with the complete authoritative identity.
     *
     * @param identity - Exact video, algorithm, language, and transcript fingerprint.
     * @returns Latest unexpired exact record, or `null` when any component differs.
     */
    static findLatestCacheableExact(
        identity: ExactArtifactIdentity,
    ): AnalysisArtifactRecord | null {
        const records = AnalysisArtifactStore.usesSqlitePersistence()
            ? BackendPublicState.findArtifactsExact(identity).flatMap(
                  (record) => {
                      const parsed = v.safeParse(
                          analysisArtifactRecordSchema,
                          record,
                      );
                      return parsed.success ? [parsed.output] : [];
                  },
              )
            : AnalysisArtifactStore.findHistory({
                  videoId: identity.videoId,
                  algorithmVersion: identity.algorithmVersion,
              }).filter((record) =>
                  AnalysisArtifactStore.matchesExactIdentity(record, identity),
              );
        return AnalysisArtifactStore.latestCacheable(records);
    }

    /**
     * Preserves the old video/version cache path for the process-wide legacy mode only.
     *
     * @param videoId - Legacy video identity.
     * @param algorithmVersion - Legacy algorithm identity.
     * @returns Latest unexpired legacy-source result, or `null`.
     */
    static findLatestLegacyCacheable(
        videoId: string,
        algorithmVersion: string,
    ): AnalysisArtifactRecord | null {
        const records = AnalysisArtifactStore.findHistory({
            videoId,
            algorithmVersion,
        }).filter(
            (record) =>
                record.selectedTranscriptArtifact?.sourceType !==
                'extension_caption_upload',
        );
        return AnalysisArtifactStore.latestCacheable(records);
    }

    /**
     * Builds an opaque record id without embedding transcript identity.
     *
     * @param _input - Ignored historical identity retained for call-site compatibility.
     * @param _completedAtMs - Ignored historical timestamp retained for compatibility.
     * @returns UUID-based artifact record id.
     */
    static buildRecordId(
        _input: {
            videoId: string;
            algorithmVersion: string;
            jobId: string;
            terminalResponse: AnalysisArtifactTerminalResponse;
        },
        _completedAtMs: number,
    ): string {
        return `artifact-${randomUUID()}`;
    }

    /**
     * Builds deterministic local metadata for completed MVP jobs.
     *
     * @param input - Job timing and optional analysis run.
     * @param completedAtMs - Completion timestamp.
     * @returns Safe default operational metadata.
     */
    static buildDefaultOperationalMetadata(
        input: {
            createdAtMs: number;
            selectedTranscriptArtifact: TranscriptArtifact | null;
            analysisRun: AnalysisRunArtifact | null;
        },
        completedAtMs: number,
    ): AnalysisOperationalMetadata {
        const startedAtMs =
            input.analysisRun?.startedAtMs ??
            input.selectedTranscriptArtifact?.acquiredAtMs ??
            input.createdAtMs;
        return AnalysisArtifactStore.redactOperationalMetadata({
            promptVersion:
                input.analysisRun?.promptVersion ??
                input.analysisRun?.provider ??
                'local_fixture',
            modelVersion:
                input.analysisRun?.model ??
                input.analysisRun?.provider ??
                'local_fixture',
            timing: {
                queuedAtMs: input.createdAtMs,
                startedAtMs,
                completedAtMs,
                totalLatencyMs: Math.max(0, completedAtMs - input.createdAtMs),
            },
            cost: {
                estimatedUsd: input.analysisRun?.usage?.costUsd ?? null,
                inputTokens: input.analysisRun?.usage?.inputTokens ?? null,
                outputTokens: input.analysisRun?.usage?.outputTokens ?? null,
            },
            diagnostics: {
                artifactSource: 'local_backend',
                provider: input.analysisRun?.provider ?? 'none',
            },
        });
    }

    /**
     * Retains only explicitly approved bounded identifiers before validation.
     *
     * @param metadata - Operational metadata supplied by backend callers.
     * @returns Metadata with every non-allow-listed diagnostic entry removed.
     */
    static redactOperationalMetadata(
        metadata: AnalysisOperationalMetadata,
    ): AnalysisOperationalMetadata {
        return v.parse(analysisOperationalMetadataSchema, metadata);
    }

    /**
     * Returns cloned history for tests that need to inspect the repository state.
     *
     * @returns All saved artifact records.
     */
    static snapshotForTests(): AnalysisArtifactRecord[] {
        const records = AnalysisArtifactStore.getRecords();
        AnalysisArtifactStore.pruneExpiredRecords(records);
        return [...records.values()].map((record) => structuredClone(record));
    }

    /**
     * Clears durable artifact history so tests stay independent.
     */
    static resetForTests(): void {
        const storagePath = AnalysisArtifactStore.getStoragePath();
        AnalysisArtifactStore.recordsById = new Map();
        rmSync(storagePath, { force: true });
        if (
            AnalysisArtifactStore.storagePathForTests === null &&
            AnalysisArtifactStore.isVitestRuntime()
        ) {
            rmSync(dirname(storagePath), { force: true, recursive: true });
        }
    }

    /**
     * Selects an isolated durable repository file for one persistence test.
     *
     * @param storagePath - Absolute path used by the test's local repository.
     * @returns Nothing.
     */
    static setStoragePathForTests(storagePath: string): void {
        AnalysisArtifactStore.storagePathForTests = storagePath;
        AnalysisArtifactStore.recordsById = null;
    }

    /**
     * Drops the process cache while preserving the durable test repository.
     *
     * @returns Nothing.
     */
    static resetRuntimeCacheForTests(): void {
        AnalysisArtifactStore.recordsById = null;
    }

    /**
     * Restores production path resolution after an isolated persistence test.
     *
     * @returns Nothing.
     */
    static resetStoragePathForTests(): void {
        AnalysisArtifactStore.storagePathForTests = null;
        AnalysisArtifactStore.recordsById = null;
    }

    /**
     * Builds validated records for tests without coupling them to every schema detail.
     *
     * @param input - Test-specific overrides.
     * @returns Redacted artifact record.
     */
    static buildRecordForTests(
        input: BuildRecordForTestsInput,
    ): AnalysisArtifactRecord {
        const completedAtMs = input.completedAtMs ?? TEST_COMPLETED_AT_MS;
        const isAnalyzedResult =
            input.terminalStatus === 'ready' ||
            input.terminalStatus === 'no_promo';
        const selectedTranscriptArtifact =
            'selectedTranscriptArtifact' in input &&
            input.selectedTranscriptArtifact !== undefined
                ? input.selectedTranscriptArtifact
                : isAnalyzedResult
                  ? AnalysisArtifactStore.buildTranscriptArtifactForTests(
                        input,
                        TEST_CREATED_AT_MS,
                    )
                  : null;
        const terminalResponse =
            AnalysisArtifactStore.buildTerminalResponseForTests(
                input,
                selectedTranscriptArtifact,
            );
        const analysisRun =
            'analysisRun' in input && input.analysisRun !== undefined
                ? input.analysisRun
                : isAnalyzedResult && selectedTranscriptArtifact !== null
                  ? AnalysisArtifactStore.buildAnalysisRunForTests(
                        input,
                        selectedTranscriptArtifact,
                        completedAtMs,
                    )
                  : null;
        const metadata = AnalysisArtifactStore.mergeOperationalMetadata(
            input,
            completedAtMs,
        );

        return v.parse(analysisArtifactRecordSchema, {
            recordId: AnalysisArtifactStore.buildRecordId(
                {
                    videoId: input.videoId,
                    algorithmVersion: input.algorithmVersion,
                    jobId: TEST_JOB_ID,
                    terminalResponse,
                },
                completedAtMs,
            ),
            video: {
                videoId: input.videoId,
                durationSec: TEST_DURATION_SEC,
                algorithmVersion: input.algorithmVersion,
                ...(selectedTranscriptArtifact?.sourceType ===
                'extension_caption_upload'
                    ? {
                          languageCode: selectedTranscriptArtifact.languageCode,
                          transcriptHash:
                              selectedTranscriptArtifact.transcriptHash,
                          sourceType: selectedTranscriptArtifact.sourceType,
                      }
                    : {}),
            },
            job: {
                jobId: TEST_JOB_ID,
                createdAtMs: TEST_CREATED_AT_MS,
                completedAtMs,
                retryCount: 0,
                joinedRequestCount: 0,
                finalStatus: terminalResponse.status,
            },
            extractionAttempts: [
                AnalysisArtifactStore.buildExtractionAttemptForTests(),
            ],
            selectedTranscriptArtifact,
            analysisRun,
            terminalResponse,
            operationalMetadata:
                AnalysisArtifactStore.redactOperationalMetadata(metadata),
        });
    }

    /**
     * Enforces that successful cache records are backed by worker-produced artifacts.
     *
     * @param record - Parsed base artifact record to validate across fields.
     * @returns Whether the record is safe to persist.
     */
    static hasValidCacheArtifacts(
        record: v.InferOutput<typeof analysisArtifactBaseRecordSchema>,
    ): boolean {
        if (
            record.terminalResponse.status !== 'ready' &&
            record.terminalResponse.status !== 'no_promo'
        ) {
            return false;
        }
        if (
            record.selectedTranscriptArtifact === null ||
            record.analysisRun === null ||
            record.analysisRun.rawModelResponse === null ||
            record.analysisRun.parsedResult === null ||
            record.analysisRun.failureReason !== null
        ) {
            return false;
        }
        if (
            record.selectedTranscriptArtifact.videoId !==
                record.video.videoId ||
            record.analysisRun.videoId !== record.video.videoId ||
            record.terminalResponse.videoId !== record.video.videoId
        ) {
            return false;
        }
        if (
            record.selectedTranscriptArtifact.algorithmVersion !==
                record.video.algorithmVersion ||
            record.analysisRun.algorithmVersion !==
                record.video.algorithmVersion ||
            record.terminalResponse.algorithmVersion !==
                record.video.algorithmVersion
        ) {
            return false;
        }
        if (
            record.analysisRun.transcriptArtifactId !==
            record.selectedTranscriptArtifact.artifactId
        ) {
            return false;
        }
        if (
            record.selectedTranscriptArtifact.sourceType ===
            'extension_caption_upload'
        ) {
            if (
                record.video.languageCode !==
                    record.selectedTranscriptArtifact.languageCode ||
                record.video.transcriptHash !==
                    record.selectedTranscriptArtifact.transcriptHash ||
                record.video.sourceType !==
                    record.selectedTranscriptArtifact.sourceType ||
                !('languageCode' in record.terminalResponse) ||
                record.terminalResponse.languageCode !==
                    record.selectedTranscriptArtifact.languageCode ||
                !('transcriptHash' in record.terminalResponse) ||
                record.terminalResponse.transcriptHash !==
                    record.selectedTranscriptArtifact.transcriptHash
            ) {
                return false;
            }
        }
        if (record.terminalResponse.status === 'no_promo') {
            return (
                !record.analysisRun.parsedResult.hasPromo &&
                record.analysisRun.normalizedPromoBlocks.length === 0
            );
        }
        return (
            record.analysisRun.parsedResult.hasPromo &&
            JSON.stringify(record.analysisRun.normalizedPromoBlocks) ===
                JSON.stringify(record.terminalResponse.promoBlocks)
        );
    }

    /**
     * Selects the newest valid, unexpired result from already scoped candidates.
     *
     * @param records - Records already constrained to one cache identity.
     * @returns Latest cacheable record or null.
     */
    private static latestCacheable(
        records: AnalysisArtifactRecord[],
    ): AnalysisArtifactRecord | null {
        const latest = records
            .filter(
                (record) =>
                    (record.terminalResponse.status === 'ready' ||
                        record.terminalResponse.status === 'no_promo') &&
                    AnalysisArtifactStore.hasValidCacheArtifacts(record) &&
                    Date.now() < record.terminalResponse.freshness.expiresAtMs,
            )
            .at(-1);
        return latest ?? null;
    }

    /**
     * Keeps JSON-test persistence subject to the same identity checks as SQLite.
     *
     * @param record - Validated persisted artifact.
     * @param identity - Exact requested upload identity.
     * @returns Whether every identity component and source match.
     */
    private static matchesExactIdentity(
        record: AnalysisArtifactRecord,
        identity: ExactArtifactIdentity,
    ): boolean {
        return (
            record.video.videoId === identity.videoId &&
            record.video.algorithmVersion === identity.algorithmVersion &&
            record.video.languageCode === identity.languageCode &&
            record.video.transcriptHash === identity.transcriptHash &&
            record.video.sourceType === 'extension_caption_upload'
        );
    }

    /**
     * Lazily loads and prunes the local artifact repository after process start.
     *
     * @returns Mutable internal records that callers never receive directly.
     */
    private static getRecords(): Map<string, AnalysisArtifactRecord> {
        if (AnalysisArtifactStore.recordsById !== null) {
            return AnalysisArtifactStore.recordsById;
        }

        const records = AnalysisArtifactStore.loadRecords();
        AnalysisArtifactStore.recordsById = records;
        AnalysisArtifactStore.pruneExpiredRecords(records);
        return records;
    }

    /**
     * Loads validated records from the configured durable local file.
     *
     * @returns Records keyed by their stable artifact identity.
     */
    private static loadRecords(): Map<string, AnalysisArtifactRecord> {
        const storagePath = AnalysisArtifactStore.getStoragePath();
        if (!existsSync(storagePath)) {
            return new Map();
        }

        let serialized: unknown;
        try {
            serialized = JSON.parse(readFileSync(storagePath, FILE_ENCODING));
        } catch {
            return AnalysisArtifactStore.recoverCorruptStore(storagePath);
        }

        const parsed = v.safeParse(persistedArtifactStoreSchema, serialized);
        if (!parsed.success) {
            return AnalysisArtifactStore.recoverCorruptStore(storagePath);
        }

        return new Map(
            parsed.output.records.map((record) => [
                record.recordId,
                structuredClone(record),
            ]),
        );
    }

    /**
     * Removes history only after its debug-retention deadline passes.
     *
     * @param records - Mutable repository records to evaluate.
     * @returns Whether expired records were removed and flushed to disk.
     */
    private static pruneExpiredRecords(
        records: Map<string, AnalysisArtifactRecord>,
    ): boolean {
        const nowMs = Date.now();
        let removed = false;
        for (const [recordId, record] of records) {
            if (AnalysisArtifactStore.isRetained(record, nowMs)) {
                continue;
            }
            records.delete(recordId);
            removed = true;
        }

        if (removed) {
            AnalysisArtifactStore.persistRecords(records);
        }
        return removed;
    }

    /**
     * Caps retained records so one local backend cannot grow without a resource limit.
     *
     * @param records - Mutable repository records ordered by their completion metadata.
     * @returns Whether older history was evicted to enforce the capacity limit.
     */
    private static pruneExcessRecords(
        records: Map<string, AnalysisArtifactRecord>,
    ): boolean {
        const excessCount = records.size - MAX_ARTIFACT_RECORD_COUNT;
        if (excessCount <= 0) {
            return false;
        }

        const oldest = [...records.values()]
            .sort(
                (left, right) =>
                    left.job.completedAtMs - right.job.completedAtMs,
            )
            .slice(0, excessCount);
        for (const record of oldest) {
            records.delete(record.recordId);
        }
        return true;
    }

    /**
     * Applies the 30-day artifact policy independently of ready-cache freshness.
     *
     * @param record - Completed history record under retention review.
     * @param nowMs - Current timestamp used to enforce the policy.
     * @returns Whether the record remains available for debugging.
     */
    private static isRetained(
        record: AnalysisArtifactRecord,
        nowMs: number,
    ): boolean {
        const historyExpiresAtMs =
            record.job.completedAtMs + ARTIFACT_RETENTION_MS;
        return nowMs < historyExpiresAtMs;
    }

    /**
     * Writes repository state atomically so a completed job survives a restart.
     *
     * @param records - Validated records to persist.
     * @returns Nothing.
     */
    private static persistRecords(
        records: Map<string, AnalysisArtifactRecord>,
    ): void {
        const storagePath = AnalysisArtifactStore.getStoragePath();
        const temporaryPath = `${storagePath}.${process.pid}${TEMPORARY_FILE_SUFFIX}`;
        const storageDirectory = dirname(storagePath);
        mkdirSync(storageDirectory, {
            recursive: true,
            mode: PRIVATE_DIRECTORY_MODE,
        });
        chmodSync(storageDirectory, PRIVATE_DIRECTORY_MODE);
        writeFileSync(
            temporaryPath,
            JSON.stringify({
                schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
                records: [...records.values()],
            }),
            { encoding: FILE_ENCODING, mode: PRIVATE_FILE_MODE },
        );

        try {
            renameSync(temporaryPath, storagePath);
            chmodSync(storagePath, PRIVATE_FILE_MODE);
        } finally {
            if (existsSync(temporaryPath)) {
                unlinkSync(temporaryPath);
            }
        }
    }

    /**
     * Resolves the explicitly configured local repository file for this process.
     *
     * @returns Path used for durable artifact persistence.
     */
    private static getStoragePath(): string {
        if (AnalysisArtifactStore.storagePathForTests !== null) {
            return AnalysisArtifactStore.storagePathForTests;
        }
        if (AnalysisArtifactStore.isVitestRuntime()) {
            return AnalysisArtifactStore.getVitestStoragePath();
        }
        return join(
            process.cwd(),
            DEFAULT_ARTIFACT_STORAGE_DIRECTORY,
            ARTIFACT_STORAGE_FILE_NAME,
        );
    }

    /**
     * Keeps legacy JSON only for isolated Vitest persistence fixtures.
     *
     * @returns Whether production artifacts belong in the shared SQLite database.
     */
    private static usesSqlitePersistence(): boolean {
        return (
            AnalysisArtifactStore.storagePathForTests === null &&
            !AnalysisArtifactStore.isVitestRuntime()
        );
    }

    /**
     * Detects Vitest directly because individual tests may intentionally override Node's environment mode.
     *
     * @returns Whether the current process was launched by Vitest.
     */
    private static isVitestRuntime(): boolean {
        const vitestValue = process.env[VITEST_ENVIRONMENT_VARIABLE];
        return vitestValue === 'true' || vitestValue === '1';
    }

    /**
     * Gives every Vitest worker a private durable file without sharing the workspace's production repository.
     *
     * @returns OS-temporary path used by the current Vitest worker.
     */
    private static getVitestStoragePath(): string {
        const workerId =
            process.env[VITEST_WORKER_ID_ENVIRONMENT_VARIABLE] ??
            process.env[VITEST_POOL_ID_ENVIRONMENT_VARIABLE] ??
            DEFAULT_VITEST_WORKER_ID;
        const safeWorkerId = workerId.replaceAll(/[^A-Za-z0-9_-]/g, '_');
        const storageDirectory = join(
            tmpdir(),
            `${VITEST_ARTIFACT_STORAGE_DIRECTORY_PREFIX}-${process.pid}-${safeWorkerId}`,
        );
        return join(storageDirectory, ARTIFACT_STORAGE_FILE_NAME);
    }

    /**
     * Preserves an invalid store for diagnosis while restoring backend availability.
     *
     * @param storagePath - Existing repository file that could not be loaded.
     * @returns Empty records after the unusable store is quarantined.
     */
    private static recoverCorruptStore(
        storagePath: string,
    ): Map<string, AnalysisArtifactRecord> {
        const quarantinePath = `${storagePath}.${Date.now()}${CORRUPT_FILE_SUFFIX}`;
        try {
            renameSync(storagePath, quarantinePath);
            console.error(
                `TopSkip quarantined an invalid analysis artifact store at ${quarantinePath}.`,
            );
        } catch {
            console.error(
                `TopSkip could not load analysis artifacts at ${storagePath}; starting with an empty store.`,
            );
        }
        return new Map();
    }

    /**
     * Builds schema-valid terminal payloads for repository tests.
     *
     * @param input - Test-specific terminal status.
     * @param transcriptArtifact - Selected transcript used to choose exact or legacy shape.
     * @returns Terminal response matching the requested state.
     */
    private static buildTerminalResponseForTests(
        input: BuildRecordForTestsInput,
        transcriptArtifact: TranscriptArtifact | null,
    ): AnalysisArtifactTerminalResponse {
        const resultId = `result-${randomUUID()}`;
        const uploadIdentity =
            transcriptArtifact?.sourceType === 'extension_caption_upload'
                ? {
                      languageCode: transcriptArtifact.languageCode,
                      transcriptHash: transcriptArtifact.transcriptHash,
                  }
                : null;
        switch (input.terminalStatus) {
            case 'ready':
                return v.parse(
                    uploadIdentity === null
                        ? legacyReadyResponseSchema
                        : readyResponseSchema,
                    {
                        status: 'ready',
                        videoId: input.videoId,
                        algorithmVersion: input.algorithmVersion,
                        ...(uploadIdentity ?? {}),
                        source: 'server_cache',
                        sourceResultId: resultId,
                        freshness: { expiresAtMs: TEST_EXPIRES_AT_MS },
                        promoBlocks: [
                            { startSec: 4, endSec: 24, confidence: 'high' },
                        ],
                    },
                );
            case 'no_promo':
                return v.parse(
                    uploadIdentity === null
                        ? legacyNoPromoResponseSchema
                        : noPromoResponseSchema,
                    {
                        status: 'no_promo',
                        videoId: input.videoId,
                        algorithmVersion: input.algorithmVersion,
                        ...(uploadIdentity ?? {}),
                        sourceResultId: resultId,
                        freshness: { expiresAtMs: TEST_EXPIRES_AT_MS },
                    },
                );
            case 'unavailable':
                return v.parse(legacyStructuredUnavailableResponseSchema, {
                    status: 'unavailable',
                    videoId: input.videoId,
                    algorithmVersion: input.algorithmVersion,
                    error: { code: 'caption_extraction_failed' },
                });
            case 'error':
                return v.parse(legacyStructuredTerminalErrorResponseSchema, {
                    status: 'error',
                    videoId: input.videoId,
                    algorithmVersion: input.algorithmVersion,
                    error: {
                        code: 'fixture_error',
                    },
                });
        }
    }

    /**
     * Builds a minimal transcript artifact for successful analysis fixture data.
     *
     * @param input - Video identity.
     * @param acquiredAtMs - Transcript acquisition timestamp.
     * @returns Valid transcript artifact.
     */
    private static buildTranscriptArtifactForTests(
        input: BuildRecordForTestsInput,
        acquiredAtMs: number,
    ): TranscriptArtifact {
        return v.parse(transcriptArtifactSchema, {
            artifactId: `transcript-${randomUUID()}`,
            videoId: input.videoId,
            algorithmVersion: input.algorithmVersion,
            strategy: 'local_transcript_fixture',
            sourceType: 'local_fixture',
            languageCode: 'en',
            acquiredAtMs,
            segments: [
                {
                    startSec: 4,
                    durationSec: 20,
                    text: TEST_TRANSCRIPT_TEXT,
                },
            ],
            transcriptText: TEST_TRANSCRIPT_TEXT,
        });
    }

    /**
     * Builds a minimal worker run artifact that matches the terminal analysis result.
     *
     * @param input - Video identity.
     * @param transcriptArtifact - Transcript linked by the run artifact.
     * @param completedAtMs - Run completion timestamp.
     * @returns Valid analysis run artifact.
     */
    private static buildAnalysisRunForTests(
        input: BuildRecordForTestsInput,
        transcriptArtifact: TranscriptArtifact,
        completedAtMs: number,
    ): AnalysisRunArtifact {
        const hasPromo = input.terminalStatus === 'ready';
        return v.parse(analysisRunArtifactSchema, {
            runId: `analysis-${randomUUID()}`,
            transcriptArtifactId: transcriptArtifact.artifactId,
            videoId: input.videoId,
            algorithmVersion: input.algorithmVersion,
            provider: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture,
            startedAtMs: completedAtMs,
            completedAtMs,
            rawModelResponse: hasPromo
                ? TEST_RAW_MODEL_RESPONSE
                : TEST_RAW_NO_PROMO_MODEL_RESPONSE,
            parsedResult: hasPromo
                ? {
                      hasPromo: true,
                      promoBlocks: [
                          {
                              startSec: 4,
                              endSec: 24,
                              confidence: 'high',
                          },
                      ],
                  }
                : { hasPromo: false },
            normalizedPromoBlocks: hasPromo
                ? [{ startSec: 4, endSec: 24, confidence: 'high' }]
                : [],
            failureReason: null,
        });
    }

    /**
     * Builds a successful extraction attempt for fixture records.
     *
     * @returns Valid extraction attempt.
     */
    private static buildExtractionAttemptForTests(): SubtitleExtractionAttempt {
        return v.parse(subtitleExtractionAttemptSchema, {
            strategy: 'local_transcript_fixture',
            status: 'succeeded',
            startedAtMs: TEST_CREATED_AT_MS,
            completedAtMs: TEST_CREATED_AT_MS,
            diagnostics: { code: 'fixture_selected' },
        });
    }

    /**
     * Applies partial metadata overrides while keeping all required fields present.
     *
     * @param input - Test input with optional metadata override.
     * @param completedAtMs - Completion timestamp.
     * @returns Complete operational metadata.
     */
    private static mergeOperationalMetadata(
        input: BuildRecordForTestsInput,
        completedAtMs: number,
    ): AnalysisOperationalMetadata {
        return v.parse(analysisOperationalMetadataSchema, {
            promptVersion:
                input.operationalMetadata?.promptVersion ?? 'local_fixture',
            modelVersion:
                input.operationalMetadata?.modelVersion ?? 'local_fixture',
            timing: {
                queuedAtMs:
                    input.operationalMetadata?.timing?.queuedAtMs ??
                    TEST_CREATED_AT_MS,
                startedAtMs:
                    input.operationalMetadata?.timing?.startedAtMs ??
                    TEST_CREATED_AT_MS,
                completedAtMs:
                    input.operationalMetadata?.timing?.completedAtMs ??
                    completedAtMs,
                totalLatencyMs:
                    input.operationalMetadata?.timing?.totalLatencyMs ??
                    completedAtMs - TEST_CREATED_AT_MS,
            },
            cost: {
                estimatedUsd:
                    input.operationalMetadata?.cost?.estimatedUsd ?? null,
                inputTokens:
                    input.operationalMetadata?.cost?.inputTokens ?? null,
                outputTokens:
                    input.operationalMetadata?.cost?.outputTokens ?? null,
            },
            diagnostics: {
                artifactSource: 'test_fixture',
                ...input.operationalMetadata?.diagnostics,
            },
        });
    }
}
