import { Router } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { appPool, createConnectionPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const explorerRouter = Router();

explorerRouter.use(authMiddleware);

const querySchema = z.object({
  connectionId: z.coerce.number().optional(),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
}

export interface TableInfo {
  schema_name: string;
  table_name: string;
  columns: ColumnInfo[];
}

export interface ForeignKeyInfo {
  constraint_name: string;
  from_schema: string;
  from_table: string;
  from_column: string;
  to_schema: string;
  to_table: string;
  to_column: string;
}

export interface SchemaInfoResult {
  schemas: { schema_name: string; table_count: number }[];
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getConnectionString(req: AuthRequest, connectionId?: number): Promise<{ connectionString: string; schemaName: string } | null> {
  if (connectionId) {
    const result = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password
       FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, req.userId]
    );
    if (!result.rows.length) return null;
    const c = result.rows[0];
    return {
      connectionString: `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`,
      schemaName: 'user',
    };
  }
  const result = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE user_id = $1 AND is_default = TRUE LIMIT 1`,
    [req.userId]
  );
  if (!result.rows.length) return null;
  const c = result.rows[0];
  return {
    connectionString: `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`,
    schemaName: 'user',
  };
}

// ─── GET /api/explorer/schema-info ────────────────────────────────────────────
// Returns full schema: schemas list, all tables+columns, foreign key relationships

explorerRouter.get('/explorer/schema-info', async (req: AuthRequest, res) => {
  const parse = querySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'Invalid query params' });
    return;
  }

  const { connectionId } = parse.data;

  const conn = await getConnectionString(req, connectionId);
  if (!conn) {
    res.status(400).json({ error: 'No database connection configured. Please add a DB connection in Settings.' });
    return;
  }

  let pool: Pool | null = null;
  try {
    pool = await createConnectionPool(conn.connectionString);

    // 1. Schemas + table count
    const schemasResult = await pool.query<{ schema_name: string; table_count: number }>(`
      SELECT
        s.schema_name,
        COUNT(t.table_name) AS table_count
      FROM information_schema.schemata s
      LEFT JOIN information_schema.tables t
        ON t.table_schema = s.schema_name
       AND t.table_type = 'BASE TABLE'
      WHERE s.schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_toast_temp_1', 'pg_toast_temp_2', 'pg_temp_1', 'pg_temp_2', 'pg_temp_3')
      GROUP BY s.schema_name
      ORDER BY s.schema_name
    `);

    // 2. Tables + columns (all schemas)
    const tablesResult = await pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: boolean;
    }>(`
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_toast_temp_1', 'pg_toast_temp_2', 'pg_temp_1', 'pg_temp_2', 'pg_temp_3')
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);

    // 3. Foreign key relationships
    const fkResult = await pool.query<{
      constraint_name: string;
      from_schema: string;
      from_table: string;
      from_column: string;
      to_schema: string;
      to_table: string;
      to_column: string;
    }>(`
      SELECT
        rc.constraint_name,
        kcu.table_schema    AS from_schema,
        kcu.table_name      AS from_table,
        kcu.column_name     AS from_column,
        ccu.table_schema    AS to_schema,
        ccu.table_name      AS to_table,
        ccu.column_name     AS to_column
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage AS kcu
        ON kcu.constraint_catalog = rc.constraint_catalog
       AND kcu.constraint_schema  = rc.constraint_schema
       AND kcu.constraint_name   = rc.constraint_name
      JOIN information_schema.key_column_usage AS ccu
        ON ccu.constraint_catalog = rc.unique_constraint_catalog
       AND ccu.constraint_schema  = rc.unique_constraint_schema
       AND ccu.constraint_name    = rc.unique_constraint_name
       AND ccu.ordinal_position  = kcu.ordinal_position
      WHERE kcu.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND ccu.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY kcu.table_schema, kcu.table_name
    `);

    // Group columns by table
    const tableMap = new Map<string, TableInfo>();
    for (const row of tablesResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!tableMap.has(key)) {
        tableMap.set(key, { schema_name: row.table_schema, table_name: row.table_name, columns: [] });
      }
      tableMap.get(key)!.columns.push({
        column_name: row.column_name,
        data_type: row.data_type,
        is_nullable: String(row.is_nullable).toUpperCase() === 'YES',
      });
    }

    const result: SchemaInfoResult = {
      schemas: schemasResult.rows,
      tables: Array.from(tableMap.values()),
      foreignKeys: fkResult.rows,
    };

    res.json(result);
  } catch (err) {
    console.error('[/explorer/schema-info]', err);
    res.status(500).json({ error: String(err) });
  } finally {
    if (pool) await pool.end();
  }
});
