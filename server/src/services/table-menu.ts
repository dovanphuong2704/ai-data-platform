/**
 * table-menu.ts — Build + cache table menu (1-line description per table)
 *
 * Menu = danh sách 1 dòng mô tả cho mỗi bảng trong database.
 * Dùng làm input cho LLM Receptionist chọn bảng.
 *
 * Menu mẫu (242 bảng → ~10KB text):
 *   • ldlr.ldlr_data: dien_tich, nam, ma_loai, ma_dien_tinh [LDLR][TG]
 *   • district.district: ma_huyen, ten_huyen [HVCH]
 *   • camera.camera: device_id, ip, location, commune_id [CAM][GIS]
 */

import { Pool } from 'pg';
import { appPool } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TableMenuItem {
  schema: string;
  table: string;
  topic: string;      // Short tag: LDLR, HVCH, GIS, CAM, KQTT, TG, REF
  columns: string;    // All column names (no limit)
  fkHint: string;     // FK target summary
}

export interface TableMenu {
  connectionId: number;
  items: TableMenuItem[];
  totalTables: number;
  generatedAt: Date;
  versionHash: string;
}

// ─── Topic Detection ────────────────────────────────────────────────────────────

const TOPIC_PATTERNS: Array<[RegExp, string]> = [
  // Đơn vị hành chính
  [/province|district|commune|xa|huyen|tinh|phuong|ward|city|admin|dia_ban/, 'HVCH'],
  // Không gian / GIS
  [/geometry|geography|spatial|coordinate|point|polygon|linestring|lat|lon|lng|latitude|longitude|utm|epsg|srid|x_coord|y_coord|geom|st_/, 'GIS'],
  // Lớp phủ đất lâm nghiệp
  [/ldlr|land_cover|land_use|forest|vegetation|crop|tree|cover|burn|fire_area|dat_nong|dat_lam|dat_rung/, 'LDLR'],
  // Camera / Giám sát
  [/camera|monitor|capture|image|video|device|sensor|station|may_anh/, 'CAM'],
  // Khí tượng / Vệ tinh
  [/weather|climate|rain|temperature|humidity|wind|ndvi|satellite|raster|thoitiet|mua|nhietdo|doam/, 'KQTT'],
  // Thời gian
  [/year|month|day|date|ngay|thang|nam|quarter|season|gio|m gio/, 'TG'],
  // Nguồn gốc / Audit
  [/origin|source|lineage|parent|trace|track|history|audit|log|nguon|xuat_su|log/, 'LOG'],
  // Thống kê
  [/stat|summary|aggregate|report|index|indicator|metric|chi_so|tong_hop/, 'TK'],
];

function detectTopic(colNames: string, tableName: string): string {
  const text = `${tableName} ${colNames}`.toLowerCase();
  for (const [pattern, topic] of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic;
  }
  return 'DAT'; // Generic data
}

// ─── Build Menu from DB ────────────────────────────────────────────────────────

/**
 * Build menu for all tables in a target database.
 */
