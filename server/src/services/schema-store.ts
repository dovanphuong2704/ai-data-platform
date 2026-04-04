/**
 * schema-store.ts — Persistent schema snapshot storage
 *
 * Pre-caches parsed schema (EnrichedSchema) + pre-built description text
 * in the app DB to avoid fetching from the target DB on every request.
 *
 * Two-tier cache:
 *   1. In-memory Map  → fast, per-process, TTL 30min
 *   2. App DB         → persistent, survives restarts
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { appPool } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SchemaColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  description?: string;
  sample_values?: string[];
}

interface FKInfo {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

// ─── Infer Logical FKs from Naming Convention ──────────────────────────────────────

/**
 * Infer logical FKs from naming convention.
 *
 * Luật:
 *   - Column {prefix}_code hoặc {prefix}_id → tìm bảng có tên chứa {prefix}
 *     và có column = {prefix}_code hoặc column là PK
 *   - VD: plot.tree_spec_code → tree_specie.tree_spec_code
 *
 * Heuristic patterns:
 *   {table}_id          → {table}.id (hoặc {table}.{table}_id)
 *   {prefix}_code       → {prefix}.{prefix}_code (hoặc {prefix}_table.{prefix}_code)
 *   {prefix}_name       → bảng tên tương ứng
 */
export function inferLogicalFKs(columns: SchemaColumn[]): FKInfo[] {
  const fks: FKInfo[] = [];
  const seen = new Set<string>();

  // Build index: table → its PK columns + all columns
  const tableInfo: Record<string, {
    schema: string;
    table: string;
    pkColumns: Set<string>;
    allColumns: Set<string>;
  }> = {};

  for (const col of columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableInfo[key]) {
      tableInfo[key] = { schema: col.table_schema, table: col.table_name, pkColumns: new Set(), allColumns: new Set() };
    }
    tableInfo[key].allColumns.add(col.column_name.toLowerCase());
  }

  // Detect PK columns
  for (const [key, info] of Object.entries(tableInfo)) {
    const tableLower = info.table.toLowerCase();
    if (info.allColumns.has('id')) info.pkColumns.add('id');
    const selfIdCol = `${tableLower}_id`;
    if (info.allColumns.has(selfIdCol)) info.pkColumns.add(selfIdCol);

    // Natural key: {prefix}_code column in a {prefix}_specie/thing table
    // e.g. tree_specie.tree_spec_code is the natural PK
    for (const col of info.allColumns) {
      if (col.endsWith('_code')) {
        const prefix = col.replace(/_code$/, '');
        // Check if this table name starts with or contains the prefix
        if (tableLower.startsWith(prefix) || tableLower.includes(prefix)) {
          info.pkColumns.add(col);
        }
      }
    }
  }

  // For each column in each table, try to infer FK
  for (const col of columns) {
    const srcKey = `${col.table_schema}.${col.table_name}`;
    const srcTable = tableInfo[srcKey];
    const colName = col.column_name.toLowerCase();

    // Skip if this column is its own table's PK
    if (srcTable.pkColumns.has(colName)) continue;

    // Pattern 1: {prefix}_code → find table named {prefix} or {prefix}_specie/thing
    const codeMatch = colName.match(/^(.+)_code$/);
    // Pattern 2: {prefix}_id → find table named {prefix}
    const idMatch = !codeMatch ? colName.match(/^(.+)_id$/) : null;

    const prefix = codeMatch?.[1] ?? idMatch?.[1];
    if (!prefix) continue;

    // Search for target table: exact/prefix/substring match
    const candidates = Object.entries(tableInfo).filter(([key]) => {
      const info = key.split('.')[1]?.toLowerCase() ?? '';
      return info === prefix
        || info.startsWith(prefix + '_')
        || info.endsWith('_' + prefix)
        || info.includes(prefix)          // tree_specie contains tree_spec
        || prefix.includes(info);       // plot.tree_spec_code → tree_specie (spec contains spec)
    });

    for (const [tgtKey, tgtInfo] of candidates) {
      // Skip self-reference
      if (tgtKey === srcKey) continue;

      // Find matching PK column: try {prefix}_code, id, {table}_id
      const tgtPrefix = tgtInfo.table.toLowerCase();
      const pkCandidates = [
        `${prefix}_code`,
        'id',
        `${tgtPrefix}_id`,
      ];

      let targetCol: string | null = null;
      for (const pk of pkCandidates) {
        if (tgtInfo.allColumns.has(pk)) {
          targetCol = pk;
          break;
        }
      }
      if (!targetCol) continue;

      const fkKey = `${col.table_schema}.${col.table_name}.${col.column_name}->${tgtInfo.schema}.${tgtInfo.table}.${targetCol}`;
      if (seen.has(fkKey)) continue;
      seen.add(fkKey);

      fks.push({
        table_schema: col.table_schema,
        table_name: col.table_name,
        column_name: col.column_name,
        foreign_table_schema: tgtInfo.schema,
        foreign_table_name: tgtInfo.table,
        foreign_column_name: targetCol,
      });
    }
  }

  return fks;
}

