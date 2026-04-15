import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import {
  TOPSKIP_MESSAGE,
  type ContentLogLevel,
} from '@/shared/messages';

const LEVEL_FN: Record<
  ContentLogLevel,
  (...a: unknown[]) => void
> = {
  info: console.info,
  warn: console.warn,
  error: console.error,
};

/**
 * Handles `TOPSKIP_CONTENT_LOG` messages from the content
 * script and replays them to the service worker console.
 */
export class ContentLogMessages {
  private constructor() {}

  /**
   * If `message` is a content-log message, prints it and
   * returns `undefined` (no response needed).  Otherwise
   * returns `undefined` so the next handler in the chain
   * can try.
   *
   * @param message - Opaque runtime message.
   * @param sender - Extension message sender metadata.
   * @returns `undefined` always (fire-and-forget).
   */
  static handle(
    message: unknown,
    sender: Runtime.MessageSender,
  ): undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const type: unknown = Reflect.get(message, 'type');
    if (type !== TOPSKIP_MESSAGE.CONTENT_LOG) {
      return undefined;
    }

    const levelRaw: unknown = Reflect.get(message, 'level');
    const argsRaw: unknown = Reflect.get(message, 'args');

    const level: ContentLogLevel =
      typeof levelRaw === 'string' &&
      levelRaw in LEVEL_FN
        ? (levelRaw as ContentLogLevel)
        : 'info';

    const args: unknown[] = Array.isArray(argsRaw)
      ? argsRaw
      : [];

    const tabId = sender.tab?.id;
    const tag =
      tabId !== undefined
        ? `[TopSkip content t${tabId}]`
        : '[TopSkip content]';

    LEVEL_FN[level](tag, ...args);

    return undefined;
  }
}
