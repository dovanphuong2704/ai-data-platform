-- Migration: 009_embedding_indexes.sql
-- NOTE: pgvector on this server limits indexes to 2000 dims.
-- Embeddings are 3072 dims (gemini-embedding-2-preview).
-- Vector search will use sequential scan (slower but works).
-- TODO: Create wrapper 2000-dim column for indexed search if performance matters.

-- Drop any existing indexes (safe to run multiple times)
DROP INDEX IF EXISTS idx_vanna_training_embedding;
DROP INDEX IF EXISTS idx_vanna_docs_embedding;
DROP INDEX IF EXISTS idx_table_summaries_embedding;
DROP INDEX IF EXISTS idx_vanna_training_embedding_hnsw;
DROP INDEX IF EXISTS idx_vanna_docs_embedding_hnsw;
DROP INDEX IF EXISTS idx_table_summaries_embedding_hnsw;
