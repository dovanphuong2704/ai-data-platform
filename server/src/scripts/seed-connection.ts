/**
 * seed-connection.ts
 *
 * Full reseed of all training data for a connection.
 * Run manually after updating seeder logic to backfill existing connections.
 *
 * Usage:
 *   npx tsx src/scripts/seed-connection.ts --connection=2
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';
import { seedConnection } from '../services/connection-seeder';

dotenv.config();

const CONN_ID = parseInt(
  process.argv.find(a => a.startsWith('--connection='))?.split('=')[1] ?? '0',
  10
);

async function main() {
  if (!CONN_ID) {
    console.error('Usage: npx tsx src/scripts/seed-connection.ts --connection=<id>');
    process.exit(1);
  }

  const appPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });

  // Get API key
  const keyRow = await appPool.query(
    `SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
  );
  if (!keyRow.rows.length) {
    console.error('No API key found');
    await appPool.end();
    return;
  }
  const { api_key, provider } = keyRow.rows[0] as { api_key: string; provider: string };
  const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];

  console.log(`Seeding connection ${CONN_ID} with provider=${provider}, model=${modelArg ?? 'auto'}\n`);
  const result = await seedConnection(CONN_ID, api_key, provider, modelArg);
  console.log('\nResult:', JSON.stringify(result, null, 2));

  await appPool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
