/**
 * connection-seeder.ts
 *
 * Auto-seed all LLM training data when a new connection is added.
 * Called by POST /connections after successful connection creation.
 *
 * Seeds:
 *   1. Table menu (menu_json)         → LLM Receptionist selects tables
 *   2. Table summaries (embedding)    → semantic table retrieval
 *   3. Foreign keys (keyword tsvector) → FK hints for SQL Chef
 *   4. Schema snapshot                → full schema text cache
 *   5. Training examples (auto-gen)    → VI→SQL RAG examples
 *
 * Usage (manual):
 *   import { seedConnection } from './connection-seeder';
 *   await seedConnection(connectionId, apiKey, provider);
 */

import { Pool } from 'pg';
import { appPool, createConnectionPool } from './db';
import { buildTableMenuFromPool, saveTableMenu } from './table-menu';
import { syncForeignKeys } from './foreign-key-retrieval';
import { saveSchemaSnapshot, inferLogicalFKs } from './schema-store';
import { embedText, toPgVector } from './embeddings';
import { generateTrainingExamples, upsertTrainingDataBulk } from './vanna-rag';

export interface SeedingResult {
  tableMenu: number;
  tableSummaries: number;
  foreignKeys: number;
  schemaSnapshot: { tables: number; columns: number };
  trainingExamples: { generated: number; inserted: number; errors: number };
  errors: string[];
}

/**
 * Seed all training data for a connection.
 * Call this after a connection is created/updated in the app DB.
 */
