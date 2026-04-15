import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import {
  buildPromoAnalysisLogBundle,
  LogPromoAnalysis,
} from '@/background/openrouter/log-promo-analysis';
import { callOpenRouterChat } from
  '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { PromoDetectionStore } from
  '@/background/promo-detection-store';
import { mergeCaptionSegmentsToTranscript } from
  '@/shared/captions/merge-transcript';
import {
  MAX_CAPTION_TRANSCRIPT_CHARS,
} from '@/shared/constants';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type CaptionsFromContentPayload,
  type PromoDetectionStatePayload,
} from '@/shared/messages';

/**
 * Orchestrates OpenRouter analysis after captions arrive; not instantiable.
 */
export class PromoAnalysis {
  private constructor() {}

  private static readonly inflight = new Map<
    number,
    { videoId: string; abort: AbortController }
  >();

  /**
   * Runs after successful captions from the watch content script (non-blocking
   * for the ack).
   *
   * @param sender - Message sender (must include `tab.id`)
   * @param payload - Successful captions payload
   */
  static onCaptionsReady(
    sender: Runtime.MessageSender,
    payload: Extract<CaptionsFromContentPayload, { ok: true }>,
  ): void {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }
    void PromoAnalysis.run(tabId, payload);
  }

  /**
   * @param tabId - Target tab
   * @param payload - Caption payload
   * @returns Promise that settles when analysis finishes or aborts
   */
  private static async run(
    tabId: number,
    payload: Extract<CaptionsFromContentPayload, { ok: true }>,
  ): Promise<void> {
    const { videoId, languageCode, segments } = payload;

    const prev = PromoAnalysis.inflight.get(tabId);
    if (prev) {
      prev.abort.abort();
    }
    const abort = new AbortController();
    PromoAnalysis.inflight.set(tabId, { videoId, abort });

    const setStatus = (state: PromoDetectionStatePayload): void => {
      PromoDetectionStore.set(tabId, state);
    };

    try {
      await PrefsSyncStorage.ready();
      const prefs = await PrefsSyncStorage.load();
      if (!prefs.enabled) {
        setStatus({
          videoId,
          status: 'unavailable',
        });
        return;
      }

      const orConfig = await OpenRouterStorage.load();
      if (!orConfig.enabled) {
        setStatus({ videoId, status: 'unavailable' });
        return;
      }
      if (orConfig.apiKey.length === 0 || orConfig.model.length === 0) {
        setStatus({ videoId, status: 'not_configured' });
        return;
      }

      const merged = mergeCaptionSegmentsToTranscript(
        segments,
        MAX_CAPTION_TRANSCRIPT_CHARS,
      );
      if (segments.length === 0 || merged.text.trim().length === 0) {
        setStatus({ videoId, status: 'no_promo' });
        return;
      }

      setStatus({ videoId, status: 'analyzing' });

      const userContent = [
        `videoId=${videoId}`,
        `language=${languageCode}`,
        '',
        merged.text,
      ].join('\n');

      const llm = await callOpenRouterChat({
        apiKey: orConfig.apiKey,
        model: orConfig.model,
        signal: abort.signal,
        messages: [
          { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });

      if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
        return;
      }

      if (!llm.ok) {
        console.error('[TopSkip] OpenRouter error', llm.error);
        LogPromoAnalysis.logAnalysisBundle(
          buildPromoAnalysisLogBundle({
            videoId,
            languageCode,
            segmentCount: segments.length,
            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
            mergedText: merged.text,
            mergedTruncated: merged.truncated,
            model: orConfig.model,
            rawAssistant: null,
            outcome: { type: 'openrouter_error', error: llm.error },
          }),
        );
        setStatus({
          videoId,
          status: 'error',
          error: llm.error,
        });
        return;
      }

      const parsed = parseLlmPromoResponse(llm.rawContent, undefined);
      if (!parsed.ok) {
        console.error('[TopSkip] LLM parse error', parsed.error);
        LogPromoAnalysis.logAnalysisBundle(
          buildPromoAnalysisLogBundle({
            videoId,
            languageCode,
            segmentCount: segments.length,
            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
            mergedText: merged.text,
            mergedTruncated: merged.truncated,
            model: orConfig.model,
            rawAssistant: llm.rawContent,
            outcome: { type: 'parse_error', error: parsed.error },
          }),
        );
        setStatus({
          videoId,
          status: 'error',
          error: parsed.error,
        });
        return;
      }

      if (!parsed.hasPromo) {
        LogPromoAnalysis.logAnalysisBundle(
          buildPromoAnalysisLogBundle({
            videoId,
            languageCode,
            segmentCount: segments.length,
            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
            mergedText: merged.text,
            mergedTruncated: merged.truncated,
            model: orConfig.model,
            rawAssistant: llm.rawContent,
            outcome: { type: 'no_promo' },
          }),
        );
        setStatus({ videoId, status: 'no_promo' });
        return;
      }

      const blocks = parsed.blocks;
      LogPromoAnalysis.logAnalysisBundle(
        buildPromoAnalysisLogBundle({
          videoId,
          languageCode,
          segmentCount: segments.length,
          maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
          mergedText: merged.text,
          mergedTruncated: merged.truncated,
          model: orConfig.model,
          rawAssistant: llm.rawContent,
          outcome: { type: 'promo_blocks', blocks },
        }),
      );
      setStatus({
        videoId,
        status: 'detected',
        promoBlocks: blocks,
      });

      try {
        await browser.tabs.sendMessage(tabId, {
          type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
          videoId,
          promoBlocks: blocks,
        });
      } catch {
        /* tab closed or no content receiver */
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[TopSkip] Promo analysis failed', msg);
      setStatus({
        videoId,
        status: 'error',
        error: msg,
      });
    } finally {
      const cur = PromoAnalysis.inflight.get(tabId);
      if (cur?.abort === abort) {
        PromoAnalysis.inflight.delete(tabId);
      }
    }
  }
}
