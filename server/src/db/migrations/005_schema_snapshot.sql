-- Migration: 005_schema_snapshot.sql
-- Pre-cache schema descriptions in app DB to avoid fetching from target DB every request

CREATE TABLE IF NOT EXISTS db_schema_snapshots (
  id            SERIAL PRIMARY KEY,
  connection_id INTEGER UNIQUE REFERENCES db_connections(id) ON DELETE CASCADE,
  schema_json   JSONB    NOT NULL,  -- EnrichedSchema as JSON
  schema_text   TEXT     NOT NULL,  -- Pre-built focused description string (for system prompt)
  table_count   INT      NOT NULL,
  column_count  INT      NOT NULL,
  version_hash  TEXT     NOT NULL,  -- MD5 of schema fingerprint (detects changes)
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schema_snap_conn ON db_schema_snapshots(connection_id);
CREATE INDEX IF NOT EXISTS idx_schema_snap_hash ON db_schema_snapshots(version_hash);
