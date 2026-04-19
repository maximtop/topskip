/**
 * Session-scoped cache: maps API key to models array.
 * Cleared on service worker restart (natural MV3 lifecycle).
 */
const modelCache = new Map<string, string[]>();

/**
 * Fetches the list of available OpenRouter models, with session-scoped caching.
 * Returns an empty array on any error (graceful degradation).
 *
 * @param apiKey - OpenRouter API key for authorization
 * @returns Array of model IDs (e.g., `["google/gemini-2.5-flash", ...]`)
 */
export async function fetchOpenRouterModelList(
  apiKey: string,
): Promise<string[]> {
  if (modelCache.has(apiKey)) {
    return modelCache.get(apiKey)!;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return [];
    }
    const data: unknown = await response.json();
    if (
      typeof data === 'object' &&
      data !== null &&
      'data' in data &&
      Array.isArray((data as { data: unknown }).data)
    ) {
      const models = ((data as { data: unknown[] }).data)
        .map((item) => {
          if (typeof item === 'object' && item !== null && 'id' in item) {
            return String((item as { id: unknown }).id);
          }
          return null;
        })
        .filter((id): id is string => id !== null);
      modelCache.set(apiKey, models);
      return models;
    }
  } catch {
    /* Network error or parse failure: graceful degradation */
  }

  return [];
}
