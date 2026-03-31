import { Router } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { appPool, createConnectionPool } from '../services/db';
import { cleanupHistory } from './history';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validateSQL, executeSafeQuery } from '../utils/sqlValidator';
import { checkQuota, incrementQuota } from '../utils/quota-manager';
import { registerQuery, removeQuery } from '../utils/query-cancellations';

export const queryRouter = Router();

queryRouter.use(authMiddleware);

const querySchema = z.object({
  connectionId: z.number().optional(),
  sql: z.string().min(1),
  timeout: z.number().optional(),
});

// GET /api/query/schema?connectionId= (optional)
queryRouter.get('/schema', async (req: AuthRequest, res) => {
  try {
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;

    let pool: Pool = appPool;
    if (connectionId) {
      const connResult = await appPool.query(
        'SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2',
        [connectionId, req.userId]
      );
      if (connResult.rows.length === 0) {
        res.status(404).json({ error: 'Connection not found' });
        return;
      }
      const c = connResult.rows[0];
      pool = await createConnectionPool(
        `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`
      );
    }

    try {
      const schemaResult = await pool.query(`
        SELECT
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          c.character_maximum_length
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
        LIMIT 500
      `);
      res.json({ schema: schemaResult.rows });
    } finally {
      if (pool !== appPool) await pool.end();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch schema', details: String(err) });
  }
});

// POST /api/query
queryRouter.post('/', async (req: AuthRequest, res) => {
  const queryId = uuidv4();
  let client = null;
  let pid = -1;

  try {
    const { connectionId, sql, timeout } = querySchema.parse(req.body);

    console.log(`[Query] User ${req.userId} - SQL: ${sql} - connectionId: ${connectionId}`);

    // ── 1. Rate limit check ────────────────────────────────────────────────
    const quota = await checkQuota(req.userId!, 'query');
    if (!quota.allowed) {
      res.status(429).json({
        error: 'Query quota exceeded',
        remaining: 0,
        resetAt: quota.resetAt,
      });
      return;
    }

    // ── 2. SQL validation ────────────────────────────────────────────────────
    const validation = validateSQL(sql);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // ── 3. Resolve connection pool ──────────────────────────────────────────
    let pool: Pool = appPool;
    if (connectionId) {
      const connResult = await appPool.query(
        'SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2',
        [connectionId, req.userId]
      );
      if (connResult.rows.length === 0) {
        res.status(404).json({ error: 'Connection not found' });
        return;
      }
      const c = connResult.rows[0];
      pool = await createConnectionPool(
        `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`
      );
    }

    // ── 4. Execute with cancellation support ─────────────────────────────────
    const finalSql = validation.sql!;
    const effectiveTimeout = timeout ?? 30_000;

    client = await pool.connect();

    // Get PostgreSQL PID for cancellation
    const pidResult = await client.query('SELECT pg_backend_pid() as pid');
    pid = pidResult.rows[0].pid as number;

    // Register so frontend can cancel
    registerQuery(queryId, client, pid, req.userId!);

    // Set statement timeout
    await client.query(`SET statement_timeout = ${Math.max(1000, effectiveTimeout)}`);

    let result: Awaited<ReturnType<typeof executeSafeQuery>> | null = null;
    let errorMessage: string | null = null;
    let status: 'success' | 'error' | 'cancelled' = 'success';

    try {
      result = await executeSafeQuery(pool, finalSql, effectiveTimeout);
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes('canceling statement due to user request') || errMsg.includes('terminated')) {
        status = 'cancelled';
      } else {
        status = 'error';
        errorMessage = errMsg;
      }
    }

    // ── 5. Log to sql_query_history + auto-cleanup ─────────────────────
    appPool.query(
      `INSERT INTO sql_query_history
       (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.userId, connectionId ?? null, finalSql, status, result?.duration_ms ?? null, result?.rowCount ?? null, errorMessage]
    ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('[history cleanup]', err));

    // ── 6. Increment quota ───────────────────────────────────────────────────
    await incrementQuota(req.userId!, 'query');

    // ── 7. Cleanup ────────────────────────────────────────────────────────────
    removeQuery(queryId);
    if (pool !== appPool) await pool.end();

    if (status === 'error') {
      res.status(400).json({
        error: 'Query execution failed',
        details: errorMessage,
        queryId,
      });
      return;
    }

    res.json({
      queryId,
      columns: result!.columns,
      rows: result!.rows,
      rowCount: result!.rowCount,
      sql: finalSql,
      duration_ms: result!.duration_ms,
      limited: result!.limited,
      remaining: quota.remaining - 1,
    });
  } catch (err) {
    // Cleanup on unexpected error
    removeQuery(queryId);
    if (client) client.release();

    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Query execution failed', details: String(err) });
    }
  }
});
