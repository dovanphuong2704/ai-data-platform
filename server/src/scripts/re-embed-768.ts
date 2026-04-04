/**
 * re-embed-768.ts
 *
 * Re-embed all existing vectors from 3072 dims (gemini-embedding-2-preview)
 * to 768 dims (gemini-embedding-001).
 *
 * IMPORTANT: Run this BEFORE migration 009_embedding_768_hnsw.sql
 *
 * Usage:
 *   npx tsx src/scripts/re-embed-768.ts --dry-run  (preview only)
 *   npx tsx src/scripts/re-embed-768.ts          (actual re-embed)
 *
 * Prerequisites:
 *   - Run: ALTER TABLE ... ALTER COLUMN embedding TYPE vector(768);
 *          AFTER changing the column type
 *   - The new gemini-embedding-001 will produce 768-dim vectors
 */

import { Pool } from 'pg';
import { appPool } from '../services/db';
import { embedText, toPgVector } from '../services/embeddings';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 10; // Re-embed 10 items at a time
const VERIFY_BATCH = 5; // Verify 5 items after re-embed

if (DRY_RUN) {
  console.log('🧪 DRY RUN MODE - No changes will be made\n');
}

async function getDefaultApiKey() {
  const result = await appPool.query(
    `SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
  );
  if (!result.rows.length) {
    throw new Error('No API key found in database');
  }
  return result.rows[0] as { api_key: string; provider: string };
}

async function reembedTable(
  table: 'vanna_training_data' | 'vanna_docs' | 'db_table_summaries',
  idCol: string,
  textCol: string,
  apiKey: string,
  apiKeyRecord: { api_key: string; provider: string },
): Promise<{ processed: number; errors: number; skipped: number }> {
  const colName = textCol === 'question_vi' ? textCol : 'title';
  let processed = 0;
  let errors = 0;
  let skipped = 0;

  console.log(`\n📋 Processing table: ${table}`);

  // Get all rows that need re-embedding
  const selectQuery = table === 'vanna_training_data'
    ? `SELECT id, question_vi AS text FROM ${table} WHERE embedding IS NOT NULL LIMIT 1000`
    : table === 'vanna_docs'
    ? `SELECT id, title AS text FROM ${table} WHERE embedding IS NOT NULL LIMIT 500`
    : `SELECT id, summary_text AS text FROM ${table} WHERE embedding IS NOT NULL LIMIT 500`;

  const rows = await appPool.query(selectQuery);
  const total = rows.rows.length;

  console.log(`  Found ${total} rows to re-embed`);

  for (let i = 0; i < rows.rows.length; i += BATCH_SIZE) {
    const batch = rows.rows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchStart = i + 1;
    const batchEnd = Math.min(i + BATCH_SIZE, total);

    if (!DRY_RUN) {
      process.stdout.write(`  Batch ${batchNum}: ${batchStart}-${batchEnd}/${total} `);
    } else {
      process.stdout.write(`  Batch ${batchNum}: would re-embed rows ${batchStart}-${batchEnd}\n`);
      processed += batch.length;
      continue;
    }

    const newVectors: Array<{ id: number; vector: string }> = [];

    for (const row of batch) {
      try {
        const text = row.text as string;
        if (!text || text.trim().length < 5) {
          skipped++;
          continue;
        }

        // Re-embed with gemini-embedding-001 (768 dims)
        const vector = await embedText(text, apiKeyRecord.api_key);

        // Verify dimension
        if (vector.length !== 768) {
          console.warn(`\n  ⚠️  Warning: got ${vector.length} dims instead of 768 for row ${row.id}`);
        }

        newVectors.push({ id: row.id as number, vector: toPgVector(vector) });
      } catch (err) {
        console.error(`\n  ❌ Error embedding row ${row.id}:`, err instanceof Error ? err.message : err);
        errors++;
      }
    }

    // Bulk update
    for (const { id, vector } of newVectors) {
      try {
        await appPool.query(
          `UPDATE ${table} SET embedding = $1::vector WHERE id = $2`,
          [vector, id]
        );
        processed++;
      } catch (err) {
        console.error(`\n  ❌ Update error for id ${id}:`, err instanceof Error ? err.message : err);
        errors++;
      }
    }

    process.stdout.write(`✅ processed=${processed} errors=${errors}\n`);
  }

  return { processed, errors, skipped };
}

async function verifyDimensionChange(table: string): Promise<void> {
  const result = await appPool.query(`
    SELECT embedding_ndims(embedding::vector) as dims
    FROM ${table}
    WHERE embedding IS NOT NULL
    LIMIT 5
  `);

  const dims = result.rows.map(r => r.dims);
  console.log(`\n📐 ${table}: embedding dims = ${[...new Set(dims)].join(', ')}`);
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL!;
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set in .env');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('[RE-EMBED 768] Gemini Embedding-001 (768 dims) Re-embed');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN' : '🚀 LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  // Get API key
  console.log('🔑 Fetching API key...');
  const apiKeyRecord = await getDefaultApiKey();
  console.log(`  Provider: ${apiKeyRecord.provider}\n`);

  // Test embedding first
  console.log('🧪 Testing embedding dimension...');
  try {
    const testVec = await embedText('Test embedding', apiKeyRecord.api_key);
    console.log(`  Dimensions: ${testVec.length} (expected: 768)`);
    if (testVec.length !== 768) {
      console.warn(`  ⚠️  WARNING: got ${testVec.length} dims. Check if migration ran.`);
    }
  } catch (err) {
    console.error('❌ Embedding test failed:', err instanceof Error ? err.message : err);
    console.error('   Make sure migration 009_embedding_768_hnsw.sql has been applied!');
    process.exit(1);
  }

  const totalStart = Date.now();

  // Re-embed all tables
  let totalProcessed = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  // 1. vanna_training_data
  const r1 = await reembedTable(
    'vanna_training_data',
    'id',
    'question_vi',
    apiKeyRecord.api_key,
    apiKeyRecord,
  );
  totalProcessed += r1.processed;
  totalErrors += r1.errors;
  totalSkipped += r1.skipped;

  // 2. vanna_docs
  const r2 = await reembedTable(
    'vanna_docs',
    'id',
    'title',
    apiKeyRecord.api_key,
    apiKeyRecord,
  );
  totalProcessed += r2.processed;
  totalErrors += r2.errors;
  totalSkipped += r2.skipped;

  // 3. db_table_summaries
  const r3 = await reembedTable(
    'db_table_summaries',
    'id',
    'summary_text',
    apiKeyRecord.api_key,
    apiKeyRecord,
  );
  totalProcessed += r3.processed;
  totalErrors += r3.errors;
  totalSkipped += r3.skipped;

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);

  // Verify
  console.log('\n📐 Verifying new dimensions...');
  await verifyDimensionChange('vanna_training_data');
  await verifyDimensionChange('vanna_docs');
  await verifyDimensionChange('db_table_summaries');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('✅ RE-EMBED COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Processed: ${totalProcessed}`);
  console.log(`  Errors:    ${totalErrors}`);
  console.log(`  Skipped:   ${totalSkipped}`);
  console.log(`  Time:      ${totalTime}s`);
  console.log('\n📋 Next steps:');
  console.log('  1. Run migration: psql $DATABASE_URL < src/db/migrations/009_embedding_768_hnsw.sql');
  console.log('  2. Create HNSW indexes (if not already created above)');
  console.log('  3. Verify indexes: SELECT * FROM pg_indexes WHERE indexname LIKE \'%hnsw%\'');

  await appPool.end();
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
