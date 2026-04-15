import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import {
  logTranscriptForDeveloper,
} from '@/background/captions/log-transcript-dev';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import type { CaptionSegment } from '@/shared/caption-types';
import {
  TOPSKIP_MESSAGE,
  type CaptionsFromContentAck,
  type CaptionsFromContentPayload,
} from '@/shared/messages';

/**
 * @param value Unknown message field.
 * @returns Whether `value` looks like a caption segment.
 */
function isCaptionSegment(value: unknown): value is CaptionSegment {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    typeof o.startSec === 'number' &&
    typeof o.durationSec === 'number' &&
    typeof o.text === 'string'
  );
}

/**
 * @param raw Unknown `payload` from a captions message.
 * @returns Parsed payload or `null` if invalid.
 */
function parseCaptionsFromContentPayload(
  raw: unknown,
): CaptionsFromContentPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const videoIdRaw: unknown = Reflect.get(raw, 'videoId');
  if (typeof videoIdRaw !== 'string' || videoIdRaw.length === 0) {
    return null;
  }
  const videoId = videoIdRaw;
  const okField: unknown = Reflect.get(raw, 'ok');
  if (okField === false) {
    const errRaw: unknown = Reflect.get(raw, 'error');
    if (typeof errRaw !== 'string') {
      return null;
    }
    return { ok: false, videoId, error: errRaw };
  }
  if (okField !== true) {
    return null;
  }
  const languageCodeRaw: unknown = Reflect.get(raw, 'languageCode');
  const segmentsRaw: unknown = Reflect.get(raw, 'segments');
  if (typeof languageCodeRaw !== 'string') {
    return null;
  }
  if (!Array.isArray(segmentsRaw)) {
    return null;
  }
  const segments: CaptionSegment[] = [];
  for (const item of segmentsRaw) {
    if (!isCaptionSegment(item)) {
      return null;
    }
    segments.push(item);
  }
  return {
    ok: true,
    videoId,
    languageCode: languageCodeRaw,
    segments,
  };
}

/**
 * Namespace for caption payloads forwarded from the watch content script;
 * not instantiable.
 */
export class CaptionRuntimeMessages {
  private constructor() {}

  /**
   * Handles `TOPSKIP_CAPTIONS_FROM_CONTENT` from the watch content script.
   *
   * @param message Opaque runtime message.
   * @param sender Message sender (tab id required for promo analysis).
   * @returns Ack promise, or `undefined` when ignored.
   */
  static handleCaptionsFromContent(
    message: unknown,
    sender: Runtime.MessageSender,
  ): Promise<CaptionsFromContentAck> | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeRaw !== TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT) {
      return undefined;
    }
    const payloadRaw: unknown = Reflect.get(message, 'payload');
    const payload = parseCaptionsFromContentPayload(payloadRaw);
    if (!payload) {
      return Promise.resolve({
        ok: false,
        error: 'Invalid captions payload',
      });
    }
    if (!payload.ok) {
      console.error('[TopSkip captions]', payload.error);
      return Promise.resolve({ ok: true });
    }
    void logTranscriptForDeveloper(
      payload.videoId,
      payload.languageCode,
      payload.segments,
    );
    PromoAnalysis.onCaptionsReady(sender, payload);
    return Promise.resolve({ ok: true });
  }
}
