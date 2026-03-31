import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const appPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initDB(): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migration: add created_at if missing
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

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

    // Migration: add created_at if missing
    await client.query(`ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

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

    // Migration: add created_at if missing
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_dashboards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migration: add created_at if missing
    await client.query(`ALTER TABLE user_dashboards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    // ── Phase 1: New tables for 12 features ──────────────────────────────────

    // 1. sql_query_history
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

    // 2. user_quotas
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

    // 3. saved_queries
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

    // 4. scheduled_queries
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

    // 5. alerts
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

    // 6. shared_dashboards
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

    // 7. alert_webhooks
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_webhooks (
        id SERIAL PRIMARY KEY,
        alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
        webhook_url TEXT NOT NULL,
        is_enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 8. chat_sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      VARCHAR(255) NOT NULL DEFAULT 'New conversation',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 9. chat_messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role       VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant','system')),
        content    TEXT NOT NULL,
        sql        TEXT,
        sql_result JSONB,
        error      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
    `);

    console.log('✅ Database tables initialized');
  } finally {
    client.release();
  }
}

export async function createConnectionPool(connectionString: string): Promise<Pool> {
  return new Pool({ connectionString, max: 5, idleTimeoutMillis: 60000 });
}
