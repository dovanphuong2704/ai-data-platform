/**
 * sync-table-summaries.ts
 *
 * Seed db_table_summaries for all connections.
 * Fetches schema from target DB -> generates summary text -> embeds -> saves.
 *
 * Usage:
 *   npx tsx src/scripts/sync-table-summaries.ts
 *   npx tsx src/scripts/sync-table-summaries.ts --connection 3
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { embedText, toPgVector } from '../services/embeddings';

dotenv.config();

const TARGET_CONN_ID = parseInt(process.argv.find(a => a.startsWith('--connection'))?.split('=')[1] ?? '0', 10);
const BATCH = 10;

async function main() {
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
  const DB_URL = process.env.DATABASE_URL!;

  // ── Get connections to seed ──
  const connRows = TARGET_CONN_ID > 0
    ? await appPool.query(`SELECT * FROM db_connections WHERE id = $1`, [TARGET_CONN_ID])
    : await appPool.query(`SELECT * FROM db_connections`);

  if (!connRows.rows.length) {
    console.error('No connections found');
    await appPool.end();
    return;
  }

  console.log(`Found ${connRows.rows.length} connection(s) to seed\n`);

  for (const conn of connRows.rows as Array<{ id: number; db_host: string; db_port: string; db_name: string; db_user: string; db_password: string }>) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Connection #${conn.id}: ${conn.db_host}/${conn.db_name}`);

    try {
      const targetPool = new Pool({
        connectionString: `postgresql://${conn.db_user}:${conn.db_password}@${conn.db_host}:${conn.db_port}/${conn.db_name}`,
        max: 2,
      });

      // Get API key for embedding
      const keyRow = await appPool.query(
        `SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
      );
      if (!keyRow.rows.length) {
        console.error('  ❌ No API key found, skipping');
        await targetPool.end();
        continue;
      }
      const { api_key: apiKey } = keyRow.rows[0] as { api_key: string; provider: string };

      // Fetch all tables + columns
      const tablesRes = await targetPool.query(`
        SELECT
          t.table_schema,
          t.table_name,
          c.column_name,
          c.data_type
        FROM information_schema.tables t
        JOIN information_schema.columns c
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'topology')
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_schema, t.table_name, c.ordinal_position
      `);

      // Group columns by table
      const byTable: Record<string, { schema: string; table: string; cols: { name: string; type: string }[] }> = {};
      for (const r of tablesRes.rows) {
        const key = `${r.table_schema}.${r.table_name}`;
        if (!byTable[key]) byTable[key] = { schema: r.table_schema, table: r.table_name, cols: [] };
        byTable[key].cols.push({ name: r.column_name, type: r.data_type });
      }

      // Fetch FKs
      const fksRes = await targetPool.query(`
        SELECT tc.table_schema, tc.table_name, kcu.column_name,
               ccu.table_schema AS ref_schema, ccu.table_name AS ref_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      `);
      const fkMap: Record<string, string[]> = {};
      for (const r of fksRes.rows) {
        const key = `${r.table_schema}.${r.table_name}`;
        if (!fkMap[key]) fkMap[key] = [];
        fkMap[key].push(`${r.column_name}→${r.ref_schema}.${r.ref_table}`);
      }


      // Also track INBOUND FKs (what references this table)
      const inboundFkMap: Record<string, string[]> = {};
      for (const r of fksRes.rows) {
        const targetKey = `${r.ref_schema}.${r.ref_table}`;
        if (!inboundFkMap[targetKey]) inboundFkMap[targetKey] = [];
        inboundFkMap[targetKey].push(`${r.table_schema}.${r.table_name}.${r.column_name}`);
      }

      // Detect topic
      function detectTopic(name: string, cols: { name: string }[]): string {
        const text = `${name} ${cols.map(c => c.name).join(' ')}`.toLowerCase();
        if (/province|district|commune|xa|huyen|tinh/.test(text)) return 'HVCH';
        if (/geometry|geography|lat|lon|point|polygon|geom/.test(text)) return 'GIS';
        if (/ldlr|forest|land_cover|land_use|vegetation|burn|fire/.test(text)) return 'LDLR';
        if (/camera|monitor|device|sensor/.test(text)) return 'CAM';
        if (/weather|ndvi|satellite|rain|temp/.test(text)) return 'KQTT';
        return 'DAT';
      }

      // Generate summaries
      const entries = Object.values(byTable);
      console.log(`  Found ${entries.length} tables`);

      let saved = 0;
      let errors = 0;

      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        process.stdout.write(`  ${i + 1}-${Math.min(i + BATCH, entries.length)}/${entries.length}... `);

        for (const entry of batch) {
          const key = `${entry.schema}.${entry.table}`;
          const cols = entry.cols.map(c => c.name).join(', ');
          const topic = detectTopic(entry.table, entry.cols);
          const fks = fkMap[key] ?? [];
          const inbound = inboundFkMap[key] ?? [];
          const allHints = [...fks.map(f => `OUT:${f}`), ...inbound.map(f => `IN:${f}`)];
          const fkHint = allHints.length > 0 ? `FK: ${allHints.slice(0, 4).join(', ')}` : '';
          const summaryText = `[${topic}] ${cols}`;
          const columnList = cols;
          const vec = toPgVector(await embedText(summaryText, apiKey));

          try {
            await appPool.query(
              `INSERT INTO db_table_summaries
                 (connection_id, table_schema, table_name, summary_text, column_list, fk_hint, embedding)
               VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
               ON CONFLICT (connection_id, table_schema, table_name) DO UPDATE SET
                 summary_text = EXCLUDED.summary_text,
                 column_list  = EXCLUDED.column_list,
                 fk_hint     = EXCLUDED.fk_hint,
                 embedding    = EXCLUDED.embedding`,
              [conn.id, entry.schema, entry.table, summaryText, columnList, fkHint, vec]
            );
            saved++;
          } catch (e) {
            errors++;
            console.error(`\n  ERR ${entry.schema}.${entry.table}: ${e}`);
          }
        }
        console.log(`OK (${saved}/${entries.length})`);
      }

      console.log(`\n  ✅ Saved: ${saved}, Errors: ${errors}`);
      await targetPool.end();
    } catch (e) {
      console.error(`  ❌ Error: ${e}`);
    }
  }

  await appPool.end();
  console.log('\n✅ Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
