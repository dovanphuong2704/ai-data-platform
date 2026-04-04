/**
 * foreign-key-retrieval.ts
 *
 * Stores FK relationships in app DB, retrieves relevant hints via keyword search.
 *
 * Hard FKs: real FOREIGN KEY constraints in the DB
 * Soft FKs: columns named {ref_table}_id → another table's PK
 *          (e.g. camera.data_log.camera_id → camera.camera.id)
 */

import { appPool } from "./db";
import type { Pool } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FKRelation {
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  direction: string;
  hintText: string;
  keywords: string;
}

export interface FKSyncResult {
  synced: number;      // hard FKs from real constraints
  softSynced: number;  // soft FKs from column naming patterns
  errors: number;
}

// ─── Sync FKs from target DB → app DB ────────────────────────────────────────

/**
 * Sync FKs (hard + soft) from target DB into app DB.
 * Idempotent — safe to call repeatedly.
 */
export async function syncForeignKeys(
  connectionId: number,
  targetPool: Pool,
): Promise<FKSyncResult> {
  // ── 1. Hard FKs ─────────────────────────────────────────────────────────────
  const hardRes = await targetPool.query<{
    source_schema: string;
    source_table: string;
    source_column: string;
    target_schema: string;
    target_table: string;
    target_column: string;
  }>(`
    SELECT tc.table_schema AS source_schema,
           tc.table_name  AS source_table,
           kcu.column_name AS source_column,
           ccu.table_schema AS target_schema,
           ccu.table_name   AS target_table,
           ccu.column_name  AS target_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND tc.table_schema IS NOT NULL
      AND ccu.table_schema IS NOT NULL
  `);

  let synced = 0;
  let errors = 0;

  // Track hard FK keys to avoid duplicates with soft FKs
  const seenKeys = new Set<string>();
  for (const fk of hardRes.rows) {
    const key = `${fk.source_schema}.${fk.source_table}.${fk.source_column}->${fk.target_schema}.${fk.target_table}`;
    seenKeys.add(key);
    await upsertFK(connectionId, fk.source_schema, fk.source_table, fk.source_column,
      fk.target_schema, fk.target_table, fk.target_column, 'hard');
    synced++;
  }

  // ── 2. Soft FKs: {table}_id / id_{table} → table PK ─────────────────────────
  let softSynced = 0;

  // Get all PKs
  const pkRes = await targetPool.query<{ table_schema: string; table_name: string; pk_column: string }>(`
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name AS pk_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND tc.table_schema IS NOT NULL
  `);

  const pkMap: Record<string, { schema: string; table: string; pk: string }> = {};
  for (const r of pkRes.rows) {
    pkMap[r.table_name.toLowerCase()] = { schema: r.table_schema, table: r.table_name, pk: r.pk_column };
  }

  // Get all columns
  const colRes = await targetPool.query<{ table_schema: string; table_name: string; column_name: string }>(`
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND t.table_type = 'BASE TABLE'
  `);

  for (const col of colRes.rows) {
    const colLower = col.column_name.toLowerCase();

    for (const [targetName, pkInfo] of Object.entries(pkMap)) {
      if (col.table_name.toLowerCase() === targetName) continue;

      const key = `${col.table_schema}.${col.table_name}.${col.column_name}->${pkInfo.schema}.${pkInfo.table}`;
      if (seenKeys.has(key)) continue;

      const patterns = [`${targetName}_id`, `id_${targetName}`, `${targetName}id`, `id${targetName}`];
      if (patterns.some(p => colLower === p)) {
        await upsertFK(connectionId, col.table_schema, col.table_name, col.column_name,
          pkInfo.schema, pkInfo.table, pkInfo.pk, 'soft');
        softSynced++;
        seenKeys.add(key);
        break;
      }
    }
  }

  return { synced, softSynced, errors };
}

// ─── Upsert single FK ──────────────────────────────────────────────────────────

