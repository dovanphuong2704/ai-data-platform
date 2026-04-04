/**
 * seed-from-code-examples.ts
 *
 * Read extracted SQL examples from geocore-server and seed into Vanna RAG.
 * Usage: npx tsx src/scripts/seed-from-code-examples.ts --connection=2
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { embedText, toPgVector } from '../services/embeddings';

dotenv.config();

const CONN_ID = parseInt(
  process.argv.find(a => a.startsWith('--connection='))?.split('=')[1] ?? '0',
  10
);

const EXAMPLES: Array<{ question: string; sql: string }> = [
  {
    question: "danh sách điểm cháy hôm nay với tọa độ và thông tin lô rừng",
    sql: `SELECT
  fa.id, fa.detected_at, fa.source, fa.gemini_verify, fa.admin_verify,
  fa.district_name, fa.commune_name, fa.actor_name,
  ST_Y(fa.geom) AS latitude, ST_X(fa.geom) AS longitude,
  mp.forest_function_main_name, mp.compt_code, mp.plot_code
FROM fire.fire_alert fa
LEFT JOIN map.mv_plot mp ON fa.plot_uuid = mp.plot_uuid
WHERE fa.alerted_at = $1
  AND ($2::text IS NULL OR fa.source = $2::text)
ORDER BY fa.id DESC`,
  },
  {
    question: "danh sách điểm biến động trong khoảng thời gian với thông tin xác minh",
    sql: `WITH latest_verification AS (
  SELECT DISTINCT ON (detect_id)
    detect_id, cause_id, verified_at, verified_by, verified_area, note, device_type_id
  FROM detect.verification
  ORDER BY detect_id, verified_at DESC
)
SELECT
  d.id, d.year, d.period_id, d.area, d.metadata,
  ST_AsGeoJSON(d.geom) AS geom,
  d.district_name, d.commune_name, d.compt_code, d.plot_code,
  d.actor_name, d.forest_func_def, d.forest_org_def, d.forest_type_def,
  d.type,
  lv.verified_at, lv.verified_area, lv.note,
  dt.name AS device_type_name,
  c.name AS cause_name,
  u.fullname AS verified_by_fullname
FROM detect.detect d
LEFT JOIN detect.period p ON d.period_id = p.id
LEFT JOIN latest_verification lv ON d.id = lv.detect_id
LEFT JOIN detect.cause c ON lv.cause_id = c.id
LEFT JOIN "user"."user" u ON lv.verified_by = u.id
LEFT JOIN core.device_type dt ON lv.device_type_id = dt.id
WHERE (to_date(CONCAT(p.date_start, '/', d.year), 'DD/MM/YYYY') BETWEEN $1 AND $2
   OR to_date(CONCAT(p.date_end, '/', d.year), 'DD/MM/YYYY') BETWEEN $1 AND $2)
  AND d.type = $3
ORDER BY d.id DESC`,
  },
  {
    question: "thống kê điểm biến động theo chức năng rừng",
    sql: `WITH cte_verification AS (
  SELECT detect_id, 1 AS is_verified
  FROM detect.verification
  GROUP BY detect_id
)
SELECT
  ffm.forest_function_main_code,
  ffm.forest_function_main_name,
  COUNT(*)::int AS count_total,
  COUNT(cte_verification.is_verified) AS count_verified,
  (COUNT(*)::int - COUNT(cte_verification.is_verified)) AS count_unverified,
  SUM(detect.area) AS sum_area_total,
  COALESCE(SUM(detect.area) FILTER (WHERE cte_verification.is_verified = 1), 0) AS sum_area_verified,
  COALESCE(SUM(detect.area) FILTER (WHERE cte_verification.is_verified IS NULL), 0) AS sum_area_unverified
FROM detect.detect
JOIN map.mv_plot plot ON detect.plot_uuid = plot.plot_uuid
LEFT JOIN cte_verification ON cte_verification.detect_id = detect.id
LEFT JOIN core.forest_function_main ffm ON ffm.forest_function_main_code = plot.forest_function_main_code
WHERE detect.year = $1 AND detect.period_id = $2
GROUP BY ffm.forest_function_main_code, ffm.forest_function_main_name
ORDER BY ffm.forest_function_main_code`,
  },
  {
    question: "tìm lô rừng giao nhau với vùng phát hiện cháy",
    sql: `SELECT *,
  ST_Area(ST_Intersection(geom, ST_GeomFromText($1, 4326))) AS intersection_area
FROM map.mv_plot
WHERE ST_Intersects(geom, ST_GeomFromText($1, 4326))
  AND ST_Area(ST_Intersection(geom, ST_GeomFromText($1, 4326))) > 0
ORDER BY intersection_area DESC
LIMIT 1`,
  },
  {
    question: "thống kê điểm cháy theo huyện trong tháng",
    sql: `SELECT
  fa.district_name,
  COUNT(*) AS so_diem_chay,
  COUNT(*) FILTER (WHERE fa.source = 'CAMERA') AS tu_camera,
  COUNT(*) FILTER (WHERE fa.source = 'SATELLITE') AS tu_ve_tinh,
  COUNT(*) FILTER (WHERE fa.gemini_verify = TRUE) AS da_xac_minh_ai,
  COUNT(*) FILTER (WHERE fa.admin_verify = TRUE) AS da_xac_minh_admin,
  COUNT(*) FILTER (WHERE fa.gemini_verify IS NULL) AS chua_xac_minh
FROM fire.fire_alert fa
WHERE fa.alerted_at >= DATE_TRUNC('month', CURRENT_DATE)
  AND fa.alerted_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
GROUP BY fa.district_name
ORDER BY so_diem_chay DESC`,
  },
  {
    question: "lấy ảnh điểm cháy từ camera cùng thông tin người xác minh",
    sql: `SELECT
  fa.id, fa.detected_at, fa.source, fa.metadata,
  cf.path AS image_url,
  u.fullname AS verified_by,
  fv.verified_at, fv.cause_id, fc.name AS cause_name
FROM fire.fire_alert fa
LEFT JOIN fire.fire_alert_photo fap ON fap.fire_alert_id = fa.id
LEFT JOIN core_file.file cf ON fap.file_id = cf.id
LEFT JOIN fire.fire_alert_verification fv ON fv.fire_alert_id = fa.id
LEFT JOIN fire.fire_alert_cause fc ON fv.cause_id = fc.id
LEFT JOIN "user"."user" u ON fv.verified_by = u.id
WHERE fa.source = 'CAMERA'
ORDER BY fa.detected_at DESC`,
  },
  {
    question: "camera nào phát hiện nhiều điểm cháy nhất tuần qua",
    sql: `SELECT
  c.name AS camera_name,
  c.devicename,
  COUNT(fa.id) AS so_diem_chay,
  COUNT(fa.id) FILTER (WHERE fa.gemini_verify = TRUE) AS chap_nhan_ai,
  COUNT(fa.id) FILTER (WHERE fa.admin_verify = TRUE) AS chap_nhan_admin
FROM fire.fire_alert fa
JOIN "user"."user" u ON u.id = fa.actor_id
JOIN camera.camera c ON c.manage_user_id = u.id
WHERE fa.source = 'CAMERA'
  AND fa.detected_at >= NOW() - INTERVAL '1 week'
GROUP BY c.id, c.name, c.devicename
ORDER BY so_diem_chay DESC`,
  },
  {
    question: "số điểm biến động chưa xác minh theo xã",
    sql: `WITH latest_verification AS (
  SELECT DISTINCT ON (detect_id)
    detect_id, cause_id, verified_at
  FROM detect.verification
  ORDER BY detect_id, verified_at DESC
)
SELECT
  d.commune_name,
  d.district_name,
  COUNT(*) AS tong_so_diem,
  COUNT(*) FILTER (WHERE lv.verified_at IS NULL) AS chua_xac_minh,
  COUNT(*) FILTER (WHERE lv.verified_at IS NOT NULL) AS da_xac_minh,
  SUM(d.area) AS tong_dien_tich
FROM detect.detect d
LEFT JOIN latest_verification lv ON d.id = lv.detect_id
WHERE d.district_code = $1
  AND d.type = 'MR'
GROUP BY d.commune_name, d.district_name
ORDER BY tong_so_diem DESC`,
  },
  {
    question: "xu hướng điểm cháy theo tuần trong năm",
    sql: `SELECT
  DATE_TRUNC('week', fa.detected_at) AS tuan,
  COUNT(*) AS tong_so_diem,
  COUNT(*) FILTER (WHERE fa.source = 'CAMERA') AS tu_camera,
  COUNT(*) FILTER (WHERE fa.source = 'SATELLITE') AS tu_ve_tinh,
  COUNT(*) FILTER (WHERE fa.source = 'CITIZEN') AS tu_nguoi_dan,
  COUNT(*) FILTER (WHERE fa.gemini_verify = TRUE) AS chap_nhan_ai
FROM fire.fire_alert fa
WHERE fa.detected_at >= DATE_TRUNC('year', CURRENT_DATE)
GROUP BY DATE_TRUNC('week', fa.detected_at)
ORDER BY tuan`,
  },
  {
    question: "điểm cháy trong bán kính 5km từ tọa độ",
    sql: `SELECT
  fa.id, fa.detected_at, fa.source,
  fa.district_name, fa.commune_name,
  ST_Y(fa.geom) AS latitude, ST_X(fa.geom) AS longitude,
  ST_Distance(fa.geom::geography, ST_MakePoint($1, $2)::geography) AS khoang_cach_m
FROM fire.fire_alert fa
WHERE fa.geom IS NOT NULL
  AND ST_DWithin(fa.geom::geography, ST_MakePoint($1, $2)::geography, $3)
  AND fa.detected_at >= NOW() - INTERVAL '1 month'
ORDER BY fa.detected_at DESC`,
  },
  {
    question: "tổng diện tích cháy theo loại rừng đã xác minh",
    sql: `SELECT
  fa.forest_type_def AS loai_rung,
  fa.forest_func_def AS chuc_nang_rung,
  COUNT(*) AS so_diem,
  SUM(fv.burned_area) AS tong_dien_tich_chay,
  AVG(fv.burned_area) AS dien_tich_trung_binh
FROM fire.fire_alert fa
JOIN fire.fire_alert_verification fv ON fv.fire_alert_id = fa.id
WHERE fa.detected_at >= NOW() - INTERVAL '3 months'
  AND fa.gemini_verify = TRUE
  AND fv.burned_area IS NOT NULL
GROUP BY fa.forest_type_def, fa.forest_func_def
ORDER BY tong_dien_tich_chay DESC`,
  },
  {
    question: "thống kê điểm biến động theo nguyên nhân xác minh",
    sql: `WITH latest_verification AS (
  SELECT DISTINCT ON (detect_id)
    detect_id, cause_id, verified_at
  FROM detect.verification
  ORDER BY detect_id, verified_at DESC
)
SELECT
  c.name AS nguyen_nhan,
  COUNT(*) AS so_diem,
  SUM(d.area) AS tong_dien_tich,
  COUNT(*) FILTER (WHERE lv.verified_at IS NULL) AS chua_xac_minh
FROM detect.detect d
LEFT JOIN latest_verification lv ON d.id = lv.detect_id
LEFT JOIN detect.cause c ON lv.cause_id = c.id
WHERE d.year = $1 AND d.period_id = $2
GROUP BY c.id, c.name
HAVING c.id IS NOT NULL
ORDER BY so_diem DESC`,
  },
  {
    question: "lấy thông tin huyện xã của một user",
    sql: `SELECT
  ua.district_code, ua.commune_code,
  d.name AS district_name, c.name AS commune_name
FROM core.unit_administrative ua
JOIN core.district d ON ua.district_code = d.code
LEFT JOIN core.commune c ON ua.commune_code = c.code
WHERE ua.user_id = $1`,
  },
  {
    question: "thống kê điểm phát hiện từ vệ tinh trong kỳ",
    sql: `WITH cte_verification AS (
  SELECT detect_id, 1 AS is_verified
  FROM detect.verification
  GROUP BY detect_id
)
SELECT
  COUNT(*)::int AS count_total,
  COUNT(cte_verification.is_verified) AS count_verified,
  (COUNT(*)::int - COUNT(cte_verification.is_verified)) AS count_unverified,
  SUM(detect.area) AS sum_area_total
FROM detect.detect
JOIN map.mv_plot plot ON detect.plot_uuid = plot.plot_uuid
LEFT JOIN cte_verification ON cte_verification.detect_id = detect.id
WHERE detect.year = $1
  AND detect.period_id = $2
  AND detect.type = 'SL'`,
  },
  {
    question: "lấy ảnh fire alert từ camera",
    sql: `SELECT
  fa.id AS fire_alert_id,
  fa.detected_at,
  fa.metadata,
  cf.path AS image_url,
  c.name AS camera_name,
  c.devicename,
  fa.district_name,
  fa.commune_name
FROM fire.fire_alert fa
JOIN fire.fire_alert_photo fap ON fap.fire_alert_id = fa.id
JOIN core_file.file cf ON fap.file_id = cf.id
JOIN "user"."user" u ON u.id = fa.actor_id
JOIN camera.camera c ON c.manage_user_id = u.id
WHERE fa.source IN ('CAMERA', 'CITIZEN')
  AND fa.deleted_at IS NULL
ORDER BY fa.detected_at DESC
LIMIT 20`,
  },
];

async function main() {
  if (!CONN_ID) {
    console.error('Usage: npx tsx src/scripts/seed-from-code-examples.ts --connection=<id>');
    process.exit(1);
  }

  const appPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });

  const keyRow = await appPool.query(
    `SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
  );
  if (!keyRow.rows.length) {
    console.error('No API key found');
    await appPool.end();
    return;
  }
  const { api_key: apiKey } = keyRow.rows[0] as { api_key: string; provider: string };

  console.log(`Seeding ${EXAMPLES.length} code examples for conn ${CONN_ID}...\n`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < EXAMPLES.length; i++) {
    const ex = EXAMPLES[i];
    process.stdout.write(`[${i + 1}/${EXAMPLES.length}] ${ex.question}... `);

    try {
      const vec = toPgVector(await embedText(ex.question, apiKey));
      const result = await appPool.query(
        `INSERT INTO vanna_training_data (connection_id, question_vi, sql, embedding, source)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [CONN_ID, ex.question, ex.sql.trim(), vec, 'code']
      );

      if (result.rows.length > 0) {
        inserted++;
        console.log('✅');
      } else {
        skipped++;
        console.log('⏭ already exists');
      }
    } catch (e) {
      errors++;
      console.log(`❌ ${e}`);
    }

    // Rate limit
    if (i < EXAMPLES.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
  await appPool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
