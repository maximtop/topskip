import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { LogPromoAnalysis } from '@/background/openrouter/log-promo-analysis';
import { callOpenRouterChat } from
  '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
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

const LLM_SYSTEM_PROMPT = [
  'You analyze YouTube closed-caption transcripts to find sponsor or',
  'promotional segments. Reply with JSON only, no prose, matching this shape:',
  '{"hasPromo": boolean}. If hasPromo is true, include "promoBlocks":',
  '[{ "startSec": number, "endSec"?: number,',
  '"confidence"?: "low"|"medium"|"high" }]',
  'with at least one block. Times are seconds from the start of the video.',
].join(' ');

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

      setStatus({ videoId, status: 'analyzing' });
      const merged = mergeCaptionSegmentsToTranscript(
        segments,
        MAX_CAPTION_TRANSCRIPT_CHARS,
      );
      if (merged.truncated) {
        LogPromoAnalysis.logTranscriptTruncated(videoId, segments.length);
      }

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
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });

      if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
        return;
      }

      if (!llm.ok) {
        console.error('[TopSkip] OpenRouter error', llm.error);
        setStatus({
          videoId,
          status: 'error',
          error: llm.error,
        });
        return;
      }

      LogPromoAnalysis.logRawAssistant(
        videoId,
        orConfig.model,
        segments.length,
        llm.rawContent,
      );

      const parsed = parseLlmPromoResponse(llm.rawContent, undefined);
      if (!parsed.ok) {
        console.error('[TopSkip] LLM parse error', parsed.error);
        LogPromoAnalysis.logValidatedResult(videoId, {
          ok: false,
          error: parsed.error,
        });
        setStatus({
          videoId,
          status: 'error',
          error: parsed.error,
        });
        return;
      }

      if (!parsed.hasPromo) {
        LogPromoAnalysis.logValidatedResult(videoId, {
          ok: true,
          hasPromo: false,
        });
        setStatus({ videoId, status: 'no_promo' });
        return;
      }

      const blocks = parsed.blocks;
      LogPromoAnalysis.logValidatedResult(videoId, {
        ok: true,
        hasPromo: true,
        promoBlocks: blocks,
      });
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