export interface EnrichedSchema {
  columns: SchemaColumn[];
  foreignKeys: FKInfo[];
}

interface SchemaSnapshot {
  connection_id: number;
  schema_json: EnrichedSchema;
  schema_text: string;
  table_count: number;
  column_count: number;
  version_hash: string;
  updated_at: Date;
}

// ─── In-memory cache ───────────────────────────────────────────────────────────

const memCache = new Map<string, { data: EnrichedSchema; text: string; ts: number }>();
const SCHEMA_TTL_MS = 30 * 60 * 1000; // 30 minutes

function memGet(key: string): { schema: EnrichedSchema; text: string } | null {
  const entry = memCache.get(key);
  if (entry && Date.now() - entry.ts < SCHEMA_TTL_MS) {
    return { schema: entry.data, text: entry.text };
  }
  return null;
}

function memSet(key: string, schema: EnrichedSchema, text: string): void {
  memCache.set(key, { data: schema, text, ts: Date.now() });
}

function memDelete(key: string): void {
  memCache.delete(key);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Compute a short fingerprint from column + FK list to detect schema changes */
function computeHash(columns: SchemaColumn[], foreignKeys: FKInfo[]): string {
  const parts: string[] = [];
  for (const c of columns) {
    parts.push(`${c.table_schema}.${c.table_name}.${c.column_name}:${c.data_type}`);
  }
  for (const fk of foreignKeys) {
    parts.push(`fk:${fk.table_schema}.${fk.table_name}.${fk.column_name}->${fk.foreign_table_schema}.${fk.foreign_table_name}`);
  }
  return createHash('md5').update(parts.join('|')).digest('hex');
}

// ─── Schema Text Builder (same logic as chat.ts buildFocusedSchemaDescription) ──

interface SchemaTableEntry {
  table_schema: string;
  table_name: string;
  columns: { column_name: string; data_type: string; description?: string }[];
  foreignKeys: { column_name: string; fk: string }[];
}

export function buildFocusedSchemaText(
  selectedTables: SchemaTableEntry[],
  allTables: SchemaTableEntry[],
  userQuestion: string,
): string {
  const lines: string[] = [];

  const schemas = [...new Set(selectedTables.map(t => t.table_schema))];
  lines.push(`Các SCHEMA được sử dụng: ${schemas.join(', ')}`);
  lines.push('');

  for (const table of selectedTables) {
    const fkList = table.foreignKeys
      .map(fk => `  FK: ${table.table_schema}.${table.table_name}.${fk.column_name} → ${fk.fk}`)
      .join('\n');

    const colList = table.columns
      .map(c => {
        const desc = c.description ? ` — ${c.description}` : '';
        return `  - ${c.column_name} (${c.data_type})${desc}`;
      })
      .join('\n');

    lines.push(`${table.table_schema}.${table.table_name}:`);
    if (fkList) lines.push(fkList);
    lines.push(colList);
    lines.push('');
  }

  const allSchemas = [...new Set(allTables.map(t => t.table_schema))];
  lines.push('TẤT CẢ SCHEMA TRONG DATABASE: ' + allSchemas.join(', '));
  lines.push('');
  lines.push('CÂU HỎI CỦA USER: ' + userQuestion);

  return lines.join('\n');
}

/** Build a focused schema text from any EnrichedSchema */
export function buildSchemaTextFromEnriched(
  enriched: EnrichedSchema,
  userQuestion: string,
): string {
  // Group columns by table
  const tableCols: Record<string, SchemaColumn[]> = {};
  for (const col of enriched.columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableCols[key]) tableCols[key] = [];
    tableCols[key].push(col);
  }

  // Group FKs by table
  const tableFKs: Record<string, FKInfo[]> = {};
  for (const fk of enriched.foreignKeys) {
    const key = `${fk.table_schema}.${fk.table_name}`;
    if (!tableFKs[key]) tableFKs[key] = [];
    tableFKs[key].push(fk);
  }

  const entries: SchemaTableEntry[] = [];
  for (const [fullTable, cols] of Object.entries(tableCols)) {
    const [schema, table] = fullTable.split('.');
    const fks = tableFKs[fullTable] ?? [];
    entries.push({
      table_schema: schema,
      table_name: table,
      columns: cols.map(c => ({ column_name: c.column_name, data_type: c.data_type, description: c.description })),
      foreignKeys: fks.map(fk => ({
        column_name: fk.column_name,
        fk: `${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`,
      })),
    });
  }

  return buildFocusedSchemaText(entries, entries, userQuestion);
}

