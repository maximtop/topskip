import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';

/**
 * Event names are bare tokens on a formatted line; the prefix (timestamp,
 * worker#seq, source, ids) never contains them, so the first match is the
 * event of that line.
 */
const EVENT_TOKEN = new RegExp(
    `(?:^| )(${Object.values(DEBUG_LOG_EVENT).join('|')})(?: |$)`,
    'u',
);

/**
 * Extracts the event name of each formatted debug-log line so order can be
 * asserted without depending on the exact prefix layout.
 *
 * @param lines - Formatted debug-log lines.
 * @returns Event name per line (`unknown` when none matched).
 */
export function eventNamesOf(lines: readonly string[]): string[] {
    return lines.map((line) => EVENT_TOKEN.exec(line)?.[1] ?? 'unknown');
}
