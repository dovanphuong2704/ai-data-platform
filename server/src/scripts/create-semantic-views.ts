/**
 * create-semantic-views.ts
 * Creates SQL VIEWs in target DB to pre-join frequently accessed table chains.
 * LLM only queries 1 view instead of JOINing 3-4 tables.
 * Run: npx tsx src/scripts/create-semantic-views.ts --connection=<id>
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const rawArg = process.argv.find(a => a.startsWith('--connection='));
const CONN_ID = parseInt(rawArg ? rawArg.split('=')[1] : '0', 10);

interface ViewDef {
  name: string;
  sql: string;
}

// Helper: add code-warning comment to each _code column in a CREATE VIEW statement
function addCodeWarnings(sql: string): string {
  return sql;
}

const VIEWS: ViewDef[] = [
  {
    name: 'vw_fire_alert_verified',
    sql: `CREATE OR REPLACE VIEW app.vw_fire_alert_verified AS
SELECT
  fa.id,
  fa.source,
  fa.detected_at,
  fa.alerted_at,
  fa.district_name,
  fa.commune_name,
  fa.actor_id,
  fa.actor_name,
  fa.province_name,
  fa.forest_func_def,
  fa.forest_type_def,
  fa.gemini_verify,
  fa.admin_verify,
  v.burned_area,
  v.cause_name,
  v.verified_by_user,
  v.verified_at,
  v.note
FROM fire.fire_alert fa
LEFT JOIN LATERAL (
  SELECT
    fv.fire_alert_id,
    fc.name AS cause_name,
    u.fullname AS verified_by_user,
    fv.burned_area,
    fv.verified_at,
    fv.note
  FROM fire.fire_alert_verification fv
  LEFT JOIN fire.fire_alert_cause fc ON fc.id = fv.cause_id
  LEFT JOIN "user"."user" u ON u.id = fv.verified_by
  WHERE fv.fire_alert_id = fa.id
  ORDER BY fv.verified_at DESC NULLS LAST
  LIMIT 1
) v ON v.fire_alert_id = fa.id`,
  },

  {
    name: 'vw_detect_verified',
    sql: `CREATE OR REPLACE VIEW app.vw_detect_verified AS
SELECT
  d.id,
  d.year,
  d.period_id,
  d.area,
  d.commune_code,
  d.district_code,
  d.actor_id,
  d.actor_name,
  d.forest_func_def,
  d.forest_type_def,
  d.type AS detect_type,
  d.metadata,
  v.cause_name,
  v.verified_by_user,
  v.verified_at,
  v.verified_area,
  v.note
FROM detect.detect d
LEFT JOIN LATERAL (
  SELECT
    ver.detect_id,
    c.name AS cause_name,
    u.fullname AS verified_by_user,
    ver.verified_area,
    ver.verified_at,
    ver.note
  FROM detect.verification ver
  LEFT JOIN detect.cause c ON c.id = ver.cause_id
  LEFT JOIN "user"."user" u ON u.id = ver.verified_by
  WHERE ver.detect_id = d.id
  ORDER BY ver.verified_at DESC NULLS LAST
  LIMIT 1
) v ON v.detect_id = d.id`,
  },

  {
    name: 'vw_camera_owner',
    sql: `CREATE OR REPLACE VIEW app.vw_camera_owner AS
SELECT
  cam.id AS camera_id,
  cam.name AS camera_name,
  cam.devicename,
  cam.camera_type,
  cam.latitude,
  cam.longitude,
  u.id AS user_id,
  u.username,
  u.fullname,
  u.organization
FROM camera.camera cam
LEFT JOIN "user"."user" u ON u.id = cam.manage_user_id`,
  },

  // ── Cách 3: Pre-joined analytics view cho core.plot ────────────────────────
  // Thay vì bắt LLM tự JOIN 3-4 bảng danh mục,
  // cung cấp sẵn view đã JOIN tất cả tên + mã +o một chỗ
  {
    name: 'vw_plot_analytics',
    sql: `CREATE OR REPLACE VIEW app.vw_plot_analytics AS
SELECT
  p.id,
  p.commune_code,
  p.tree_spec_code,
  p.forest_org_code,
  p.forest_type_code,
  p.area,
  p.year,
  -- Tên thay vì mã (LLM sẽ lọc trên các cột này)
  c.name         AS commune_name,
  ts.name        AS tree_name,
  ts.name_latin  AS tree_latin_name,
  fo.name        AS forest_org_name,
  ft.name        AS forest_type_name
FROM core.plot p
LEFT JOIN core.commune      c  ON p.commune_code      = c.commune_code
LEFT JOIN core.tree_specie ts ON p.tree_spec_code    = ts.tree_spec_code
LEFT JOIN core.forest_origin fo ON p.forest_org_code  = fo.forest_org_code
LEFT JOIN core.forest_type  ft ON p.forest_type_code  = ft.forest_type_code`,
  },
];

async function main() {
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const conn = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1`,
    [CONN_ID]
  );
  if (!conn.rows.length) {
    console.error('Connection not found:', CONN_ID);
    await appPool.end();
    return;
  }
  const { db_host, db_port, db_name, db_user, db_password } = conn.rows[0] as any;

  const pool = new Pool({
    connectionString: `postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}`,
  });

  console.log(`Creating ${VIEWS.length} semantic views on ${db_host}/${db_name}\n`);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS app`);

  // Force DROP existing views (CREATE OR REPLACE fails when column list changes)
  for (const v of VIEWS) {
    try { await pool.query(`DROP VIEW IF EXISTS app."${v.name}"`); } catch {}
  }

  let ok = 0, fail = 0;
  for (const v of VIEWS) {
    process.stdout.write(`  ${v.name}... `);
    try {
      await pool.query(v.sql);
      console.log('OK');
      ok++;
    } catch (e: any) {
      console.log('FAIL:', e?.message?.slice(0, 80));
      fail++;
    }
  }
  console.log(`\n${ok} created, ${fail} failed`);
  await pool.end();
  await appPool.end();
}

main().catch(console.error);
