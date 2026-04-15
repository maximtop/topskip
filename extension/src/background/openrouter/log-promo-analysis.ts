import type { PromoBlock } from '@/shared/promo-types';

/**
 * Developer-facing logs for promo / OpenRouter analysis. Never logs API keys
 * or `Authorization` headers (FR-020).
 */
export class LogPromoAnalysis {
  private constructor() {}

  /**
   * @param videoId - YouTube video id
   * @param segmentCount - Caption segment count merged for the prompt
   */
  static logTranscriptTruncated(videoId: string, segmentCount: number): void {
    console.info(
      '[TopSkip] Transcript truncated before OpenRouter',
      videoId,
      segmentCount,
    );
  }

  /**
   * @param videoId - YouTube video id
   * @param model - OpenRouter model id
   * @param segmentCount - Caption segments sent
   * @param rawAssistant - Raw assistant message string (JSON or fenced)
   */
  static logRawAssistant(
    videoId: string,
    model: string,
    segmentCount: number,
    rawAssistant: string,
  ): void {
    console.info(
      '[TopSkip] LLM raw assistant',
      videoId,
      model,
      segmentCount,
      rawAssistant,
    );
  }

  /**
   * Logs the validated parse outcome (structured) for service worker debugging.
   *
   * @param videoId - YouTube video id
   * @param result - Parsed LLM promo result after Valibot + refine
   */
  static logValidatedResult(
    videoId: string,
    result:
      | { ok: true; hasPromo: false }
      | { ok: true; hasPromo: true; promoBlocks: PromoBlock[] }
      | { ok: false; error: string },
  ): void {
    if (!result.ok) {
      console.info('[TopSkip] LLM validated result', videoId, {
        ok: false,
        error: result.error,
      });
      return;
    }
    if (!result.hasPromo) {
      console.info('[TopSkip] LLM validated result', videoId, {
        ok: true,
        hasPromo: false,
      });
      return;
    }
    console.info('[TopSkip] LLM validated result', videoId, {
      ok: true,
      hasPromo: true,
      promoBlocks: result.promoBlocks,
    });
  }
}
