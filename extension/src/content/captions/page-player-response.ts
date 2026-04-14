/**
 * Reads `ytInitialPlayerResponse` from the watch HTML **without executing**
 * scripts. YouTube's CSP blocks extension-injected inline scripts; scanning
 * `<script>` text avoids that.
 */

/**
 * Extracts a balanced `{ ... }` substring starting at `openBraceIndex`, with
 * string/escape awareness so braces inside JSON strings do not break depth.
 *
 * @param text Full script source.
 * @param openBraceIndex Index of the opening `{`.
 * @returns Slice of `text` or `null` if not closed.
 */
function extractBalancedJsonObject(
  text: string,
  openBraceIndex: number,
): string | null {
  if (text[openBraceIndex] !== '{') {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  const start = openBraceIndex;
  for (let i = openBraceIndex; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Finds `ytInitialPlayerResponse` assignment/object in script tags and parses
 * JSON (no `eval`, no injected `<script>`).
 *
 * @returns Parsed player JSON, or `null`.
 */
function parseYtInitialPlayerResponseFromDom(): unknown {
  if (typeof document === 'undefined') {
    return null;
  }
  const scripts = document.querySelectorAll('script');
  for (const el of scripts) {
    const text = el.textContent ?? '';
    const marker = /ytInitialPlayerResponse\s*[:=]\s*/.exec(text);
    if (!marker) {
      continue;
    }
    const afterKey = text.slice(marker.index + marker[0].length);
    if (/^null\b/.test(afterKey.trimStart())) {
      continue;
    }
    const braceRel = afterKey.search(/\{/);
    if (braceRel === -1) {
      continue;
    }
    const absOpen = marker.index + marker[0].length + braceRel;
    const jsonStr = extractBalancedJsonObject(text, absOpen);
    if (!jsonStr) {
      continue;
    }
    try {
      return JSON.parse(jsonStr) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolves with embedded player JSON from the document, or `null`.
 *
 * @returns Promise for compatibility with async fetch orchestration.
 */
export function readYtInitialPlayerResponseFromPage(): Promise<unknown> {
  return Promise.resolve(parseYtInitialPlayerResponseFromDom());
}

const INNERTUBE_API_KEY_RE = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/;

const INNERTUBE_CLIENT_VERSION_RE =
  /"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/;

/**
 * Reads InnerTube API key from inline `<script>` sources (same pattern as the
 * legacy watch-page fetch path).
 *
 * @returns API key or `null`.
 */
export function readInnertubeApiKeyFromPage(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const scripts = document.querySelectorAll('script');
  for (const el of scripts) {
    const m = INNERTUBE_API_KEY_RE.exec(el.textContent ?? '');
    if (m?.[1]) {
      return m[1];
    }
  }
  return null;
}

/**
 * Reads WEB client version embedded in page scripts (must align with
 * `youtubei/v1/get_transcript` expectations).
 *
 * @returns Semver-like client version or `null`.
 */
export function readInnertubeClientVersionFromPage(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const scripts = document.querySelectorAll('script');
  for (const el of scripts) {
    const m = INNERTUBE_CLIENT_VERSION_RE.exec(el.textContent ?? '');
    if (m?.[1]) {
      return m[1];
    }
  }
  return null;
}
