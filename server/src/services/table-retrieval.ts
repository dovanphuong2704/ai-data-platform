// table-retrieval.ts — Semantic table retrieval via vector + hybrid search
//
// Hybrid: vector similarity + keyword bonus + schema name exact match
// Returns Top-K tables most relevant to the user's question.

import { appPool } from './db';
import { embedText, toPgVector } from './embeddings';

export interface TableSummary {
  table_schema: string;
  table_name: string;
  summary_text: string;
  column_list: string;
  fk_hint: string;
  similarity?: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[_\-\.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function scoreKeywordMatch(tableTokens: string[], queryTokens: string[]): number {
  let score = 0;
  for (const qt of queryTokens) {
    if (tableTokens.includes(qt)) { score += 10; continue; }
    for (const t of tableTokens) {
      if (t.startsWith(qt) || qt.startsWith(t)) { score += 5; break; }
    }
  }
  return score;
}

/**
 * Retrieve Top-K relevant tables using hybrid search:
 * 1. Vector similarity (Gemini embedding)
 * 2. BM25 keyword score (bonus)
 * 3. Exact schema/table name match (bonus)
 */
export async function retrieveTopTables(
  question: string,
  connectionId: number,
  apiKey: string,
  topK = 5,
  vectorThreshold = 0.3,
): Promise<TableSummary[]> {
  try {
    const vec = toPgVector(await embedText(question, apiKey));
    const queryTokens = tokenize(question);

    const vecResult = await appPool.query<TableSummary & { sim: number }>(
      `SELECT table_schema, table_name, summary_text, column_list, fk_hint,
              (1 - (embedding <=> $1::vector))::float AS sim
       FROM db_table_summaries
       WHERE connection_id = $2
         AND (1 - (embedding <=> $1::vector)) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vec, connectionId, vectorThreshold, topK * 3],
    );

    type VecRow = TableSummary & { sim: number };
    const scored: TableSummary[] = (vecResult.rows as VecRow[]).map(row => {
      const tableTokens = tokenize(
        `${row.table_schema} ${row.table_name} ${row.summary_text} ${row.column_list}`
      );
      const keywordScore = scoreKeywordMatch(tableTokens, queryTokens);

      const schemaBonus = queryTokens.some(q =>
        row.table_schema.toLowerCase().includes(q) || q.includes(row.table_schema.toLowerCase())
      ) ? 20 : 0;

      const nameBonus = queryTokens.some(q =>
        row.table_name.toLowerCase().includes(q) || q.includes(row.table_name.toLowerCase())
      ) ? 15 : 0;

      const combined = row.sim + (keywordScore / 50) + (schemaBonus + nameBonus) / 10;
      return { ...row, similarity: Math.min(combined, 1.0) };
    });

    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    return scored.slice(0, topK);
  } catch (err) {
    console.warn('[table-retrieval] error:', err);
    return [];
  }
}

/** Upsert a single table summary with embedding */
export async function upsertTableSummary(
  connectionId: number,
  schema: string,
  table: string,
  summaryText: string,
  columnList: string,
  fkHint: string,
  apiKey: string,
): Promise<void> {
  const vec = toPgVector(await embedText(summaryText, apiKey));
  await appPool.query(
    `INSERT INTO db_table_summaries (connection_id, table_schema, table_name, summary_text, column_list, fk_hint, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
     ON CONFLICT (connection_id, table_schema, table_name) DO UPDATE SET
       summary_text = EXCLUDED.summary_text,
       column_list = EXCLUDED.column_list,
       fk_hint     = EXCLUDED.fk_hint,
       embedding   = EXCLUDED.embedding`,
    [connectionId, schema, table, summaryText, columnList, fkHint, vec],
  );
}

/** Count summaries for a connection */
export async function countTableSummaries(connectionId: number): Promise<number> {
  const r = await appPool.query(
    `SELECT COUNT(*) FROM db_table_summaries WHERE connection_id = $1`,
    [connectionId],
  );
  return parseInt((r.rows[0] as { count: string }).count, 10);
}
