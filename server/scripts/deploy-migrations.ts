/**
 * scripts/deploy-migrations.ts
 * Chạy tất cả SQL migrations theo thứ tự.
 * Dùng cho: local dev, production, CI/CD.
 *
 * Usage:
 *   npx tsx scripts/deploy-migrations.ts
 *
 * Env vars:
 *   DATABASE_URL - connection string (bắt buộc)
 *   DRY_RUN=1    - chỉ hiện SQL, không chạy
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === '1';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL env var is required');
  process.exit(1);
}

const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');
const ORDER = [
  '004_vanna-rag',
  '005_schema_snapshot',
  '006_vanna-docs',
  '007_table_summaries',
  '009_embedding_768_hnsw',
  '010_table_menus',
  '011_foreign_keys',
];

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`🔌 Connected to ${process.env.DATABASE_URL}\n`);

  for (const name of ORDER) {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith(name));
    if (!files.length) {
      console.warn(`⚠️  No file found for ${name}`);
      continue;
    }
    // Take the latest version if multiple (e.g. name.1.sql, name.2.sql)
    files.sort();
    const sql = readFileSync(join(MIGRATIONS_DIR, files[files.length - 1]), 'utf8');

    console.log(`📄 ${files[files.length - 1]} ...`);
    if (DRY_RUN) {
      console.log(sql.slice(0, 200) + '...\n');
      continue;
    }

    try {
      await client.query(sql);
      console.log(`✅ Done`);
    } catch (err: any) {
      if (err.code === '42P07' || err.code === '42710') {
        // table/index already exists — OK
        console.log(`⏭️  Already exists (${err.code}), skipping`);
      } else {
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
      }
    }
  }

  await client.end();
  console.log('\n✅ All migrations complete');
}

main().catch(err => { console.error(err); process.exit(1); });
