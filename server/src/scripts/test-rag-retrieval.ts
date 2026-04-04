/**
 * Quick RAG retrieval test
 * Usage: npx tsx src/scripts/test-rag-retrieval.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { embedText, toPgVector } from '../services/embeddings';

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });
const GEMINI_KEY = 'AIzaSyALKcuRMG08bVuFaqcc5Kas3ZTubuB-DzE';

async function main() {
  const questions = [
    'có bao nhiêu điểm cháy hôm nay',
    'tổng diện tích cây keo',
    'camera nào phát hiện cháy nhiều nhất',
  ];

  for (const q of questions) {
    console.log(`\n[Q] ${q}`);
    const embedding = await embedText(q, GEMINI_KEY);
    const vec = toPgVector(embedding);

    const result = await pool.query(
      `SELECT id, question_vi, LEFT(sql, 80) as sql_preview,
              ROUND((1 - (embedding <=> $1::vector))::numeric, 4) as similarity
       FROM vanna_training_data
       WHERE (1 - (embedding <=> $1::vector)) >= 0.5
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [vec]
    );

    for (const row of result.rows as Array<{ question_vi: string; sql_preview: string; similarity: number }>) {
      console.log(`  → [${row.similarity}] "${row.question_vi}"`);
      console.log(`    SQL: ${row.sql_preview}`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
