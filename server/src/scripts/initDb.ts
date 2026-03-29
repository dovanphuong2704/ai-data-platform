/**
 * src/scripts/initDb.ts
 *
 * Standalone database initialization script.
 * Run with: npx tsx src/scripts/initDb.ts
 * Or:       npm run init-db
 *
 * Creates the application schema in the DATABASE_URL database:
 *   - users
 *   - db_connections
 *   - api_keys
 *   - user_dashboards
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

  console.log('🔧 Initializing database schema…');

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
    console.log('  ✓ users');

    // Migration: add created_at if missing (table existed before column was added)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

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

    // Migration: add created_at if missing
    await client.query(`
      ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

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

    // Migration: add created_at if missing
    await client.query(`
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_dashboards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('  ✓ user_dashboards');

    // Migration: add created_at if missing
    await client.query(`
      ALTER TABLE user_dashboards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

    // Create indexes for common query patterns
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_db_connections_user_id ON db_connections(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_dashboards_user_id ON user_dashboards(user_id);
    `);
    console.log('  ✓ indexes');

    console.log('\n✅ Database schema initialized successfully.');
  } catch (err) {
    console.error('❌ Failed to initialize schema:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
