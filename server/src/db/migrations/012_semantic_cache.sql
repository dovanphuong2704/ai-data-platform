-- Migration: 012_semantic_cache.sql
-- Semantic cache for SQL query results
-- Uses 768-dim vectors to stay within pgvector index limits

CREATE TABLE IF NOT EXISTS sql_semantic_cache (
  id                  SERIAL PRIMARY KEY,
  connection_id       INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL,
  question_embedding  vector(768),
  question_text       TEXT NOT NULL,
  sql_query           TEXT NOT NULL,
  result_preview      JSONB,
  row_count           INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  last_used_at        TIMESTAMPTZ DEFAULT NOW(),
  hit_count           INTEGER DEFAULT 0,
  expires_at          TIMESTAMPTZ,
  CONSTRAINT unique_question_per_conn UNIQUE (connection_id, question_text)
);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_emb
  ON sql_semantic_cache USING ivfflat (question_embedding vector_cosine_ops)
  WITH (lists = 100)
  WHERE question_embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_conn
  ON sql_semantic_cache(connection_id);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_user
  ON sql_semantic_cache(user_id);

CREATE OR REPLACE FUNCTION cleanup_semantic_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM sql_semantic_cache
  WHERE (expires_at IS NOT NULL AND expires_at < NOW())
     OR (created_at < NOW() - INTERVAL '7 days');
END;
$$ LANGUAGE plpgsql;
