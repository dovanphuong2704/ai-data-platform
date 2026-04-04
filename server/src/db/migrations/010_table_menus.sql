-- Migration: 010_table_menus.sql
-- Cache table menu (1-line description per table) per connection

CREATE TABLE IF NOT EXISTS db_table_menus (
  id            SERIAL PRIMARY KEY,
  connection_id INTEGER UNIQUE REFERENCES db_connections(id) ON DELETE CASCADE,
  menu_json     JSONB    NOT NULL,  -- Array of {schema, table, oneLiner}
  total_tables  INT      NOT NULL,
  generated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_table_menus_conn ON db_table_menus(connection_id);
