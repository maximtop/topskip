import * as v from 'valibot';

import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    type BackendAnalysisFailureReason,
    type ParsedModelPromoResult,
} from '@/backend/analysis/promo-analysis-types';
import { llmPromoDetectionSchema } from '@/shared/openrouter-llm-schema';

const FENCED_JSON_PREFIX_PATTERN = /^```(?:json)?\s*/iu;
const FENCED_JSON_SUFFIX_PATTERN = /\s*```$/u;

/**
 * Result of validating an untrusted backend model response.
 */
export type BackendPromoResponseParseResult =
    | { ok: true; parsedResult: ParsedModelPromoResult }
    | { ok: false; failureReason: BackendAnalysisFailureReason };

/**
 * Parses raw model JSON without trusting provider output shape.
 *
 * @param raw - Raw adapter output to parse and validate.
 * @returns Parsed promo result or a stable model-response failure.
 */
export function parseBackendPromoResponse(
    raw: string,
): BackendPromoResponseParseResult {
    const jsonText = raw
        .trim()
        .replace(FENCED_JSON_PREFIX_PATTERN, '')
        .replace(FENCED_JSON_SUFFIX_PATTERN, '')
        .trim();

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(jsonText) as unknown;
    } catch {
        return {
            ok: false,
            failureReason: BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
        };
    }

    const parsed = v.safeParse(llmPromoDetectionSchema, parsedJson);
    if (!parsed.success) {
        return {
            ok: false,
            failureReason: BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
        };
    }

    return { ok: true, parsedResult: parsed.output };
}
