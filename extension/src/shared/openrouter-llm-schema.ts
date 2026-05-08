import * as v from 'valibot';

const confidenceSchema = v.picklist(['low', 'medium', 'high'] as const);

const promoBlockSchema = v.object({
    startSec: v.number(),
    endSec: v.optional(v.number()),
    confidence: v.optional(confidenceSchema),
});

const llmHasPromoTrueSchema = v.object({
    hasPromo: v.literal(true),
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

const llmHasPromoFalseSchema = v.object({
    hasPromo: v.literal(false),
    confidence: v.optional(confidenceSchema),
});

/**
 * Valibot schema for the assistant JSON body (FR-011).
 */
export const llmPromoDetectionSchema = v.union([
    llmHasPromoTrueSchema,
    llmHasPromoFalseSchema,
]);

export type LlmPromoDetection = v.InferOutput<typeof llmPromoDetectionSchema>;
