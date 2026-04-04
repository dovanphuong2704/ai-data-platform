/**
 * vanna-rag.ts — Vector-based RAG for VI→SQL training examples
 *
 * Architecture:
 *   upsertTrainingData()  → embed VI question → store in pgvector
 *   getSimilarSQL()        → embed user question → cosine similarity search → top-K examples
 *   generateTrainingExamples() → call LLM to auto-generate VI→SQL pairs from schema
 */

import { appPool } from './db';
import { embedText, toPgVector } from './embeddings';
import { chatWithModel } from './ai';

const RAG_EMBEDDING_DIM = 3072;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrainingExample {
  id: number;
  question_vi: string;
  sql: string;
  similarity: number;
}

export interface GeneratedExample {
  question_vi: string;
  sql: string;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Store a single VI→SQL training pair with its embedding vector.
 */
export async function upsertTrainingData(
  connectionId: number,
  question: string,
  sql: string,
  apiKey: string,
  source = 'manual',
): Promise<number> {
  const embedding = await embedText(question, apiKey);
  const vec = toPgVector(embedding);

  const result = await appPool.query(
    `INSERT INTO vanna_training_data (connection_id, question_vi, sql, embedding, source)
     VALUES ($1, $2, $3, $4::vector, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [connectionId, question.trim(), sql.trim(), vec, source],
  );

  return result.rows.length > 0 ? (result.rows[0] as { id: number }).id : -1;
}

/**
 * Bulk upsert multiple training pairs at once (more efficient).
 */
export async function upsertTrainingDataBulk(
  connectionId: number,
  examples: GeneratedExample[],
  apiKey: string,
  source = 'auto',
): Promise<{ inserted: number; errors: number }> {
  if (!examples.length) return { inserted: 0, errors: 0 };

  let inserted = 0;
  let errors = 0;

  // Embed all questions in batch
  const questions = examples.map(e => e.question_vi);
  const { embedTexts } = await import('./embeddings');
  const embeddings = await embedTexts(questions, apiKey);

  for (let i = 0; i < examples.length; i++) {
    const { question_vi, sql } = examples[i];
    const vec = toPgVector(embeddings[i]);

    try {
      await appPool.query(
        `INSERT INTO vanna_training_data (connection_id, question_vi, sql, embedding, source)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT DO NOTHING`,
        [connectionId, question_vi.trim(), sql.trim(), vec, source],
      );
      inserted++;
    } catch (err) {
      console.error('[vanna-rag] upsert error:', question_vi.slice(0, 40), err);
      errors++;
    }
  }

  return { inserted, errors };
}

// ─── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Find top-K semantically similar VI→SQL examples to a user question.
 * Uses pgvector cosine similarity search.
 *
 * @param userQuestion   - Vietnamese question from the user
 * @param connectionId  - DB connection ID to scope results (use 0 or null for global)
 * @param topK          - Max examples to return (default 5)
 * @param apiKey        - Gemini API key for embedding
 * @param threshold     - Min cosine similarity (0.0–1.0, default 0.65)
 */
export async function getSimilarSQL(
  userQuestion: string,
  connectionId: number,
  apiKey: string,
  topK = 5,
  threshold = 0.65,
): Promise<TrainingExample[]> {
  try {
    const embedding = await embedText(userQuestion, apiKey);
    const vec = toPgVector(embedding);

    // Use the SQL function for efficient ANN search
    const result = await appPool.query(
      `SELECT id, question_vi, sql,
              (1 - (embedding <=> $1::vector))::float AS similarity
       FROM vanna_training_data
       WHERE embedding IS NOT NULL
         AND ($2 = 0 OR connection_id = $2 OR connection_id IS NULL)
         AND (1 - (embedding <=> $1::vector)) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vec, connectionId, threshold, topK],
    );

    return result.rows as TrainingExample[];
  } catch (err) {
    console.error('[vanna-rag] getSimilarSQL error:', err);
    return [];
  }
}

// ─── Query helpers ─────────────────────────────────────────────────────────────

