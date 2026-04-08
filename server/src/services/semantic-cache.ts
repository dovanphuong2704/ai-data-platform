// semantic-cache.ts — SQL result caching via semantic similarity
//
// Stores (question_embedding → SQL + result_preview) in app DB.
// Uses 768-dim vectors to stay within pgvector IVFFlat index limits.
// Truncates 3072-dim Gemini embeddings to 768 before storing/querying.

import { appPool } from './db';
import { toPgVector } from './embeddings';

export interface SemanticCacheEntry {
  id: number;
  question_text: string;
  sql_query: string;
  result_preview: { columns: string[]; rows: Record<string, unknown>[] } | null;
  row_count: number | null;
  similarity: number;
  created_at: Date;
}

export interface SemanticCacheResult {
  hit: boolean;    // similarity ≥ HIT_THRESHOLD → return cached result
  partial: boolean; // HIT_THRESHOLD > similarity ≥ PARTIAL_THRESHOLD → re-execute cached SQL
  miss: boolean;
  entry: SemanticCacheEntry | null;
}

// ─── Config ────────────────────────────────────────────────────────────────────

const HIT_THRESHOLD = parseFloat(process.env.SEMANTIC_CACHE_HIT_THRESHOLD ?? '0.92');
const PARTIAL_THRESHOLD = parseFloat(process.env.SEMANTIC_CACHE_PARTIAL_THRESHOLD ?? '0.80');
const CACHE_TTL_HOURS = parseInt(process.env.SEMANTIC_CACHE_TTL_HOURS ?? '24');
const MAX_PREVIEW_ROWS = 10;

/**
 * Truncate 3072-dim Gemini embedding to 768 dims for pgvector index.
 * Uses first 768 dimensions — standard practice for Gemini embedding models.
 */
function truncateTo768(vec: number[]): number[] {
  // If already 768 or smaller, return as-is
  if (vec.length <= 768) {
    return vec;
  }
  // Truncate to 768 dims
  return vec.slice(0, 768);
}

// ─── Check Cache ────────────────────────────────────────────────────────────

export async function checkSemanticCache(
  question: string,
  questionEmbedding: number[],
  connectionId: number,
  userId: number,
): Promise<SemanticCacheResult> {
  const vec768 = truncateTo768(questionEmbedding);
  const vec = toPgVector(vec768);

  try {
    const result = await appPool.query<SemanticCacheEntry & { similarity: number }>(
      `SELECT id, question_text, sql_query, result_preview, row_count,
              (1 - (question_embedding <=> $2::vector))::float AS similarity,
              created_at
       FROM sql_semantic_cache
       WHERE connection_id = $1
         AND user_id = $3
         AND question_embedding IS NOT NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY question_embedding <=> $2::vector
       LIMIT 1`,
      [connectionId, vec, userId],
    );

    if (result.rows.length === 0) {
      return { hit: false, partial: false, miss: true, entry: null };
    }

    const entry = result.rows[0];

    // Update last_used_at + hit_count (fire-and-forget)
    appPool.query(
      'UPDATE sql_semantic_cache SET last_used_at = NOW(), hit_count = hit_count + 1 WHERE id = $1',
      [entry.id],
    ).catch(() => { /* non-critical */ });

    if (entry.similarity >= HIT_THRESHOLD) {
      return { hit: true, partial: false, miss: false, entry };
    }

    if (entry.similarity >= PARTIAL_THRESHOLD) {
      return { hit: false, partial: true, miss: false, entry };
    }

    return { hit: false, partial: false, miss: true, entry: null };
  } catch (err) {
    console.warn('[semantic-cache] check failed:', err);
    return { hit: false, partial: false, miss: true, entry: null };
  }
}

// ─── Save to Cache ──────────────────────────────────────────────────────────

export async function saveSemanticCache(
  connectionId: number,
  userId: number,
  questionText: string,
  questionEmbedding: number[],
  sqlQuery: string,
  result: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number } | null,
): Promise<void> {
  // Don't cache empty results, errors, or very large result sets
  if (!result || result.rowCount === 0 || result.rowCount > 1000) {
    return;
  }

  const vec768 = truncateTo768(questionEmbedding);
  const vec = toPgVector(vec768);
  const preview = { columns: result!.columns, rows: result!.rows.slice(0, MAX_PREVIEW_ROWS) };

  try {
    await appPool.query(
      `INSERT INTO sql_semantic_cache
         (connection_id, user_id, question_embedding, question_text, sql_query,
          result_preview, row_count, expires_at)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7, NOW() + $8 * INTERVAL '1 hour')
       ON CONFLICT (connection_id, question_text) DO UPDATE SET
         sql_query = EXCLUDED.sql_query,
         result_preview = EXCLUDED.result_preview,
         row_count = EXCLUDED.row_count,
         last_used_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      [
        connectionId,
        userId,
        vec,
        questionText,
        sqlQuery,
        JSON.stringify(preview),
        result.rowCount,
        CACHE_TTL_HOURS,
      ],
    );
  } catch (err) {
    console.warn('[semantic-cache] save failed:', err);
  }
}

// ─── Cleanup (call via cron or manual trigger) ─────────────────────────────

export async function cleanupSemanticCache(): Promise<number> {
  const result = await appPool.query(
    `DELETE FROM sql_semantic_cache
     WHERE (expires_at IS NOT NULL AND expires_at < NOW())
        OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '7 days')
     RETURNING id`,
  );
  return result.rowCount ?? 0;
}