// ─── Snapshot CRUD ─────────────────────────────────────────────────────────────

/**
 * Get a schema snapshot from DB.
 * Returns null if not found.
 */
export async function getSchemaSnapshot(connectionId: number): Promise<SchemaSnapshot | null> {
  const result = await appPool.query(
    `SELECT connection_id, schema_json, schema_text, table_count, column_count,
            version_hash, updated_at
     FROM db_schema_snapshots WHERE connection_id = $1`,
    [connectionId]
  );

  if (!result.rows.length) return null;

  const row = result.rows[0] as {
    connection_id: number;
    schema_json: EnrichedSchema;
    schema_text: string;
    table_count: number;
    column_count: number;
    version_hash: string;
    updated_at: Date;
  };

  return {
    connection_id: row.connection_id,
    schema_json: row.schema_json,
    schema_text: row.schema_text,
    table_count: row.table_count,
    column_count: row.column_count,
    version_hash: row.version_hash,
    updated_at: row.updated_at,
  };
}

/**
 * Save (upsert) a schema snapshot to DB.
 * Returns the saved snapshot.
 */
export async function saveSchemaSnapshot(
  connectionId: number,
  schema: EnrichedSchema,
  schemaText: string,
): Promise<SchemaSnapshot> {
  const hash = computeHash(schema.columns, schema.foreignKeys);
  const tableCount = new Set(schema.columns.map(c => `${c.table_schema}.${c.table_name}`)).size;

  const result = await appPool.query(
    `INSERT INTO db_schema_snapshots
       (connection_id, schema_json, schema_text, table_count, column_count, version_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (connection_id) DO UPDATE SET
       schema_json   = EXCLUDED.schema_json,
       schema_text   = EXCLUDED.schema_text,
       table_count   = EXCLUDED.table_count,
       column_count  = EXCLUDED.column_count,
       version_hash  = EXCLUDED.version_hash,
       updated_at    = NOW()
     RETURNING connection_id, schema_json, schema_text, table_count, column_count, version_hash, updated_at`,
    [connectionId, JSON.stringify(schema), schemaText, tableCount, schema.columns.length, hash]
  );

  const row = result.rows[0] as {
    connection_id: number; schema_json: EnrichedSchema; schema_text: string;
    table_count: number; column_count: number; version_hash: string; updated_at: Date;
  };

  // Update in-memory cache
  const cacheKey = `conn:${connectionId}`;
  memSet(cacheKey, schema, schemaText);

  return {
    connection_id: row.connection_id,
    schema_json: row.schema_json,
    schema_text: row.schema_text,
    table_count: row.table_count,
    column_count: row.column_count,
    version_hash: row.version_hash,
    updated_at: row.updated_at,
  };
}

/**
 * Delete a schema snapshot.
 */
export async function deleteSchemaSnapshot(connectionId: number): Promise<void> {
  await appPool.query(`DELETE FROM db_schema_snapshots WHERE connection_id = $1`, [connectionId]);
  memDelete(`conn:${connectionId}`);
}