/** Count total training examples for a connection */
export async function countTrainingData(connectionId?: number): Promise<number> {
  const result = await appPool.query(
    connectionId && connectionId > 0
      ? `SELECT COUNT(*) FROM vanna_training_data WHERE connection_id = $1`
      : `SELECT COUNT(*) FROM vanna_training_data`,
    connectionId && connectionId > 0 ? [connectionId] : [],
  );
  return parseInt((result.rows[0] as { count: string }).count, 10);
}

/** List all training examples for a connection */
export async function listTrainingData(connectionId: number): Promise<TrainingExample[]> {
  const result = await appPool.query(
    `SELECT id, question_vi, sql, 1.0 AS similarity
     FROM vanna_training_data
     WHERE connection_id = $1 OR connection_id IS NULL
     ORDER BY created_at DESC`,
    [connectionId],
  );
  return result.rows as TrainingExample[];
}

/** Delete a training example by ID */
export async function deleteTrainingData(id: number): Promise<boolean> {
  const result = await appPool.query(
    `DELETE FROM vanna_training_data WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

// ─── Auto-generate VI→SQL examples ───────────────────────────────────────────

/**
 * Generate VI→SQL training examples automatically using an LLM.
 * Sends the database schema + instruction prompt → receives JSON array of examples.
 */
export async function generateTrainingExamples(
  schemaDescription: string,
  provider: string,
  apiKey: string,
  modelName: string,
  count = 20,
): Promise<GeneratedExample[]> {
  const systemPrompt = `Bạn là chuyên gia SQL PostgreSQL. Nhiệm vụ: sinh ra các cặp câu hỏi tiếng Việt → câu SQL tương ứng dựa trên schema cho sẵn.

QUY TẮC:
- Mỗi câu hỏi phải dùng đúng tên schema/table/column có trong schema
- SQL phải là SELECT, không INSERT/UPDATE/DELETE
- Đa dạng loại câu hỏi: COUNT, SUM, AVG, GROUP BY, JOIN, ORDER BY, LIMIT, date filter, comparison
- Các chủ đề: điểm cháy (fire), camera, diện tích cây lâm nghiệp (plot), chatbot, thời tiết (weather), vệ tinh (satellite)
- Trả về JSON array (không markdown, không giải thích):

[{"question_vi":"câu hỏi tiếng Việt","sql":"SELECT ..."}]`;

  const userPrompt = `Schema database:\n${schemaDescription}\n\nHãy sinh ${count} cặp câu hỏi tiếng Việt → SQL đa dạng, mỗi cặp phải dùng đúng tên bảng và cột có trong schema trên.`;

  try {
    const response = await chatWithModel({
      provider,
      apiKey,
      model: modelName || undefined,
      systemMessage: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.3,
      maxTokens: 8192,
    });

    const cleaned = response.content
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    let parsed: GeneratedExample[] = [];

    // Try direct parse first
    try {
      parsed = JSON.parse(cleaned) as GeneratedExample[];
    } catch {
      // Try to extract JSON array from incomplete/truncated response
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          parsed = JSON.parse(arrayMatch[0]) as GeneratedExample[];
        } catch {
          // Try line-by-line extraction
          const lines = cleaned.split('\n');
          for (const line of lines) {
            try {
              const item = JSON.parse(line.trim());
              if (item.question_vi && item.sql) parsed.push(item);
            } catch { /* skip */ }
          }
        }
      }
    }

    // Filter out malformed entries
    return parsed.filter(e =>
      e.question_vi && e.sql && typeof e.sql === 'string' && e.sql.toUpperCase().includes('SELECT')
    );
  } catch (err) {
    console.error('[vanna-rag] generateTrainingExamples error:', err);
    return [];
  }
}

// ─── Build RAG context string for system prompt ────────────────────────────────

/**
 * Convert retrieved examples into a string block to append to the system prompt.
 */
export function buildRagContext(examples: TrainingExample[]): string {
  if (!examples.length) return '';
  const lines = examples.map(e =>
    `- Câu hỏi: "${e.question_vi}"\n  SQL: ${e.sql}`
  );
  return `\n\n=== CAC VI DU THUC TE (tu database):\n${lines.join('\n')}\n`;
}
