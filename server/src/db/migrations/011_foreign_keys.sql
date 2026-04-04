-- Migration: 011_foreign_keys.sql
-- Store FK relationships for text-based retrieval by LLM
-- Keywords column for keyword search, no vector (3072-dim limit)

CREATE TABLE IF NOT EXISTS db_foreign_keys (
  id              SERIAL PRIMARY KEY,
  connection_id   INTEGER,
  source_schema   VARCHAR(100) NOT NULL,
  source_table    VARCHAR(100) NOT NULL,
  source_column   VARCHAR(100) NOT NULL,
  target_schema  VARCHAR(100) NOT NULL,
  target_table   VARCHAR(100) NOT NULL,
  target_column  VARCHAR(100) NOT NULL,
  direction      VARCHAR(10) NOT NULL DEFAULT 'outbound',
  hint_text      TEXT NOT NULL,
  keywords       TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, source_schema, source_table, source_column,
          target_schema, target_table, target_column)
);

CREATE INDEX IF NOT EXISTS idx_fk_conn ON db_foreign_keys(connection_id);

-- Keywords gin index for fast keyword search
CREATE INDEX IF NOT EXISTS idx_fk_keywords ON db_foreign_keys
  USING gin(to_tsvector('simple', keywords));
