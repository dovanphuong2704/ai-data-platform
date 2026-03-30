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

    console.log('\n✅ Database schema initialized successfully!');
    console.log('   Total tables: 13');
    console.log('   Total indexes: 11');
  } catch (err) {
    console.error('\n❌ Failed to initialize schema:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
