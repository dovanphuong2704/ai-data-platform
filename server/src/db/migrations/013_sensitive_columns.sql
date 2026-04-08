-- Migration: 013_sensitive_columns.sql
-- Per-connection sensitive column patterns for data masking

CREATE TABLE IF NOT EXISTS sensitive_columns (
  id              SERIAL PRIMARY KEY,
  connection_id   INTEGER REFERENCES db_connections(id) ON DELETE CASCADE,
  column_pattern  TEXT NOT NULL,   -- regex pattern, case-insensitive
  mask_type       TEXT NOT NULL DEFAULT 'hash',  -- 'hash', 'null', 'redact'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensitive_cols_conn
  ON sensitive_columns(connection_id);

-- Default global patterns (connection_id = -1 means applies to all)
INSERT INTO sensitive_columns (connection_id, column_pattern, mask_type)
VALUES
  (-1, 'password', 'hash'),
  (-1, 'passwd', 'hash'),
  (-1, 'pwd', 'hash'),
  (-1, 'secret', 'hash'),
  (-1, 'token', 'redact'),
  (-1, 'api_key', 'redact'),
  (-1, 'apikey', 'redact'),
  (-1, 'ssn', 'null'),
  (-1, 'social_security', 'null'),
  (-1, 'credit_card', 'null'),
  (-1, 'card_number', 'null'),
  (-1, 'cvv', 'null'),
  (-1, 'pin', 'hash'),
  (-1, 'salary', 'hash'),
  (-1, 'wage', 'hash'),
  (-1, 'dob', 'redact'),
  (-1, 'date_of_birth', 'redact')
ON CONFLICT DO NOTHING;
