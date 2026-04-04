/**
 * seed-vanna-docs.ts
 * Seed business rules documentation for FMS Lai Chau
 * Run: npx tsx src/scripts/seed-vanna-docs.ts
 *
 * Note: embeddings are set to NULL here (will be created on first API add).
 * For full functionality, use POST /api/vanna-docs/bulk which auto-embeds.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

const SEED_DOCS = [
  // fire — điểm cháy
  {
    category: 'fire',
    title: 'Bảng điểm cháy chính',
    content: 'fire.fire_points chứa điểm cháy. Các cột: id, latitude, longitude, commune_name, district_name, detected_at, confidence. Để đếm điểm cháy hôm nay: SELECT COUNT(*) FROM fire.fire_points WHERE DATE(detected_at) = CURRENT_DATE.',
  },
  {
    category: 'fire',
    title: 'Cảnh báo cháy rừng',
    content: 'fire.fire_alert chứa cảnh báo. fire.fire_alert_verification chứa kết quả xác minh. JOIN qua alert_id để lấy burned_area (diện tích cháy).',
  },
  {
    category: 'fire',
    title: 'Phân loại nguyên nhân cháy',
    content: 'fire.fire_alert_cause chứa danh sách nguyên nhân. fire.fire_alert có cột cause_id JOIN đến bảng cause.',
  },
  // camera — camera giám sát
  {
    category: 'camera',
    title: 'Danh sách camera',
    content: 'camera.camera chứa thông tin camera. Các cột: id, name, latitude, longitude, altitude, camera_type, is_active. camera.data_log chứa log phát hiện với confidence score.',
  },
  {
    category: 'camera',
    title: 'Phát hiện cháy qua camera',
    content: 'Khi user hỏi "camera phát hiện cháy", cần JOIN camera.data_log với camera.camera để lấy thông tin camera. data_log có cột camera_id.',
  },
  // core — đất đai, cây lâm nghiệp
  {
    category: 'core',
    title: 'Lô rừng (plot)',
    content: 'core.plot chứa thông tin lô rừng. Các cột: id, commune_code, area (diện tích), tree_spec_code (mã loài cây). JOIN core.commune qua commune_code để lấy tên xã.',
  },
  {
    category: 'core',
    title: 'Loài cây lâm nghiệp',
    content: 'core.tree_specie chứa danh sách loài cây. tree_spec_code trong plot JOIN đến species_code trong tree_specie. Ví dụ KEA% = cây keo.',
  },
  {
    category: 'core',
    title: 'Mã loài cây đặc thù',
    content: 'Cây keo = KEA%, Thông = PNN%, Giá ó = GOC%, Tre = BAM%, Bạch đàn = EUC%. Dùng ILIKE với wildcard khi truy vấn theo loài cây.',
  },
  // chatbot
  {
    category: 'chatbot',
    title: 'Cuộc trò chuyện chatbot',
    content: 'chatbot.chatbot chứa danh sách chatbot. chatbot.chatbot_conversations chứa cuộc trò chuyện với user_name, message_count, started_at. JOIN qua chatbot_id.',
  },
  // weather — thời tiết
  {
    category: 'weather',
    title: 'Trạm thời tiết',
    content: 'weather.weather_station chứa trạm. weather.weather_record chứa bản ghi thời tiết với temperature, humidity, rainfall, recorded_at. JOIN qua station_id.',
  },
  // general
  {
    category: 'general',
    title: 'Quy tắc ngày tháng',
    content: 'Dùng CURRENT_DATE cho hôm nay. DATE(column) = CURRENT_DATE để lọc theo ngày. DATE_TRUNC("day", column) để group by ngày. INTERVAL "7 days" để lọc tuần.',
  },
  {
    category: 'general',
    title: 'Luôn dùng schema prefix',
    content: 'Mọi table phải viết đầy đủ: schema.table, ví dụ: fire.fire_points, camera.camera, core.plot. Không viết tên bảng không có schema.',
  },
];

async function main() {
  console.log(`Seeding ${SEED_DOCS.length} business rules docs...`);

  for (const doc of SEED_DOCS) {
    await pool.query(
      `INSERT INTO vanna_docs (connection_id, category, title, content, embedding, is_active)
       VALUES ($1, $2, $3, $4, NULL, TRUE)
       ON CONFLICT DO NOTHING`,
      [3, doc.category, doc.title, doc.content],
    );
    console.log(`  ✓ [${doc.category}] ${doc.title}`);
  }

  const count = await pool.query('SELECT COUNT(*) FROM vanna_docs');
  console.log(`\n✅ Done. Total docs: ${(count.rows[0] as { count: string }).count}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
