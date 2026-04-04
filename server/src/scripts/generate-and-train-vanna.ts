/**
 * generate-and-train-vanna.ts
 *
 * One-time script: auto-generate VI→SQL training examples from database schema,
 * then embed + store in pgvector via vanna-rag service.
 *
 * Usage: npx tsx src/scripts/generate-and-train-vanna.ts
 *
 * Prerequisites:
 *   1. Run migration: psql $DATABASE_URL < src/db/migrations/004_vanna-rag.sql
 *   2. Ensure pgvector extension is enabled in PostgreSQL
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL!;
const TARGET_CONNECTION_ID = parseInt(process.env.TARGET_CONNECTION_ID ?? '3', 10);
const RAG_EMBEDDING_DIM = 3072; // default: fmslaichau

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

async function main() {
  // Dynamic imports to respect tsconfig module resolution
  const { generateTrainingExamples, upsertTrainingDataBulk, countTrainingData } = await import('../services/vanna-rag');
  console.log('='.repeat(60));
  console.log('[VANNA] Auto-generate & train VI→SQL examples');
  console.log('='.repeat(60));

  const appPool = new Pool({ connectionString: DATABASE_URL, max: 2 });

  try {
    // ── 1. Verify pgvector extension ──
    console.log('\n[1/5] Checking pgvector extension...');
    try {
      const pgVec = await appPool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
      if (!pgVec.rows.length) {
        console.warn('⚠️  pgvector extension not found. Run: CREATE EXTENSION vector;');
      } else {
        console.log('  ✓ pgvector OK');
      }
    } catch {
      console.warn('⚠️  Could not verify pgvector');
    }

    // ── 2. Get target connection ──
    console.log(`\n[2/5] Fetching connection #${TARGET_CONNECTION_ID}...`);
    const connRow = await appPool.query(
      `SELECT id, db_host, db_port, db_name, db_user, db_password, user_id FROM db_connections WHERE id = $1`,
      [TARGET_CONNECTION_ID]
    );
    if (!connRow.rows.length) {
      console.error(`❌ Connection #${TARGET_CONNECTION_ID} not found`);
      process.exit(1);
    }
    const conn = connRow.rows[0] as {
      id: number; db_host: string; db_port: string;
      db_name: string; db_user: string; db_password: string; user_id: number;
    };
    console.log(`  ✓ ${conn.db_host}/${conn.db_name}`);

    // ── 3. Fetch schema from target DB ──
    console.log('\n[3/5] Fetching schema from target database...');
    const targetPool = new Pool({
      connectionString: `postgresql://${conn.db_user}:${conn.db_password}@${conn.db_host}:${conn.db_port}/${conn.db_name}`,
      max: 2,
    });

    const schemaResult = await targetPool.query(`
      SELECT
        t.table_schema, t.table_name,
        c.column_name, c.data_type,
        c.character_maximum_length
      FROM information_schema.tables t
      JOIN information_schema.columns c
        ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_schema, t.table_name, c.ordinal_position
    `);

    await targetPool.end();

    const rows = schemaResult.rows as Array<{
      table_schema: string; table_name: string;
      column_name: string; data_type: string; character_maximum_length: string | null;
    }>;

    // Build schema description string
    const schemaLines: string[] = [];
    let currentTable = '';
    for (const r of rows) {
      const fullTable = `${r.table_schema}.${r.table_name}`;
      if (fullTable !== currentTable) {
        currentTable = fullTable;
        schemaLines.push(`\n[${r.table_schema}] ${r.table_name}:`);
      }
      const len = r.character_maximum_length ? `(${r.character_maximum_length})` : '';
      schemaLines.push(`  - ${r.column_name} ${r.data_type}${len}`);
    }
    const schemaDescription = schemaLines.join('').trim();
    console.log(`  ✓ Schema loaded: ${rows.length} columns across ${new Set(rows.map(r => `${r.table_schema}.${r.table_name}`)).size} tables`);

    // ── 4. Get API key ──
    console.log('\n[4/5] Fetching API key...');
    const keyRow = await appPool.query(
      `SELECT api_key, provider, profile_name FROM api_keys
       WHERE user_id = $1
       ORDER BY is_default DESC, id DESC LIMIT 1`,
      [conn.user_id]
    );
    if (!keyRow.rows.length) {
      console.error('❌ No API key found for this user');
      process.exit(1);
    }
    const keyRec = keyRow.rows[0] as { api_key: string; provider: string; profile_name: string | null };
    console.log(`  ✓ Provider: ${keyRec.provider}`);

    // Resolve model name based on provider
    const modelMap: Record<string, string> = {
      claude:    'claude-3-5-sonnet-20241022',
      gemini:    'gemini-2.5-flash',
      openai:    'gpt-4o',
      grok:      'grok-2',
    };
    const modelName = modelMap[keyRec.provider] ?? 'claude-3-5-sonnet-20241022';
    console.log(`  ✓ Model: ${modelName}`);

    // ── 5. Generate VI→SQL examples ──
    console.log('\n[5/5] Generating VI→SQL examples via LLM...');
    console.log('  (This may take 30-60 seconds depending on LLM latency)\n');

    const examples = await generateTrainingExamples(
      schemaDescription,
      keyRec.provider,
      keyRec.api_key,
      modelName,
      30  // generate 30 examples
    );

    if (!examples.length) {
      console.error('\n❌ LLM failed to generate any examples. Check API key and quota.');
      process.exit(1);
    }

    console.log(`  ✓ Generated ${examples.length} VI→SQL examples`);
    console.log('\n  Preview (first 5):');
    for (let i = 0; i < Math.min(5, examples.length); i++) {
      const e = examples[i];
      console.log(`  ${i + 1}. Q: "${e.question_vi.slice(0, 60)}"`);
      console.log(`     SQL: ${e.sql.slice(0, 80)}...`);
      console.log();
    }

    // ── 6. Embed + store ──
    console.log('\n[6/6] Embedding & storing in pgvector...');

    // Load embedding service
    const { embedTexts, toPgVector } = await import('../services/embeddings');

    const questions = examples.map(e => e.question_vi);
    const embeddings = await embedTexts(questions, keyRec.api_key);

    console.log(`  ✓ Embeddings computed (${embeddings.length} vectors)`);

    let inserted = 0;
    let errors = 0;
    for (let i = 0; i < examples.length; i++) {
      const { question_vi, sql } = examples[i];
      const vec = toPgVector(embeddings[i]);
      try {
        await appPool.query(
          `INSERT INTO vanna_training_data (connection_id, question_vi, sql, embedding, source)
           VALUES ($1, $2, $3, $4::vector, 'auto')
           ON CONFLICT DO NOTHING`,
          [conn.id, question_vi.trim(), sql.trim(), vec]
        );
        inserted++;
      } catch (err) {
        errors++;
        console.warn(`  ⚠️  Insert error: ${question_vi.slice(0, 40)}`, err instanceof Error ? err.message : '');
      }
    }

    console.log(`\n  ✓ Stored: ${inserted} examples (${errors} errors)`);

    // Final count
    const total = await countTrainingData(conn.id);
    console.log(`\n✅ Training complete! Total examples in DB: ${total}`);

  } finally {
    await appPool.end();
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
