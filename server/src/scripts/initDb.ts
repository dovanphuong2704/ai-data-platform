/**
 * src/scripts/initDb.ts
 *
 * Standalone database initialization script.
 * Run with: npx tsx src/scripts/initDb.ts
 * Or:       npm run init-db
 *
 * Creates ALL application tables in the DATABASE_URL database.
 * This is the source-of-truth for the schema.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is not set.');
  console.error('   Set it in a .env file or your shell environment.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
});

async function main(): Promise<void> {
  const client = await pool.connect();

  console.log('🔧 Initializing database schema…\n');

  try {
    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('  ✓ pgvector extension');

    // ── 1. users ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ users');

    // ── 2. db_connections ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_connections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        profile_name TEXT,
        db_host TEXT NOT NULL,
        db_port TEXT NOT NULL,
        db_name TEXT NOT NULL,
        db_user TEXT NOT NULL,
        db_password TEXT NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ db_connections');

    // ── 3. api_keys ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        profile_name TEXT,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ api_keys');

    // ── 4. user_dashboards ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_dashboards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ user_dashboards');

    // ── 5. sql_query_history ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS sql_query_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE SET NULL,
        sql TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success',
        duration_ms INTEGER,
        rows_returned INTEGER,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ sql_query_history');

    // ── 6. user_quotas ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_quotas (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        query_count INTEGER NOT NULL DEFAULT 0,
        query_limit INTEGER NOT NULL DEFAULT 100,
        chat_count INTEGER NOT NULL DEFAULT 0,
        chat_limit INTEGER NOT NULL DEFAULT 50,
        window_start TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ user_quotas');

    // ── 7. saved_queries ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_queries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        description TEXT,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ saved_queries');

    // ── 8. scheduled_queries ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_queries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        schedule_cron TEXT NOT NULL,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE SET NULL,
        is_active BOOLEAN DEFAULT TRUE,
        last_run_at TIMESTAMP,
        last_run_status TEXT,
        last_run_result JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ scheduled_queries');

    // ── 9. alerts ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query_sql TEXT NOT NULL,
        threshold_value DOUBLE PRECISION NOT NULL,
        condition TEXT NOT NULL,
        connection_id INTEGER REFERENCES db_connections(id) ON DELETE SET NULL,
        is_active BOOLEAN DEFAULT TRUE,
        last_checked_at TIMESTAMP,
        last_triggered_at TIMESTAMP,
        notify_email BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ alerts');

    // ── 10. shared_dashboards ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_dashboards (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        shared_with_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        dashboard_item_id INTEGER REFERENCES user_dashboards(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'view',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(owner_id, shared_with_user_id, dashboard_item_id)
      );
    `);
    console.log('  ✓ shared_dashboards');

    // ── 11. alert_webhooks ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_webhooks (
        id SERIAL PRIMARY KEY,
        alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
        webhook_url TEXT NOT NULL,
        is_enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ alert_webhooks');

    // ── 12. chat_sessions ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL DEFAULT 'New conversation',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('  ✓ chat_sessions');

    // ── 13. chat_messages ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        sql TEXT,
        sql_result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('  ✓ chat_messages');

    // ── 14. schema_dictionary ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_dictionary (
        id SERIAL PRIMARY KEY,
        vi_keywords TEXT NOT NULL,
        en_keywords TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✓ schema_dictionary');

    // Seed initial Vietnamese-English dictionary data
    const seedData = [
      // Fire / Forest fire
      ['điểm cháy', 'fire alert point hotspot', 'fire'],
      ['cháy', 'fire burn wildfire', 'fire'],
      ['đám cháy', 'fire burn', 'fire'],
      ['lửa', 'fire burn flame', 'fire'],
      ['khói', 'smoke', 'fire'],
      ['cảnh báo cháy', 'fire alert warning fire_alert', 'fire'],
      ['cháy rừng', 'fire wildfire forest_fire', 'fire'],
      ['báo cháy', 'fire alert', 'fire'],

      // Camera
      ['camera', 'camera device cam', 'camera'],
      ['quan sát', 'camera monitoring', 'camera'],
      ['giám sát', 'camera monitor surveillance', 'camera'],
      ['mắt camera', 'camera', 'camera'],

      // Detection
      ['phát hiện', 'detect detection', 'detect'],
      ['biến động', 'detect change detection', 'detect'],
      ['mất rừng', 'detect deforestation', 'detect'],
      ['thay đổi', 'change', 'detect'],

      // Map / GIS
      ['bản đồ', 'map gis', 'map'],
      ['vị trí', 'map location coordinate', 'map'],
      ['tọa độ', 'coordinate latitude longitude location', 'map'],
      ['lớp', 'layer', 'map'],
      ['lớp bản đồ', 'layer map', 'map'],

      // Satellite
      ['vệ tinh', 'satellite', 'satellite'],
      ['ảnh vệ tinh', 'satellite image', 'satellite'],

      // Weather
      ['thời tiết', 'weather climate', 'weather'],
      ['khí tượng', 'weather meteorology', 'weather'],
      ['mưa', 'rain rainfall', 'weather'],
      ['nhiệt độ', 'temperature', 'weather'],

      // Patrol
      ['tuần tra', 'patrol inspection', 'patrol'],
      ['kiểm tra', 'patrol inspection check', 'patrol'],

      // Drone
      ['drone', 'flycam drone uav', 'drone'],
      ['máy bay', 'flycam drone', 'drone'],
      ['flycam', 'flycam drone', 'drone'],

      // Doc
      ['tài liệu', 'doc document', 'doc'],
      ['báo cáo', 'doc report', 'doc'],

      // User
      ['người dùng', 'user account', 'user'],
      ['tài khoản', 'user account', 'user'],
      ['đăng nhập', 'user login auth', 'user'],
      ['quyền', 'permission role', 'user'],

      // Notification
      ['thông báo', 'notification', 'notification'],
      ['cảnh báo', 'alert notification', 'notification'],

      // General
      ['lâm nghiệp', 'forestry forest', 'general'],
      ['rừng', 'forest', 'general'],
      ['diện tích', 'area', 'general'],
      ['số lượng', 'count total number', 'general'],
      ['tổng', 'sum total', 'general'],
      ['trong tuần', 'week weekly', 'general'],
      ['hôm nay', 'today current_date', 'general'],
      ['tháng này', 'month', 'general'],
      ['năm nay', 'year', 'general'],
      ['theo ngày', 'date day', 'general'],
      ['theo tháng', 'month', 'general'],
      ['theo năm', 'year', 'general'],
      ['có bao nhiêu', 'count total', 'general'],
      ['bao nhiêu', 'count total', 'general'],
      ['còn bao nhiêu', 'count remaining', 'general'],
      ['tỷ lệ', 'rate ratio percentage', 'general'],
      ['xếp hạng', 'rank top', 'general'],
      ['top', 'rank top', 'general'],
      ['hàng đầu', 'top rank', 'general'],
      ['schema', 'schema', 'general'],
      ['public', 'public', 'general'],
      ['danh sách', 'list', 'general'],
    ];

    for (const [vi, en, cat] of seedData) {
      await client.query(`
        INSERT INTO schema_dictionary (vi_keywords, en_keywords, category)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [vi, en, cat]);
    }
    console.log(`  ✓ schema_dictionary seeded (${seedData.length} entries)`);

    // ── Indexes ────────────────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_db_connections_user_id ON db_connections(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_dashboards_user_id ON user_dashboards(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sql_query_history_user_id ON sql_query_history(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_saved_queries_user_id ON saved_queries(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_queries_user_id ON scheduled_queries(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shared_dashboards_owner_id ON shared_dashboards(owner_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_webhooks_alert_id ON alert_webhooks(alert_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);`);
    console.log('  ✓ indexes');

    // ── 15. vanna_training_data (RAG) ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vanna_training_data (
        id            SERIAL PRIMARY KEY,
        connection_id INTEGER,
        question_vi   TEXT    NOT NULL,
        sql           TEXT    NOT NULL,
        embedding     vector(768),
        source        VARCHAR(50) DEFAULT 'auto',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✓ vanna_training_data');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vanna_training_conn
        ON vanna_training_data(connection_id);
      CREATE INDEX IF NOT EXISTS idx_vanna_training_embedding_hnsw
        ON vanna_training_data USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    `);

    // ── 16. db_schema_snapshots ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_schema_snapshots (
        id            SERIAL PRIMARY KEY,
        connection_id INTEGER UNIQUE,
        schema_json   JSONB    NOT NULL,
        schema_text   TEXT     NOT NULL,
        table_count   INT      NOT NULL,
        column_count  INT      NOT NULL,
        version_hash  TEXT     NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✓ db_schema_snapshots');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_schema_snap_conn ON db_schema_snapshots(connection_id);
      CREATE INDEX IF NOT EXISTS idx_schema_snap_hash ON db_schema_snapshots(version_hash);
    `);

    // ── 17. vanna_docs (Business rules RAG) ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS vanna_docs (
        id            SERIAL PRIMARY KEY,
        connection_id INTEGER,
        category      VARCHAR(50)  NOT NULL DEFAULT 'general',
        title         TEXT         NOT NULL,
        content       TEXT         NOT NULL,
        embedding     vector(768),
        is_active     BOOLEAN      DEFAULT TRUE,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      );
    `);
    console.log('  ✓ vanna_docs');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vanna_docs_conn ON vanna_docs(connection_id);
      CREATE INDEX IF NOT EXISTS idx_vanna_docs_cat  ON vanna_docs(category);
      CREATE INDEX IF NOT EXISTS idx_vanna_docs_embedding_hnsw
        ON vanna_docs USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    `);

    // ── 18. db_table_summaries ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_table_summaries (
        id              SERIAL PRIMARY KEY,
        connection_id   INTEGER,
        table_schema    VARCHAR(100) NOT NULL,
        table_name      VARCHAR(100) NOT NULL,
        summary_text    TEXT         NOT NULL,
        column_list     TEXT         NOT NULL,
        fk_hint         TEXT         NOT NULL DEFAULT '',
        embedding       vector(768),
        created_at      TIMESTAMPTZ  DEFAULT NOW(),
        UNIQUE(connection_id, table_schema, table_name)
      );
    `);
    console.log('  ✓ db_table_summaries');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_table_summ_conn ON db_table_summaries(connection_id);
      CREATE INDEX IF NOT EXISTS idx_table_summaries_embedding_hnsw
        ON db_table_summaries USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    `);

    // ── 19. db_table_menus ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_table_menus (
        id            SERIAL PRIMARY KEY,
        connection_id INTEGER UNIQUE,
        menu_json     JSONB    NOT NULL,
        total_tables  INT      NOT NULL,
        generated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✓ db_table_menus');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_table_menus_conn ON db_table_menus(connection_id);
    `);

    console.log('\n✅ Database schema initialized successfully!');
    console.log('   Total tables: 19');
    console.log('   Total indexes: 17 (incl. 4 HNSW)');
  } catch (err) {
    console.error('\n❌ Failed to initialize schema:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