async function upsertFK(
  connId: number,
  srcSchema: string, srcTable: string, srcCol: string,
  tgtSchema: string, tgtTable: string, tgtCol: string,
  direction: string,
): Promise<void> {
  const hintText = `${srcSchema}.${srcTable}.${srcCol} -> ${tgtSchema}.${tgtTable}.${tgtCol}`;
  const keywords = (srcSchema + " " + srcTable + " " + srcCol + " " +
    tgtSchema + " " + tgtTable + " " + tgtCol).toLowerCase();

  try {
    await appPool.query(
      `INSERT INTO db_foreign_keys
         (connection_id, source_schema, source_table, source_column,
          target_schema, target_table, target_column, direction, hint_text, keywords)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_tsvector('simple', $9))
       ON CONFLICT (connection_id, source_schema, source_table, source_column,
                    target_schema, target_table, target_column)
       DO UPDATE SET direction = EXCLUDED.direction,
                    hint_text  = EXCLUDED.hint_text,
                    keywords   = EXCLUDED.keywords`,
      [connId, srcSchema, srcTable, srcCol, tgtSchema, tgtTable, tgtCol, direction, keywords]
    );
  } catch (e) {
    console.warn("[fk-upsert]", hintText, "error:", e);
  }
}

// ─── Retrieve FKs by question keywords ────────────────────────────────────────

/**
 * Retrieve FKs matching ANY keyword in the question (OR semantics).
 * Returns top-K most relevant FK relationships for the SQL Chef.
 */
export async function getForeignKeys(
  question: string,
  connectionId: number,
  topK = 5,
): Promise<FKRelation[]> {
  const kwList = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!kwList.length) return [];

  // OR semantics: return FKs that mention ANY relevant table/column
  const tsqueryVal = kwList.join(' | ');

  const res = await appPool.query<{
    source_schema: string; source_table: string; source_column: string;
    target_schema: string; target_table: string; target_column: string;
    direction: string; hint_text: string; keywords: string;
  }>(
    `SELECT source_schema, source_table, source_column,
            target_schema, target_table, target_column,
            direction, hint_text, keywords
     FROM db_foreign_keys
     WHERE connection_id = $1
       AND keywords @@ to_tsquery('simple', $2)
     ORDER BY ts_rank(to_tsvector('simple', keywords), to_tsquery('simple', $2)) DESC
     LIMIT $3`,
    [connectionId, tsqueryVal, topK]
  );

  return res.rows.map(r => ({
    sourceSchema: r.source_schema,
    sourceTable: r.source_table,
    sourceColumn: r.source_column,
    targetSchema: r.target_schema,
    targetTable: r.target_table,
    targetColumn: r.target_column,
    direction: r.direction,
    hintText: r.hint_text,
    keywords: r.keywords,
  }));
}

/**
 * Get all FKs between selected tables (no keyword needed).
 * Finds: FKs where both source AND target are in selectedTables.
 */
export async function getFKsBetweenTables(
  selectedTables: Array<{ schema: string; table: string }>,
  connectionId: number,
): Promise<FKRelation[]> {
  if (!selectedTables.length) return [];

  const tableSet = new Set(
    selectedTables.map(t => `${t.schema}.${t.table}`)
  );

  const res = await appPool.query<{
    source_schema: string; source_table: string; source_column: string;
    target_schema: string; target_table: string; target_column: string;
    direction: string; hint_text: string; keywords: string;
  }>(
    `SELECT source_schema, source_table, source_column,
            target_schema, target_table, target_column,
            direction, hint_text, keywords
     FROM db_foreign_keys
     WHERE connection_id = $1
       AND (
         (source_schema || '.' || source_table) = ANY($2::text[])
         OR (target_schema || '.' || target_table) = ANY($2::text[])
       )
     LIMIT 50`,
    [connectionId, [...tableSet]]
  );

  return res.rows.map(r => ({
    sourceSchema: r.source_schema,
    sourceTable: r.source_table,
    sourceColumn: r.source_column,
    targetSchema: r.target_schema,
    targetTable: r.target_table,
    targetColumn: r.target_column,
    direction: r.direction,
    hintText: r.hint_text,
    keywords: r.keywords,
  }));
}

// ─── Build FK context for LLM prompt ─────────────────────────────────────────

/**
 * Format FK hints as text for the SQL generation prompt.
 */
export function buildFKContext(fks: FKRelation[]): string {
  if (!fks.length) return "";
  const lines = fks.map(fk =>
    `  ${fk.hintText} [${fk.direction}]`
  );
  return "\n=== FOREIGN KEYS ===\n" + lines.join("\n") + "\n";
}
