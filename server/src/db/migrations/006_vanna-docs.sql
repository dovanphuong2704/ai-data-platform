-- Migration: 006_vanna_docs.sql
-- Business rules / domain knowledge documentation for RAG
-- Short text rules embedded and retrieved into system prompt

CREATE TABLE IF NOT EXISTS vanna_docs (
  id            SERIAL PRIMARY KEY,
  connection_id INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
  category      VARCHAR(50)  NOT NULL DEFAULT 'general',
  title         TEXT         NOT NULL,
  content       TEXT         NOT NULL,
  embedding     vector(3072),
  is_active     BOOLEAN      DEFAULT TRUE,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vanna_docs_conn ON vanna_docs(connection_id);
CREATE INDEX IF NOT EXISTS idx_vanna_docs_cat  ON vanna_docs(category);
-- NOTE: IVFFlat index not created (3072-dim > 2000 pgvector limit).
-- For small datasets (<500 docs) sequential scan is acceptable.
