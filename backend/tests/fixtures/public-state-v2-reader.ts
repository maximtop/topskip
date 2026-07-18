import { DatabaseSync } from 'node:sqlite';

const LEGACY_SOURCE_TYPES = new Set([
    'local_fixture',
    'youtube_timedtext',
    'youtube_yt_dlp',
]);

export type FrozenV2ArtifactRow = {
    recordId: string;
    videoId: string;
    algorithmVersion: string;
    completedAtMs: number;
    expiresAtMs: number;
    payload: unknown;
};

/**
 * Emulates the pre-v3 reader without importing any current persistence schemas.
 */
export class FrozenPublicStateV2Reader {
    /**
     * Reads only payloads understood by the old source vocabulary.
     *
     * @param path - SQLite database migrated by the current backend.
     * @param videoId - Legacy indexed video identity.
     * @param algorithmVersion - Legacy indexed algorithm identity.
     * @returns Old-shape artifact rows that remain readable after migration.
     */
    static readArtifacts(
        path: string,
        videoId: string,
        algorithmVersion: string,
    ): FrozenV2ArtifactRow[] {
        const database = new DatabaseSync(path);
        try {
            const rows = database
                .prepare(
                    `SELECT record_id, video_id, algorithm_version,
                            completed_at_ms, expires_at_ms, payload_json
                     FROM analysis_artifacts
                     WHERE video_id = ? AND algorithm_version = ?
                     ORDER BY completed_at_ms ASC`,
                )
                .all(videoId, algorithmVersion);
            return rows.flatMap((row) => {
                const parsed = FrozenPublicStateV2Reader.parseRow(row);
                return parsed === null ? [] : [parsed];
            });
        } finally {
            database.close();
        }
    }

    /**
     * Writes through the exact six columns known before migration v3.
     *
     * @param path - SQLite database migrated by the current backend.
     * @param row - Frozen old-shape artifact row.
     */
    static writeArtifact(path: string, row: FrozenV2ArtifactRow): void {
        const database = new DatabaseSync(path);
        try {
            database
                .prepare(
                    `INSERT INTO analysis_artifacts
                        (record_id, video_id, algorithm_version, completed_at_ms,
                         expires_at_ms, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    row.recordId,
                    row.videoId,
                    row.algorithmVersion,
                    row.completedAtMs,
                    row.expiresAtMs,
                    JSON.stringify(row.payload),
                );
        } finally {
            database.close();
        }
    }

    /**
     * Parses the frozen row shape and rejects sources unknown to the old image.
     *
     * @param row - Raw SQLite row.
     * @returns Frozen row or null when v2 cannot understand its payload.
     */
    private static parseRow(row: unknown): FrozenV2ArtifactRow | null {
        if (row === null || typeof row !== 'object') {
            return null;
        }
        const recordId = FrozenPublicStateV2Reader.readString(row, 'record_id');
        const videoId = FrozenPublicStateV2Reader.readString(row, 'video_id');
        const algorithmVersion = FrozenPublicStateV2Reader.readString(
            row,
            'algorithm_version',
        );
        const completedAtMs = FrozenPublicStateV2Reader.readNumber(
            row,
            'completed_at_ms',
        );
        const expiresAtMs = FrozenPublicStateV2Reader.readNumber(
            row,
            'expires_at_ms',
        );
        const payloadJson = FrozenPublicStateV2Reader.readString(
            row,
            'payload_json',
        );
        if (
            recordId === null ||
            videoId === null ||
            algorithmVersion === null ||
            completedAtMs === null ||
            expiresAtMs === null ||
            payloadJson === null
        ) {
            return null;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(payloadJson) as unknown;
        } catch {
            return null;
        }
        if (!FrozenPublicStateV2Reader.hasLegacySource(payload)) {
            return null;
        }
        return {
            recordId,
            videoId,
            algorithmVersion,
            completedAtMs,
            expiresAtMs,
            payload,
        };
    }

    /**
     * Models the old schema's closed source union without current imports.
     *
     * @param payload - Parsed artifact JSON.
     * @returns Whether v2 recognizes the selected transcript source.
     */
    private static hasLegacySource(payload: unknown): boolean {
        if (payload === null || typeof payload !== 'object') {
            return false;
        }
        const artifact: unknown = Reflect.get(
            payload,
            'selectedTranscriptArtifact',
        );
        if (artifact === null || typeof artifact !== 'object') {
            return false;
        }
        const sourceType: unknown = Reflect.get(artifact, 'sourceType');
        return (
            typeof sourceType === 'string' &&
            LEGACY_SOURCE_TYPES.has(sourceType)
        );
    }

    /**
     * Reads a string field without coupling this fixture to runtime row types.
     *
     * @param value - Unknown row-like value.
     * @param key - Frozen SQLite column name.
     * @returns String or null.
     */
    private static readString(value: object, key: string): string | null {
        const field: unknown = Reflect.get(value, key);
        return typeof field === 'string' ? field : null;
    }

    /**
     * Reads a numeric field without coupling this fixture to runtime row types.
     *
     * @param value - Unknown row-like value.
     * @param key - Frozen SQLite column name.
     * @returns Number or null.
     */
    private static readNumber(value: object, key: string): number | null {
        const field: unknown = Reflect.get(value, key);
        return typeof field === 'number' ? field : null;
    }
}
