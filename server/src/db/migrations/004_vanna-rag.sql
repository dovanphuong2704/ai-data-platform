-- Migration: 004_vanna_rag.sql
-- Vector-based RAG for VI→SQL training examples using pgvector + Gemini embeddings

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ── vanna_training_data ──────────────────────────────────────────────────────
-- Stores VI→SQL training pairs with their Gemini embedding vectors (768 dims)
CREATE TABLE IF NOT EXISTS vanna_training_data (
  id            SERIAL PRIMARY KEY,
  connection_id INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
  question_vi   TEXT    NOT NULL,   -- Vietnamese question
  sql           TEXT    NOT NULL,   -- Corresponding SQL
  embedding     vector(3072),       -- Gemini embedding-2-preview (3072 dims)
  source        VARCHAR(50) DEFAULT 'auto',  -- 'auto' | 'manual' | 'history'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for ANN search (pgvector HNSW supports up to 2000 dims)
-- NOTE: pgvector IVFFlat is limited to 2000 dims, gemini-embedding-2 outputs 3072
-- For small datasets (<1000 rows) sequential scan is acceptable performance
-- Creating HNSW index with reduced dims is complex, so we use plain scan
-- If you need fast ANN search with 3072-dim, consider using pgvector 0.7+ with HNSW
-- or switch to embedding-001 (768 dims) which supports IVFFlat

-- Index on connection_id for fast per-user retrieval
CREATE INDEX IF NOT EXISTS idx_vanna_conn
  ON vanna_training_data(connection_id);

-- ── match_vanna_training_data ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_vanna_training_data(
  query_embedding vector(3072),
  match_threshold FLOAT  DEFAULT 0.7,
  match_count     INT    DEFAULT 5,
  conn_id         INT    DEFAULT NULL
)
RETURNS TABLE (
  id            INT,
  question_vi   TEXT,
  sql           TEXT,
  similarity    FLOAT8
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    vtd.id,
    vtd.question_vi,
    vtd.sql,
    ROUND((1 - (vtd.embedding <=> query_embedding))::NUMERIC, 4)::FLOAT8 AS similarity
  FROM vanna_training_data vtd
  WHERE vtd.embedding IS NOT NULL
    AND (conn_id IS NULL OR vtd.connection_id = conn_id)
    AND (1 - (vtd.embedding <=> query_embedding)) >= match_threshold
    AND (1 - (vtd.embedding <=> query_embedding)) <= 1.0
  ORDER BY vtd.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
