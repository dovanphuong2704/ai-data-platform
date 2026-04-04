/**
 * sync-foreign-keys.ts
 *
 * Sync FKs from target DBs into app DB db_foreign_keys.
 *
 * Usage:
 *   npx tsx src/scripts/sync-foreign-keys.ts
 *   npx tsx src/scripts/sync-foreign-keys.ts --connection 2
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { syncForeignKeys } from '../services/foreign-key-retrieval';

dotenv.config();

const TARGET_CONN_ID = parseInt(
  process.argv.find(a => a.startsWith('--connection'))?.split('=')[1] ?? '0',
  10
);

async function main() {
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });

  // Get connections
  const connRows = TARGET_CONN_ID > 0
    ? await appPool.query(`SELECT * FROM db_connections WHERE id = $1`, [TARGET_CONN_ID])
    : await appPool.query(`SELECT * FROM db_connections`);

  if (!connRows.rows.length) {
    console.error('No connections found');
    await appPool.end();
    return;
  }

  console.log(`Found ${connRows.rows.length} connection(s) to sync FKs\n`);

  for (const conn of connRows.rows as Array<{
    id: number;
    db_host: string; db_port: string;
    db_name: string; db_user: string; db_password: string;
  }>) {
    console.log(`${'='.repeat(50)}`);
    console.log(`Connection #${conn.id}: ${conn.db_host}/${conn.db_name}`);

    try {
      const targetPool = new Pool({
        connectionString: `postgresql://${conn.db_user}:${conn.db_password}@${conn.db_host}:${conn.db_port}/${conn.db_name}`,
        max: 2,
      });

      const result = await syncForeignKeys(conn.id, targetPool);
      console.log(`  Hard FKs: ${result.synced}, Soft FKs: ${result.softSynced}, Errors: ${result.errors}`);

      await targetPool.end();
    } catch (e) {
      console.error(`  ❌ Error: ${e}`);
    }
  }

  await appPool.end();
  console.log('\n✅ Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
