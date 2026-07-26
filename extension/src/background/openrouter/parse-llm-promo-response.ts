import { parse, ValiError } from 'valibot';

import { extractMessageFromValiError } from '@/shared/valibot';
import { llmPromoDetectionSchema } from '@topskip/common/openrouter-llm-schema';
import type { PromoBlock } from '@topskip/common/promo-types';
import { sortAndDedupePromoBlocks } from '@topskip/common/promo-dedupe';

/**
 * Strips optional markdown code fences from model output.
 *
 * @param raw - Assistant message string
 * @returns Inner JSON text
 */
function stripMarkdownFences(raw: string): string {
    let s = raw.trim();
    if (s.startsWith('```')) {
        const firstNl = s.indexOf('\n');
        if (firstNl !== -1) {
            s = s.slice(firstNl + 1);
        }
        const fence = s.lastIndexOf('```');
        if (fence !== -1) {
            s = s.slice(0, fence);
        }
    }
    return s.trim();
}

/**
 * Validates numeric constraints on blocks (FR-012) and sorts/dedupes.
 *
 * @param blocks - Blocks from parsed JSON
 * @param durationSec - Video duration when known
 * @returns Validated blocks or error message
 */
export function refinePromoBlocks(
    blocks: PromoBlock[],
    durationSec: number | undefined,
): { ok: true; blocks: PromoBlock[] } | { ok: false; error: string } {
    const refined: PromoBlock[] = [];
    for (const b of blocks) {
        if (!Number.isFinite(b.startSec) || b.startSec < 0) {
            return { ok: false, error: 'Invalid startSec in promoBlocks' };
        }
        if (b.endSec !== undefined) {
            if (!Number.isFinite(b.endSec) || b.endSec <= b.startSec) {
                return { ok: false, error: 'Invalid endSec in promoBlocks' };
            }
        }
        let block: PromoBlock = { ...b };
        if (durationSec !== undefined && Number.isFinite(durationSec)) {
            if (block.startSec >= durationSec) {
                continue;
            }
            if (block.endSec !== undefined && block.endSec > durationSec) {
                block = { ...block, endSec: durationSec };
            }
        }
        refined.push(block);
    }
    return { ok: true, blocks: sortAndDedupePromoBlocks(refined) };
}

/**
 * Parses assistant JSON into validated promo state.
 *
 * @param assistantRaw - Raw assistant message
 * @param durationSec - Optional known duration for clamping
 * @returns Parsed result or error string
 */
export function parseLlmPromoResponse(
    assistantRaw: string,
    durationSec: number | undefined,
):
    | { ok: true; hasPromo: false }
    | { ok: true; hasPromo: true; blocks: PromoBlock[] }
    | { ok: false; error: string } {
    let jsonText: string;
    try {
        jsonText = stripMarkdownFences(assistantRaw);
    } catch {
        return { ok: false, error: 'Could not strip assistant fences' };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText) as unknown;
    } catch {
        return { ok: false, error: 'Assistant output was not JSON' };
    }
    let detection;
    try {
        detection = parse(llmPromoDetectionSchema, parsed);
    } catch (e) {
        if (e instanceof ValiError) {
            return { ok: false, error: extractMessageFromValiError(e) };
        }
        return { ok: false, error: 'LLM JSON failed validation' };
    }
    if (!detection.hasPromo) {
        return { ok: true, hasPromo: false };
    }
    const refined = refinePromoBlocks(detection.promoBlocks, durationSec);
    if (!refined.ok) {
        return { ok: false, error: refined.error };
    }
    return { ok: true, hasPromo: true, blocks: refined.blocks };
}
