-- Migration: 007_table_summaries.sql
-- Per-table vector summaries for smart table retrieval
-- Replaces full-schema BM25 with semantic vector search across table descriptions

CREATE TABLE IF NOT EXISTS db_table_summaries (
  id              SERIAL PRIMARY KEY,
  connection_id   INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
  table_schema    VARCHAR(100) NOT NULL,
  table_name      VARCHAR(100) NOT NULL,
  summary_text    TEXT         NOT NULL,
  column_list     TEXT         NOT NULL,
  fk_hint         TEXT         NOT NULL DEFAULT '',
  embedding       vector(3072),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(connection_id, table_schema, table_name)
);

CREATE INDEX IF NOT EXISTS idx_table_summ_conn ON db_table_summaries(connection_id);
-- NOTE: IVFFlat not created (3072-dim > 2000 pgvector limit).
-- Sequential scan acceptable for small-to-medium table counts (<500).