export async function seedConnection(
  connectionId: number,
  apiKey: string,
  provider: string,
  model?: string,
): Promise<SeedingResult> {
  const errors: string[] = [];
  const connRow = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE id = $1`,
    [connectionId]
  );
  if (!connRow.rows.length) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  const { db_host, db_port, db_name, db_user, db_password } = connRow.rows[0] as {
    db_host: string; db_port: string; db_name: string; db_user: string; db_password: string;
  };

  const targetPool = await createConnectionPool(
    `postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}`
  );

  try {
    // ── 1. Table menu ──────────────────────────────────────────────────────────
    console.log(`[seeder] Building table menu for conn ${connectionId}...`);
    const menuItems = await buildTableMenuFromPool(targetPool);
    await saveTableMenu(connectionId, menuItems);
    console.log(`[seeder] Table menu: ${menuItems.length} tables saved`);

    // ── 2. Table summaries with embeddings ────────────────────────────────────
    console.log(`[seeder] Generating table summaries for conn ${connectionId}...`);
    const summaryCount = await seedTableSummaries(targetPool, connectionId, apiKey);
    console.log(`[seeder] Table summaries: ${summaryCount} saved`);

    // ── 3. Foreign keys ───────────────────────────────────────────────────────
    console.log(`[seeder] Syncing FKs for conn ${connectionId}...`);
    const fkResult = await syncForeignKeys(connectionId, targetPool);
    console.log(`[seeder] FKs: ${fkResult.synced} hard, ${fkResult.softSynced} soft, ${fkResult.errors} errors`);
    if (fkResult.errors > 0) errors.push(`${fkResult.errors} FK sync errors`);

    // ── 4. Schema snapshot ────────────────────────────────────────────────────
    console.log(`[seeder] Saving schema snapshot for conn ${connectionId}...`);
    const snapshotResult = await seedSchemaSnapshot(targetPool, connectionId);
    console.log(`[seeder] Schema snapshot: ${snapshotResult.tables} tables, ${snapshotResult.columns} columns`);

    // ── 5. Auto-generate training examples ──────────────────────────────────────
    console.log(`[seeder] Generating training examples for conn ${connectionId}...`);
    const trainResult = await seedTrainingExamples(targetPool, connectionId, apiKey, provider, model);
    console.log(`[seeder] Training examples: ${trainResult.inserted} inserted, ${trainResult.errors} errors`);

    return {
      tableMenu: menuItems.length,
      tableSummaries: summaryCount,
      foreignKeys: fkResult.synced,
      schemaSnapshot: snapshotResult,
      trainingExamples: trainResult,
      errors,
    };
  } finally {
    await targetPool.end();
  }
}

// ─── Seed table summaries ─────────────────────────────────────────────────────

async function seedTableSummaries(
  pool: Pool,
  connectionId: number,
  apiKey: string,
): Promise<number> {
  // Fetch tables + columns + PostgreSQL comments (include BASE TABLE + VIEWs)
  const tablesRes = await pool.query(`
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      col_description(pc.oid, c.ordinal_position::int) AS column_description
    FROM information_schema.columns c
    LEFT JOIN pg_class pc
      ON pc.relname = c.table_name
     AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema)
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'topology')
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  // Group by table
  const byTable: Record<string, { schema: string; table: string; cols: { name: string; type: string; desc?: string }[] }> = {};
  for (const r of tablesRes.rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byTable[key]) byTable[key] = { schema: r.table_schema, table: r.table_name, cols: [] };
    byTable[key].cols.push({ name: r.column_name, type: r.data_type, desc: r.column_description || undefined });
  }

  // Fetch FKs for hints
  const fksRes = await pool.query(`
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

  // Detect topic
  function detectTopic(name: string, cols: { name: string }[]): string {
    const text = `${name} ${cols.map(c => c.name).join(' ')}`.toLowerCase();
    if (/province|district|commune|xa|huyen|tinh|phuong|ward|city|admin|dia_ban/.test(text)) return 'HVCH';
    if (/geometry|geography|spatial|lat|lon|point|polygon|geom|st_/.test(text)) return 'GIS';
    if (/ldlr|land_cover|land_use|forest|vegetation|burn|fire/.test(text)) return 'LDLR';
    if (/camera|monitor|capture|device|sensor|station/.test(text)) return 'CAM';
    if (/weather|ndvi|satellite|rain|temp|humidity/.test(text)) return 'KQTT';
    return 'DAT';
  }

  let saved = 0;
  const BATCH = 5; // embed in small batches to avoid rate limits

  const entries = Object.values(byTable);
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (entry) => {
        const key = `${entry.schema}.${entry.table}`;
        // Build column list with descriptions when available
        const colLines = entry.cols.map(c =>
          c.desc ? `${c.name} — ${c.desc}` : c.name
        );
        const topic = detectTopic(entry.table, entry.cols);
        const fks = fkMap[key] ?? [];
        const fkHint = fks.length > 0 ? `FK: ${fks.slice(0, 4).join(', ')}` : '';
        const summaryText = `[${topic}] ${colLines.join(', ')}`;

        try {
          const vec = toPgVector(await embedText(summaryText, apiKey));
          await appPool.query(
            `INSERT INTO db_table_summaries
               (connection_id, table_schema, table_name, summary_text, column_list, fk_hint, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7::vector)
             ON CONFLICT (connection_id, table_schema, table_name) DO UPDATE SET
               summary_text = EXCLUDED.summary_text,
               column_list  = EXCLUDED.column_list,
               fk_hint      = EXCLUDED.fk_hint,
               embedding    = EXCLUDED.embedding`,
            [connectionId, entry.schema, entry.table, summaryText, colLines.join(', '), fkHint, vec]
          );
          saved++;
        } catch (e) {
          console.warn(`[seeder] summary error ${key}: ${e}`);
        }
      })
    );
    // Rate-limit delay between batches
    if (i + BATCH < entries.length) await sleep(500);
  }

  return saved;
}

// ─── Seed schema snapshot ─────────────────────────────────────────────────────

async function seedSchemaSnapshot(pool: Pool, connectionId: number): Promise<{ tables: number; columns: number }> {
  const colResult = await pool.query(`
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.column_default,
      col_description(pc.oid, c.ordinal_position::int) AS description
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    LEFT JOIN pg_class pc
      ON pc.relname = c.table_name
     AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema)
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  const fkResult = await pool.query(`
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

  // Infer logical FKs from naming convention + merge with real FKs
  const logicalFKs = inferLogicalFKs(colResult.rows);
  const seenFK = new Set<string>();
  const allFKs = [...fkResult.rows];
  for (const lfk of logicalFKs) {
    const key = `${lfk.table_schema}.${lfk.table_name}.${lfk.column_name}->${lfk.foreign_table_schema}.${lfk.foreign_table_name}.${lfk.foreign_column_name}`;
    if (!seenFK.has(key)) { seenFK.add(key); allFKs.push(lfk); }
  }

  const enriched = {
    columns: colResult.rows,
    foreignKeys: allFKs,
  };

  await saveSchemaSnapshot(connectionId, enriched, '');

  return { tables: new Set(colResult.rows.map(r => `${r.table_schema}.${r.table_name}`)).size, columns: colResult.rows.length };
}

// ─── Seed training examples ────────────────────────────────────────────────────

/**
 * Domain-specific manual examples for this project's business logic.
 * These cover join chains that auto-generation might miss.
 */
const DOMAIN_EXAMPLES: Array<{ question: string; sql: string }> = [
  {
    question: "có bao nhiêu điểm cháy từ camera tân uyên trong tuần qua",
    sql: `SELECT COUNT(*) AS so_diem_chay
FROM fire.fire_alert fa
JOIN "user"."user" u ON u.id = fa.actor_id
JOIN camera.camera c ON c.manage_user_id = u.id
WHERE c.name = 'Tân Uyên'
  AND fa.source = 'CAMERA'
  AND fa.detected_at >= NOW() - INTERVAL '1 week'`,
  },
  {
    question: "đếm điểm cháy theo từng camera trong tháng qua",
    sql: `SELECT c.name AS camera_name, COUNT(fa.id) AS so_diem_chay
FROM fire.fire_alert fa
JOIN "user"."user" u ON u.id = fa.actor_id
JOIN camera.camera c ON c.manage_user_id = u.id
WHERE fa.source = 'CAMERA'
  AND fa.detected_at >= NOW() - INTERVAL '1 month'
GROUP BY c.id, c.name
ORDER BY so_diem_chay DESC`,
  },
  {
    question: "danh sách điểm cháy ở huyện than uyên trong 30 ngày",
    sql: `SELECT fa.id, fa.detected_at, fa.commune_name, fa.district_name, fa.source
FROM fire.fire_alert fa
WHERE fa.district_name ILIKE '%Than Uyên%'
  AND fa.detected_at >= NOW() - INTERVAL '30 days'
ORDER BY fa.detected_at DESC`,
  },
  {
    question: "camera nào phát hiện nhiều điểm cháy nhất tháng này",
    sql: `SELECT c.name AS camera_name, COUNT(*) AS so_lan_phat_hien
FROM fire.fire_alert fa
JOIN "user"."user" u ON u.id = fa.actor_id
JOIN camera.camera c ON c.manage_user_id = u.id
WHERE fa.source = 'CAMERA'
  AND DATE_TRUNC('month', fa.detected_at) = DATE_TRUNC('month', NOW())
GROUP BY c.id, c.name
ORDER BY so_lan_phat_hien DESC
LIMIT 5`,
  },
  {
    question: "thống kê điểm cháy theo nguồn phát hiện",
    sql: `SELECT fa.source, COUNT(*) AS so_luong
FROM fire.fire_alert fa
WHERE fa.detected_at >= NOW() - INTERVAL '1 month'
GROUP BY fa.source
ORDER BY so_luong DESC`,
  },
];

async function seedTrainingExamples(
  pool: Pool,
  connectionId: number,
  apiKey: string,
  provider: string,
  model?: string,
): Promise<{ generated: number; inserted: number; errors: number }> {
  // Build schema text for generation prompt
  const colResult = await pool.query(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  const lines: string[] = [];
  for (const r of colResult.rows) {
    lines.push(`  ${r.table_schema}.${r.table_name}.${r.column_name} (${r.data_type})`);
  }
  const schemaText = lines.join('\n');

  // Group by schema.table for clearer structure
  const byTable: Record<string, string[]> = {};
  for (const r of colResult.rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byTable[key]) byTable[key] = [];
    byTable[key].push(`  ${r.column_name} (${r.data_type})`);
  }
  const structuredSchema = Object.entries(byTable)
    .map(([table, cols]) => `${table}\n${cols.join('\n')}`)
    .join('\n\n');

  try {
    const modelMap: Record<string, string> = {
      gemini: model ?? 'gemini-2.5-pro',
      openai: model ?? 'gpt-4o-mini',
      grok: model ?? 'grok-2-mini',
      claude: model ?? 'claude-3-5-haiku-20241022',
    };
    const modelName = modelMap[provider] ?? 'gemini-2.5-pro';

    const generated = await generateTrainingExamples(
      structuredSchema,
      provider,
      apiKey,
      modelName,
      25,
    );

    if (!generated.length) {
      return { generated: 0, inserted: 0, errors: 0 };
    }

    // Add domain-specific manual examples
    const domainMapped = DOMAIN_EXAMPLES.map(e => ({ question_vi: e.question, sql: e.sql }));
    const allExamples = [...generated, ...domainMapped];

    const { inserted, errors } = await upsertTrainingDataBulk(connectionId, allExamples, apiKey, 'manual');
    return { generated: allExamples.length, inserted, errors };
  } catch (e) {
    console.warn(`[seeder] training example generation failed:`, e);
    return { generated: 0, inserted: 0, errors: 1 };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
