import * as v from 'valibot';

import {
    legacyServerAnalysisRequestSchema,
    legacyServerAnalysisResponseSchema,
    type LegacyServerAnalysisRequest,
    type LegacyServerAnalysisResponse,
} from '@topskip/backend/legacy/legacy-server-analysis-contract';
import {
    BACKEND_CAPTION_SOURCE,
    type BackendCaptionSource,
} from '@topskip/backend/server-config';
import {
    serverAnalysisRequestSchema,
    serverAnalysisResponseEmissionSchema,
    type ServerAnalysisRequest,
    type ServerAnalysisResponse,
} from '@topskip/common/server-analysis-contract';

/**
 * Parsed requests remain tagged by the immutable process-selected contract.
 */
export type BackendServerAnalysisRequest =
    | ServerAnalysisRequest
    | LegacyServerAnalysisRequest;

/**
 * Strict server output may belong only to the selected public or private contract.
 */
export type BackendServerAnalysisResponse =
    | ServerAnalysisResponse
    | LegacyServerAnalysisResponse;

/**
 * Boundary parsing intentionally omits validation details from HTTP diagnostics.
 */
export type BackendServerAnalysisRequestParseResult =
    | Readonly<{ success: true; output: BackendServerAnalysisRequest }>
    | Readonly<{ success: false }>;

/**
 * One request parser and response serializer are captured for a process mode.
 */
export type BackendServerAnalysisContract = Readonly<{
    parseRequest: (raw: unknown) => BackendServerAnalysisRequestParseResult;
    serializeResponse: (raw: unknown) => BackendServerAnalysisResponse;
}>;

const PUBLIC_UPLOAD_CONTRACT: BackendServerAnalysisContract = Object.freeze({
    parseRequest: (raw: unknown): BackendServerAnalysisRequestParseResult => {
        const parsed = v.safeParse(serverAnalysisRequestSchema, raw);
        return parsed.success
            ? { success: true, output: parsed.output }
            : { success: false };
    },
    serializeResponse: (raw: unknown): BackendServerAnalysisResponse =>
        v.parse(serverAnalysisResponseEmissionSchema, raw),
});

const PRIVATE_LEGACY_CONTRACT: BackendServerAnalysisContract = Object.freeze({
    parseRequest: (raw: unknown): BackendServerAnalysisRequestParseResult => {
        const parsed = v.safeParse(legacyServerAnalysisRequestSchema, raw);
        return parsed.success
            ? { success: true, output: parsed.output }
            : { success: false };
    },
    serializeResponse: (raw: unknown): BackendServerAnalysisResponse =>
        v.parse(legacyServerAnalysisResponseSchema, raw),
});

const CONTRACT_BY_CAPTION_SOURCE: Readonly<
    Record<BackendCaptionSource, BackendServerAnalysisContract>
> = Object.freeze({
    [BACKEND_CAPTION_SOURCE.ExtensionUpload]: PUBLIC_UPLOAD_CONTRACT,
    [BACKEND_CAPTION_SOURCE.LegacyYtDlp]: PRIVATE_LEGACY_CONTRACT,
});

/**
 * Selects an inseparable parser/serializer pair from immutable startup state;
 * static API only.
 */
export class BackendServerAnalysisBoundary {
    /**
     * Resolves the exact contract without consulting mutable process environment.
     *
     * @param source - Validated process-wide caption source.
     * @returns Frozen parser and serializer for that source.
     */
    static forSource(
        source: BackendCaptionSource,
    ): BackendServerAnalysisContract {
        return CONTRACT_BY_CAPTION_SOURCE[source];
    }
}
