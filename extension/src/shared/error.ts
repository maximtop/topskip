import { isValiError } from 'valibot';

import { extractMessageFromValiError } from '@/shared/valibot';

/**
 * Converts a thrown value to a string message.
 * If `error` is a {@link ValiError}, uses {@link extractMessageFromValiError}.
 *
 * @param error Thrown value (typically from `catch`).
 * @returns Message suitable for logging or API error fields.
 */
export function getErrorMessage(error: unknown): string {
  if (isValiError(error)) {
    return extractMessageFromValiError(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
