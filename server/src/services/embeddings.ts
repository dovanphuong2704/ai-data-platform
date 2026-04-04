/**
 * embeddings.ts — Text embedding via Gemini REST API (direct HTTP, not LangChain)
 *
 * Direct API call to avoid LangChain wrapper issues with Gemini embeddings.
 * Model: gemini-embedding-2-preview (3072 dims) via Gemini REST API v1beta.
 */

import { appPool } from './db';

const EMBEDDING_DIM = 3072; // gemini-embedding-2-preview outputs 3072-dim vectors

// Cache embedding results per text to avoid redundant API calls
const embedCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 1000;

function lruSet(key: string, value: number[]): void {
  if (embedCache.size >= MAX_CACHE_SIZE) {
    const first = embedCache.keys().next().value;
    if (first !== undefined) embedCache.delete(first);
  }
  embedCache.set(key, value);
}

/**
 * Embed a single text via Gemini REST API.
 */
export async function embedText(text: string, apiKey: string): Promise<number[]> {
  const cacheKey = `${apiKey.slice(0, 8)}:${text}`;
  if (embedCache.has(cacheKey)) return embedCache.get(cacheKey)!;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-2-preview',
          content: { parts: [{ text }] },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini embedding API ${res.status}: ${errText}`);
    }

    const json = await res.json() as {
      embedding: { values: number[] };
    };

    const vec = json.embedding?.values;
    if (!vec || vec.length === 0) throw new Error('Empty embedding returned');

    lruSet(cacheKey, vec);
    return vec;
  } catch (err) {
    clearTimeout(timeout);
    // Try older endpoint format as fallback
    try {
      const res2 = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        }
      );
      if (!res2.ok) throw new Error(`Fallback also failed: ${res2.status}`);
      const json2 = await res2.json() as { embedding?: { values?: number[] } };
      const vec2 = json2.embedding?.values ?? new Array(768).fill(0);
      lruSet(cacheKey, vec2);
      return vec2;
    } catch {
      console.error('[embeddings] Failed:', err);
      const zeros = new Array(EMBEDDING_DIM).fill(0);
      lruSet(cacheKey, zeros);
      return zeros;
    }
  }
}

/**
 * Embed multiple texts sequentially.
 */
export async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text, apiKey));
  }
  return results;
}

/** Convert a JS number[] to pg vector literal string, e.g. '[0.1,0.2,...]' */
export function toPgVector(arr: number[]): string {
  return `[${arr.join(',')}]`;
}

/** Current embedding dimension */
export const EMBEDDING_DIM_EXPORT = EMBEDDING_DIM;

/** Fetch the default API key from db for embedding service */
export async function getDefaultApiKey(): Promise<{ api_key: string } | null> {
  const result = await appPool.query(
    `SELECT api_key FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
  );
  return (result.rows[0] as { api_key: string } | undefined) ?? null;
}
