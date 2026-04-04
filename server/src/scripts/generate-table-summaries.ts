/**
 * generate-table-summaries.ts
 * Sinh mô tả vector cho từng bảng trong target DB.
 * Run: npx tsx src/scripts/generate-table-summaries.ts
 *
 * Đọc schema từ target DB (fms_laichau) → sinh mô tả ngắn → embed → upsert vào db_table_summaries.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { appPool } from '../services/db';
import { embedText, toPgVector } from '../services/embeddings';
import { upsertTableSummary } from '../services/table-retrieval';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL!;
const TARGET_CONNECTION_ID = parseInt(process.env.TARGET_CONNECTION_ID ?? '3', 10);

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

interface ColumnInfo {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
}

interface FKInfo {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

async function main() {
  console.log('='.repeat(60));
  console.log('[TABLE SUMMARIES] Generate + embed for all tables');
  console.log('='.repeat(60));

  // 1. Get connection info
  const connRow = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password, user_id
     FROM db_connections WHERE id = $1`,
    [TARGET_CONNECTION_ID]
  );
  if (!connRow.rows.length) { console.error(`Connection #${TARGET_CONNECTION_ID} not found`); process.exit(1); }
  const conn = connRow.rows[0] as {
    db_host: string; db_port: string; db_name: string;
    db_user: string; db_password: string; user_id: number;
  };

  // 2. Get API key
  const keyRow = await appPool.query(
    `SELECT api_key FROM api_keys
     WHERE user_id = $1 ORDER BY is_default DESC, id DESC LIMIT 1`,
    [conn.user_id]
  );
  if (!keyRow.rows.length) { console.error('No API key found'); process.exit(1); }
  const apiKey = (keyRow.rows[0] as { api_key: string }).api_key;

  // 3. Connect to target DB
  const targetPool = new Pool({
    connectionString: `postgresql://${conn.db_user}:${conn.db_password}@${conn.db_host}:${conn.db_port}/${conn.db_name}`,
    max: 2,
  });

  try {
    // Fetch all columns
    const colRows = await targetPool.query<ColumnInfo>(`
      SELECT c.table_schema, c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);

    // Fetch all FKs
    const fkRows = await targetPool.query<FKInfo>(`
      SELECT tc.table_schema, tc.table_name, kcu.column_name,
             ccu.table_schema AS foreign_table_schema,
             ccu.table_name AS foreign_table_name,
             ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    `);

    // Group by table
    const tableMap = new Map<string, { cols: ColumnInfo[]; fks: FKInfo[] }>();
    for (const c of colRows.rows) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (!tableMap.has(key)) tableMap.set(key, { cols: [], fks: [] });
      tableMap.get(key)!.cols.push(c);
    }
    for (const fk of fkRows.rows) {
      const key = `${fk.table_schema}.${fk.table_name}`;
      if (tableMap.has(key)) tableMap.get(key)!.fks.push(fk);
    }

    const tables = [...tableMap.entries()];
    console.log(`\n[${tables.length}] tables found`);
    console.log(`[${colRows.rows.length}] columns, [${fkRows.rows.length}] foreign keys`);

    // 3. Generate summary + embed + upsert for each table
    let processed = 0;
    let errors = 0;

    for (const [fullTable, { cols, fks }] of tables) {
      const [schema, table] = fullTable.split('.');

      // Build summary text
      const colList = cols.map(c => `${c.column_name} (${c.data_type})`).join(', ');
      const fkHints = fks.map(fk =>
        `JOIN ${fk.foreign_table_schema}.${fk.foreign_table_name}(${fk.foreign_column_name})`
      ).join(', ');

      // Generate Vietnamese description based on table/schema name
      const summary = generateSummary(schema, table, cols, fks);

      try {
        await upsertTableSummary(
          TARGET_CONNECTION_ID,
          schema,
          table,
          summary,
          colList,
          fkHints,
          apiKey,
        );
        processed++;
        if (processed % 20 === 0) {
          process.stdout.write(`\n  Processed ${processed}/${tables.length}...`);
        }
      } catch (err) {
        errors++;
        console.warn(`\n  ERR [${schema}.${table}]:`, err instanceof Error ? err.message : '');
      }
    }

    console.log(`\n\n✅ Done. Processed: ${processed}, Errors: ${errors}`);

    // Verify
    const count = await appPool.query(
      `SELECT COUNT(*) FROM db_table_summaries WHERE connection_id = $1`,
      [TARGET_CONNECTION_ID]
    );
    console.log(`   Total rows in db_table_summaries: ${(count.rows[0] as { count: string }).count}`);

  } finally {
    await targetPool.end();
  }
}

/**
 * Generate Vietnamese summary for a table based on its name and columns.
 */
function generateSummary(schema: string, table: string, cols: ColumnInfo[], fks: FKInfo[]): string {
  // Build meaningful summary based on schema/table naming conventions
  const parts: string[] = [];

  // Schema-specific context
  const schemaMap: Record<string, string> = {
    fire: 'Du lieu phat hien va canh bao chay rung',
    camera: 'Du lieu giam sat camera',
    core: 'Du lieu dia ly va cay lam nghiep',
    chatbot: 'Du lieu cuoc tro chuyen nguoi dung',
    weather: 'Du lieu thoi tiet',
    detect: 'Du lieu phat hien thay doi',
    config: 'Cau hinh he thong',
    doc: 'Tai lieu van ban',
    public: 'Du lieu chung',
  };
  if (schemaMap[schema]) parts.push(schemaMap[schema]);

  // Table name breakdown
  const nameParts = table.split('_').filter(p => p.length > 1);
  if (nameParts.length > 0) {
    parts.push(`Bang ${table}: ${nameParts.join(', ')}`);
  }

  // Key columns
  const colNames = cols.map(c => c.column_name);
  const hasId = colNames.includes('id');
  const hasName = colNames.some(c => c.includes('name'));
  const hasLat = colNames.some(c => c.includes('lat') || c.includes('latitude'));
  const hasLon = colNames.some(c => c.includes('lon') || c.includes('longitude'));
  const hasDate = colNames.some(c => c.includes('date') || c.includes('at') || c.includes('time'));
  const hasArea = colNames.some(c => c.includes('area'));
  const hasCode = colNames.some(c => c.includes('_code') || c === 'code');

  const hints: string[] = [];
  if (hasLat && hasLon) hints.push('co toa do dia ly');
  if (hasArea) hints.push('co dien tich');
  if (hasCode) hints.push('co ma/danh muc');
  if (hasDate) hints.push('co thoi gian');
  if (hasId && fks.length > 0) hints.push(`co ${fks.length} khoa ngoai`);

  if (hints.length > 0) parts.push(`Dac diem: ${hints.join(', ')}`);
  if (fks.length > 0) {
    const fkNames = fks.map(fk => `${fk.foreign_table_schema}.${fk.foreign_table_name}`);
    parts.push(`FK: ${[...new Set(fkNames)].join(', ')}`);
  }

  return parts.join('. ');
}

main().catch(err => { console.error(err); process.exit(1); });