export async function buildTableMenuFromPool(pool: Pool): Promise<TableMenuItem[]> {
  // Fetch tables + ALL columns (no limit for summary quality)
  const tablesRes = await pool.query(`
    SELECT
      t.table_schema,
      t.table_name,
      c.column_name,
      c.data_type,
      tc.constraint_type
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = t.table_schema
      AND tc.table_name = t.table_name
      AND tc.table_catalog = c.table_catalog
      AND tc.constraint_type = 'FOREIGN KEY'
      AND c.column_name IN (
        SELECT kcu.column_name
        FROM information_schema.key_column_usage kcu
        WHERE kcu.table_schema = tc.table_schema
          AND kcu.table_name = tc.table_name
          AND kcu.constraint_name = tc.constraint_name
      )
    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'topology')
    ORDER BY t.table_schema, t.table_name, c.ordinal_position
  `);

  // Group columns by table
  const tableData: Record<string, {
    schema: string;
    table: string;
    columns: string[];
    dataTypes: Record<string, string>;
    fkTargets: string[];
  }> = {};

  for (const r of tablesRes.rows as Record<string, unknown>[]) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!tableData[key]) {
      tableData[key] = { schema: r.table_schema as string, table: r.table_name as string, columns: [], dataTypes: {}, fkTargets: [] };
    }
    const entry = tableData[key];

    // Add ALL columns (no limit - full schema is important for LLM accuracy)
    entry.columns.push(r.column_name as string);
    entry.dataTypes[r.column_name as string] = r.data_type as string;

    // Track FK references
    if (r.constraint_type === 'FOREIGN KEY') {
      entry.fkTargets.push(r.column_name as string);
    }
  }

  // Fetch FK targets
  const fksRes = await pool.query(`
    SELECT
      tc.table_schema, tc.table_name, kcu.column_name,
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
  for (const r of fksRes.rows as Record<string, unknown>[]) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!fkMap[key]) fkMap[key] = [];
    fkMap[key].push(`${r.column_name}→${r.ref_schema}.${r.ref_table}`);
  }

  // Build menu items
  const items: TableMenuItem[] = [];
  for (const entry of Object.values(tableData)) {
    const key = `${entry.schema}.${entry.table}`;
    const colNames = entry.columns.join(', ');
    const topic = detectTopic(colNames, entry.table);
    const fks = fkMap[key] ?? [];

    const fkHint = fks.length > 0
      ? `FK: ${fks.slice(0, 3).join(', ')}${fks.length > 3 ? '...' : ''}`
      : '';

    items.push({
      schema: entry.schema,
      table: entry.table,
      topic,
      columns: colNames,
      fkHint,
    });
  }

  return items;
}

// ─── Cache CRUD ────────────────────────────────────────────────────────────────

/**
 * Save or update table menu cache in app DB.
 */
export async function saveTableMenu(
  connectionId: number,
  items: TableMenuItem[],
): Promise<void> {
  const versionHash = items.reduce((h, i) =>
    h + i.schema + i.table, '').slice(0, 32);

  await appPool.query(
    `INSERT INTO db_table_menus (connection_id, menu_json, total_tables, generated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (connection_id) DO UPDATE SET
       menu_json     = EXCLUDED.menu_json,
       total_tables  = EXCLUDED.total_tables,
       generated_at  = NOW()
     RETURNING id`,
    [connectionId, JSON.stringify(items), items.length]
  );
}

/**
 * Get cached table menu from app DB.
 * Returns null if not found or stale.
 */
export async function getCachedTableMenu(
  connectionId: number,
  maxAgeMs = 24 * 60 * 60 * 1000, // 24 hours default
): Promise<TableMenuItem[] | null> {
  const result = await appPool.query(
    `SELECT menu_json, generated_at FROM db_table_menus WHERE connection_id = $1`,
    [connectionId]
  );

  if (!result.rows.length) return null;

  const row = result.rows[0] as { menu_json: TableMenuItem[]; generated_at: Date };
  const age = Date.now() - new Date(row.generated_at).getTime();

  if (age > maxAgeMs) {
    console.log(`[table-menu] Stale menu for conn ${connectionId} (age: ${(age / 3600000).toFixed(1)}h)`);
    return null; // Stale, caller should refresh
  }

  return row.menu_json;
}

/**
 * Invalidate cached menu (call after schema change).
 */
export async function invalidateTableMenu(connectionId: number): Promise<void> {
  await appPool.query(
    `DELETE FROM db_table_menus WHERE connection_id = $1`,
    [connectionId]
  );
}

// ─── Render for LLM ─────────────────────────────────────────────────────────────

/**
 * Render menu items as text for LLM Receptionist to read.
 * Format: "• schema.table: topic | cols | FK hint"
 */
export function renderMenuText(items: TableMenuItem[]): string {
  const lines = items.map(i => {
    const fk = i.fkHint ? ` | ${i.fkHint}` : '';
    return `• ${i.schema}.${i.table}: [${i.topic}] ${i.columns}${fk}`;
  });

  return [
    `=== DATABASE MENU (${items.length} tables) ===`,
    'Format: • schema.table: [TOPIC] col1, col2, ... | FK: col→schema.table',
    '',
    ...lines,
    '',
    'INSTRUCTIONS: Select 3-10 tables most relevant to the user question.',
  ].join('\n');
}

/**
 * Build focused DDL text for selected tables.
 */
export function buildFocusedDDL(
  items: TableMenuItem[],
  schemaJson: { columns: Array<{ table_schema: string; table_name: string; column_name: string; data_type: string; description?: string }>; foreignKeys: Array<{ table_schema: string; table_name: string; column_name: string; foreign_table_schema: string; foreign_table_name: string; foreign_column_name: string }> },
): string {
  const selected = new Set(items.map(i => `${i.schema}.${i.table}`));

  const cols = schemaJson.columns.filter(c =>
    selected.has(`${c.table_schema}.${c.table_name}`)
  );
  const fks = schemaJson.foreignKeys.filter(fk =>
    selected.has(`${fk.table_schema}.${fk.table_name}`)
  );

  // Group by table
  const byTable: Record<string, typeof cols> = {};
  for (const c of cols) {
    const k = `${c.table_schema}.${c.table_name}`;
    if (!byTable[k]) byTable[k] = [];
    byTable[k].push(c);
  }

  // Group FKs by table
  const fkByTable: Record<string, typeof fks> = {};
  for (const fk of fks) {
    const k = `${fk.table_schema}.${fk.table_name}`;
    if (!fkByTable[k]) fkByTable[k] = [];
    fkByTable[k].push(fk);
  }

  const lines: string[] = [];
  for (const [fullTable, tableCols] of Object.entries(byTable)) {
    const [schema, table] = fullTable.split('.');
    lines.push(`--- ${schema}.${table} ---`);

    const tableFks = fkByTable[fullTable] ?? [];
    for (const fk of tableFks) {
      lines.push(`  ${fk.column_name} → ${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name} (FK)`);
    }

    for (const c of tableCols) {
      const desc = c.description ? ` — ${c.description}` : '';
      const isFk = tableFks.some(fk => fk.column_name === c.column_name);
      const tag = isFk ? ' (FK)' : '';
      lines.push(`  - ${c.column_name} ${c.data_type}${tag}${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