/**
 * List all snapshots.
 */
export async function listSchemaSnapshots(): Promise<SchemaSnapshot[]> {
  const result = await appPool.query(
    `SELECT connection_id, schema_json, schema_text, table_count, column_count,
            version_hash, updated_at
     FROM db_schema_snapshots ORDER BY updated_at DESC`
  );
  return result.rows as SchemaSnapshot[];
}

/**
 * Get cached schema + text from memory or DB.
 * Returns null if no snapshot available.
 *
 * @param connectionId  - The DB connection ID
 * @param userQuestion  - User's question (used to build focused description)
 * @param fresh         - If true, skip in-memory cache
 */
export async function getCachedSchemaWithText(
  connectionId: number,
  userQuestion: string,
  fresh = false,
): Promise<{ schema: EnrichedSchema; text: string } | null> {
  const cacheKey = `conn:${connectionId}`;

  // 1. Check in-memory cache
  if (!fresh) {
    const memEntry = memGet(cacheKey);
    if (memEntry) return memEntry;
  }

  // 2. Check app DB
  const snapshot = await getSchemaSnapshot(connectionId);
  if (!snapshot) return null;

  // Check TTL (30 min) — stale snapshots are still usable
  const age = Date.now() - snapshot.updated_at.getTime();
  if (age > SCHEMA_TTL_MS) {
    // Stale — return but mark for refresh
    memSet(cacheKey, snapshot.schema_json, snapshot.schema_text);
    return { schema: snapshot.schema_json, text: snapshot.schema_text };
  }

  memSet(cacheKey, snapshot.schema_json, snapshot.schema_text);
  return { schema: snapshot.schema_json, text: snapshot.schema_text };
}

/**
 * Check if a snapshot needs refresh (schema changed on target DB).
 */
export async function needsRefresh(connectionId: number, pool: Pool): Promise<boolean> {
  const snapshot = await getSchemaSnapshot(connectionId);
  if (!snapshot) return true;

  // Fetch current hash from target DB
  const colResult = await pool.query<SchemaColumn>(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
    LIMIT 500
  `);

  const fkResult = await pool.query<FKInfo>(`
    SELECT tc.table_schema, tc.table_name, kcu.column_name,
           ccu.table_schema AS foreign_table_schema,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  `);

  const currentHash = computeHash(colResult.rows, fkResult.rows);
  return currentHash !== snapshot.version_hash;
}

/**
 * Fetch DDL for specific tables from the cached schema_json snapshot.
 * This avoids querying the target DB — uses the already-cached schema.
 */
export async function getTableDDL(
  connectionId: number,
  tables: { schema: string; name: string }[],
): Promise<EnrichedSchema> {
  if (!tables.length) return { columns: [], foreignKeys: [] };

  const snapshot = await getSchemaSnapshot(connectionId);
  if (!snapshot) return { columns: [], foreignKeys: [] };

  const { columns, foreignKeys } = snapshot.schema_json;

  const filteredCols = columns.filter(c =>
    tables.some(t => t.schema === c.table_schema && t.name === c.table_name)
  );
  const filteredFKs = foreignKeys.filter(fk =>
    tables.some(t => t.schema === fk.table_schema && t.name === fk.table_name)
  );

  return { columns: filteredCols, foreignKeys: filteredFKs };
}

/**
 * Build focused schema text from specific tables + their FKs.
 * Much smaller than full schema — only the tables we need.
 */
export function buildFocusedSchemaFromTables(
  tables: Array<{ table_schema: string; table_name: string; summary_text: string; column_list: string; fk_hint: string }>,
): string {
  if (!tables.length) return '';

  const lines: string[] = [];
  const schemas = [...new Set(tables.map(t => t.table_schema))];
  lines.push(`Cac SCHEMA: ${schemas.join(', ')}`);
  lines.push('');

  for (const t of tables) {
    lines.push(`${t.table_schema}.${t.table_name}:`);
    if (t.fk_hint) lines.push(`  FK: ${t.fk_hint}`);
    lines.push(`  Columns: ${t.column_list}`);
    if (t.summary_text) lines.push(`  Mo ta: ${t.summary_text}`);
    lines.push('');
  }

  return lines.join('\n');
}

