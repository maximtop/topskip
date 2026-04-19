import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import {
  buildPromoAnalysisLogBundle,
  LogPromoAnalysis,
} from '@/background/openrouter/log-promo-analysis';
import { PromoDetectionStore } from
  '@/background/promo-detection-store';
import {
  mergeCaptionSegmentsToTranscript,
} from '@/shared/captions/merge-transcript';
import {
  MAX_CAPTION_TRANSCRIPT_CHARS,
} from '@/shared/constants';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type CaptionsFromContentPayload,
  type PromoDetectionStatePayload,
} from '@/shared/messages';
import { defaultRegistry } from
  '@/background/providers/default-registry';
import type { ProviderRegistry } from
  '@/background/providers/provider-registry';

/**
 * Orchestrates LLM analysis after captions arrive; not instantiable.
 */
export class PromoAnalysis {
  private constructor() {}

  private static readonly inflight = new Map<
    number,
    { videoId: string; abort: AbortController; providerId: string | null }
  >();

  private static registry: ProviderRegistry = defaultRegistry;

  /**
   * @param registry - Provider registry used for subsequent analysis runs
   */
  static setRegistry(registry: ProviderRegistry): void {
    PromoAnalysis.registry = registry;
  }

  /**
   * @param tabId - Target tab whose current analysis should be aborted
   */
  static abortForTab(tabId: number): void {
    const inflight = PromoAnalysis.inflight.get(tabId);
    if (!inflight) {
      return;
    }
    inflight.abort.abort();
    PromoAnalysis.inflight.delete(tabId);
  }

  /**
   * Aborts any in-flight work that was started under a different provider.
   *
   * @param providerId - Newly selected provider identifier
   */
  static abortForProviderChange(providerId: string): void {
    for (const [tabId, inflight] of PromoAnalysis.inflight.entries()) {
      if (
        inflight.providerId === null ||
        inflight.providerId !== providerId
      ) {
        PromoAnalysis.abortForTab(tabId);
      }
    }
  }

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

    PromoAnalysis.abortForTab(tabId);
    const abort = new AbortController();
    PromoAnalysis.inflight.set(tabId, {
      videoId,
      abort,
      providerId: null,
    });

    const setStatus = (state: PromoDetectionStatePayload): void => {
      PromoDetectionStore.set(tabId, state);
    };

    try {
      const prefs = await PrefsSyncStorage.ready()
        .then(() => PrefsSyncStorage.load());
      if (!prefs.enabled) {
        setStatus({
          videoId,
          status: 'unavailable',
        });
        return;
      }

      const providerId = prefs.providerId;
      PromoAnalysis.inflight.set(tabId, {
        videoId,
        abort,
        providerId,
      });

      const adapter = PromoAnalysis.registry.get(providerId);
      if (!adapter) {
        setStatus({ videoId, status: 'not_configured' });
        return;
      }

      const avail = await adapter.availability();
      if (avail === 'unavailable') {
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

      const result = await adapter.analyzeTranscript({
        transcript: merged.text,
        videoId,
        languageCode,
        durationSec: undefined,
        signal: abort.signal,
      });

      if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
        return;
      }

      if (!result.ok) {
        console.error('[TopSkip] LLM adapter error', result.error);
        LogPromoAnalysis.logAnalysisBundle(
          buildPromoAnalysisLogBundle({
            videoId,
            languageCode,
            segmentCount: segments.length,
            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
            mergedText: merged.text,
            mergedTruncated: merged.truncated,
            providerId,
            model: 'unknown',
            rawAssistant: null,
            outcome: { type: 'adapter_error', error: result.error },
          }),
        );
        setStatus({
          videoId,
          status: 'error',
          error: result.error,
        });
        return;
      }

      if (!result.hasPromo) {
        LogPromoAnalysis.logAnalysisBundle(
          buildPromoAnalysisLogBundle({
            videoId,
            languageCode,
            segmentCount: segments.length,
            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
            mergedText: merged.text,
            mergedTruncated: merged.truncated,
            providerId,
            model: result.providerMeta.model,
            rawAssistant: null,
            outcome: { type: 'no_promo' },
          }),
        );
        setStatus({ videoId, status: 'no_promo' });
        return;
      }

      const blocks = result.blocks;
      LogPromoAnalysis.logAnalysisBundle(
        buildPromoAnalysisLogBundle({
          videoId,
          languageCode,
          segmentCount: segments.length,
          maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
          mergedText: merged.text,
          mergedTruncated: merged.truncated,
          providerId,
          model: result.providerMeta.model,
          rawAssistant: null,
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
