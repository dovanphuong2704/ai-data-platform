// vanna-docs.ts — Business rules documentation RAG
//
// Architecture:
//   1. Seed/admin CRUD docs
//   2. Retrieve relevant docs by semantic similarity
//   3. Append to system prompt as lightweight context

import { Pool } from 'pg';
import { appPool } from './db';
import { embedText, toPgVector } from './embeddings';

// Types
export interface VannaDoc {
  id: number;
  connection_id: number | null;
  category: string;
  title: string;
  content: string;
  similarity?: number;
}

// Add or update a single doc with its embedding
export async function upsertDoc(
  connectionId: number | null,
  category: string,
  title: string,
  content: string,
  apiKey: string,
): Promise<number> {
  const vec = toPgVector(await embedText(`${title} ${content}`, apiKey));

  const result = await appPool.query(
    `INSERT INTO vanna_docs (connection_id, category, title, content, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)
     ON CONFLICT (id) DO UPDATE SET
       category   = EXCLUDED.category,
       title     = EXCLUDED.title,
       content   = EXCLUDED.content,
       embedding = EXCLUDED.embedding,
       updated_at = NOW()
     RETURNING id`,
    [connectionId, category, title, content, vec],
  );

  return (result.rows[0] as { id: number }).id;
}

// Bulk upsert multiple docs
export async function upsertDocsBulk(
  connectionId: number | null,
  docs: Array<{ category: string; title: string; content: string }>,
  apiKey: string,
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0, errors = 0;
  for (const doc of docs) {
    try {
      await upsertDoc(connectionId, doc.category, doc.title, doc.content, apiKey);
      inserted++;
    } catch (e) {
      errors++;
      console.warn('[vanna-docs] upsert error:', doc.title, e);
    }
  }
  return { inserted, errors };
}

// Find docs semantically relevant to the user's question.
// Returns doc content strings ready to append to system prompt.
export async function getRelevantDocs(
  question: string,
  connectionId: number,
  apiKey: string,
  topK = 3,
  threshold = 0.5,
): Promise<string[]> {
  try {
    const vec = toPgVector(await embedText(question, apiKey));

    const result = await appPool.query<VannaDoc>(
      `SELECT id, title, content,
              ROUND((1 - (embedding <=> $1::vector))::numeric, 4) AS similarity
       FROM vanna_docs
       WHERE is_active = TRUE
         AND (connection_id = $2 OR connection_id IS NULL)
         AND (1 - (embedding <=> $1::vector)) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vec, connectionId, threshold, topK],
    );

    return (result.rows as VannaDoc[]).map(
      d => `[${d.category.toUpperCase()}] ${d.title}\n${d.content}`
    );
  } catch (err) {
    console.warn('[vanna-docs] retrieval error:', err);
    return [];
  }
}

export async function listDocs(connectionId?: number): Promise<VannaDoc[]> {
  const result = await appPool.query<VannaDoc>(
    connectionId
      ? `SELECT * FROM vanna_docs WHERE connection_id = $1 OR connection_id IS NULL ORDER BY category, title`
      : `SELECT * FROM vanna_docs ORDER BY category, title`,
    connectionId ? [connectionId] : [],
  );
  return result.rows;
}

export async function deleteDoc(id: number): Promise<boolean> {
  const r = await appPool.query(`DELETE FROM vanna_docs WHERE id = $1 RETURNING id`, [id]);
  return r.rowCount !== null && r.rowCount > 0;
}

// Convert retrieved docs into a string block for the system prompt
export function buildDocsContext(docs: string[]): string {
  if (!docs.length) return '';
  return `\n\n=== QUY TAC NGHIEP VU (tu database):\n${docs.join('\n\n')}\n`;
}
