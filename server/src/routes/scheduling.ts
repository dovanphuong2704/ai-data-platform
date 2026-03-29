import { Router } from 'express';
import { z } from 'zod';
import { appPool, createConnectionPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validateSQL, executeSafeQuery } from '../utils/sqlValidator';

export const schedulingRouter = Router();

schedulingRouter.use(authMiddleware);

// ── Shared query helpers ─────────────────────────────────────────────────────

async function getConnectionString(userId: number, connectionId?: number): Promise<string | null> {
  if (connectionId) {
    const result = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password
       FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, userId]
    );
    if (!result.rows.length) return null;
    const c = result.rows[0];
    return `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`;
  }
  const result = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE user_id = $1 AND is_default = TRUE LIMIT 1`,
    [userId]
  );
  if (!result.rows.length) return null;
  const c = result.rows[0];
  return `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`;
}

// ── Scheduled Queries CRUD ───────────────────────────────────────────────────

const sqCreateSchema = z.object({
  name: z.string().min(1).max(255),
  sql: z.string().min(1),
  scheduleCron: z.string().min(1),
  connectionId: z.number().optional(),
});

const sqUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  sql: z.string().min(1).optional(),
  scheduleCron: z.string().min(1).optional(),
  connectionId: z.number().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/scheduled-queries
schedulingRouter.get('/scheduled-queries', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, name, sql, schedule_cron, connection_id, is_active,
              last_run_at, last_run_status, created_at
       FROM scheduled_queries WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ scheduledQueries: result.rows });
    console.log('[scheduling] GET /scheduled-queries, rows:', JSON.stringify(result.rows).slice(0, 200));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scheduled queries' });
  }
});

// GET /api/scheduled-queries/:id
schedulingRouter.get('/scheduled-queries/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'SELECT * FROM scheduled_queries WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Scheduled query not found' });
      return;
    }
    res.json({ scheduledQuery: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scheduled query' });
  }
});

// POST /api/scheduled-queries
schedulingRouter.post('/scheduled-queries', async (req: AuthRequest, res) => {
  try {
    const data = sqCreateSchema.parse(req.body);
    const result = await appPool.query(
      `INSERT INTO scheduled_queries (user_id, name, sql, schedule_cron, connection_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, schedule_cron, connection_id, is_active, created_at`,
      [req.userId, data.name, data.sql, data.scheduleCron, data.connectionId ?? null]
    );
    res.status(201).json({ scheduledQuery: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create scheduled query' });
    }
  }
});

// PUT /api/scheduled-queries/:id
schedulingRouter.put('/scheduled-queries/:id', async (req: AuthRequest, res) => {
  try {
    const data = sqUpdateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
    if (data.sql !== undefined) { fields.push(`sql = $${idx++}`); values.push(data.sql); }
    if (data.scheduleCron !== undefined) { fields.push(`schedule_cron = $${idx++}`); values.push(data.scheduleCron); }
    if (data.connectionId !== undefined) { fields.push(`connection_id = $${idx++}`); values.push(data.connectionId); }
    if (data.isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(data.isActive); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id, req.userId);
    const result = await appPool.query(
      `UPDATE scheduled_queries SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Scheduled query not found' });
      return;
    }
    res.json({ scheduledQuery: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update scheduled query' });
    }
  }
});

// DELETE /api/scheduled-queries/:id
schedulingRouter.delete('/scheduled-queries/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM scheduled_queries WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Scheduled query not found' });
      return;
    }
    res.json({ message: 'Scheduled query deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete scheduled query' });
  }
});

// POST /api/scheduled-queries/:id/run — manual trigger
schedulingRouter.post('/scheduled-queries/:id/run', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'SELECT * FROM scheduled_queries WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Scheduled query not found' });
      return;
    }

    const sq = result.rows[0] as {
      id: number; user_id: number; sql: string; connection_id: number | null;
    };
    const connStr = await getConnectionString(sq.user_id, sq.connection_id ?? undefined);
    if (!connStr) {
      res.status(400).json({ error: 'No database connection available' });
      return;
    }

    const validation = validateSQL(sq.sql);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const pool = await createConnectionPool(connStr);
    try {
      const execResult = await executeSafeQuery(pool, validation.sql!, 60_000);
      await appPool.query(
        `UPDATE scheduled_queries SET last_run_at = NOW(), last_run_status = 'success', last_run_result = $1 WHERE id = $2`,
        [JSON.stringify({ columns: execResult.columns, rows: execResult.rows, rowCount: execResult.rowCount, duration_ms: execResult.duration_ms }), sq.id]
      );
      res.json({ status: 'success', duration_ms: execResult.duration_ms, rowCount: execResult.rowCount });
    } catch (execErr) {
      await appPool.query(
        `UPDATE scheduled_queries SET last_run_at = NOW(), last_run_status = 'error', last_run_result = $1 WHERE id = $2`,
        [JSON.stringify({ error: String(execErr) }), sq.id]
      );
      res.json({ status: 'error', error: String(execErr) });
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run scheduled query' });
  }
});

// ── Alerts CRUD ──────────────────────────────────────────────────────────────

const alertCreateSchema = z.object({
  name: z.string().min(1).max(255),
  querySql: z.string().min(1),
  thresholdValue: z.number(),
  condition: z.enum(['gt', 'lt', 'gte', 'lte', 'eq', 'ne']),
  connectionId: z.number().optional(),
  notifyEmail: z.boolean().optional(),
});

const alertUpdateSchema = alertCreateSchema.extend({
  isActive: z.boolean().optional(),
}).partial();

// GET /api/alerts
schedulingRouter.get('/alerts', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, name, query_sql, threshold_value, condition, connection_id,
              is_active, last_checked_at, last_triggered_at, notify_email, created_at
       FROM alerts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// GET /api/alerts/:id
schedulingRouter.get('/alerts/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'SELECT * FROM alerts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ alert: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch alert' });
  }
});

// POST /api/alerts
schedulingRouter.post('/alerts', async (req: AuthRequest, res) => {
  try {
    const data = alertCreateSchema.parse(req.body);
    const result = await appPool.query(
      `INSERT INTO alerts (user_id, name, query_sql, threshold_value, condition, connection_id, notify_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, threshold_value, condition, connection_id, is_active, notify_email, created_at`,
      [req.userId, data.name, data.querySql, data.thresholdValue, data.condition, data.connectionId ?? null, data.notifyEmail ?? false]
    );
    res.status(201).json({ alert: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create alert' });
    }
  }
});

// PUT /api/alerts/:id
schedulingRouter.put('/alerts/:id', async (req: AuthRequest, res) => {
  try {
    const data = alertUpdateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
    if (data.querySql !== undefined) { fields.push(`query_sql = $${idx++}`); values.push(data.querySql); }
    if (data.thresholdValue !== undefined) { fields.push(`threshold_value = $${idx++}`); values.push(data.thresholdValue); }
    if (data.condition !== undefined) { fields.push(`condition = $${idx++}`); values.push(data.condition); }
    if (data.connectionId !== undefined) { fields.push(`connection_id = $${idx++}`); values.push(data.connectionId); }
    if (data.notifyEmail !== undefined) { fields.push(`notify_email = $${idx++}`); values.push(data.notifyEmail); }
    if (data.isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(data.isActive); }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id, req.userId);
    const result = await appPool.query(
      `UPDATE alerts SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ alert: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update alert' });
    }
  }
});

// POST /api/alerts/:id/webhooks/test — test a webhook URL (MUST be before /alerts/:id)
const alertTestWebhookSchema = z.object({ webhookUrl: z.string().optional(), webhook_url: z.string().optional() });

schedulingRouter.post('/alerts/:id/webhooks/test', async (req: AuthRequest, res) => {
  console.log('[DEBUG] webhook test hit! params:', req.params, 'body:', req.body);
  try {
    const alertId = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const result2 = await appPool.query(
      'SELECT id FROM alerts WHERE id = $1 AND user_id = $2',
      [alertId, req.userId]
    );
    if (!result2.rows.length) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const data = alertTestWebhookSchema.parse(req.body);
    const webhookUrl = (data.webhookUrl ?? data.webhook_url) as string | undefined;
    if (!webhookUrl) {
      res.status(400).json({ error: 'webhookUrl is required' });
      return;
    }

    const payload = {
      alert_name: '🔔 Test Alert',
      triggered_at: new Date().toISOString(),
      condition: 'eq',
      threshold: 0,
      current_value: 0,
      sql: 'SELECT 1 AS test',
      dashboard_url: 'http://localhost:3000/dashboard',
      _test: true,
    };

    let ok = false;
    let statusText = 'unknown';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const fetchRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      ok = fetchRes.ok;
      statusText = fetchRes.statusText;
    } catch (fetchErr) {
      statusText = fetchErr instanceof Error ? fetchErr.message : 'Request failed';
    }
    res.json({ success: ok, status: statusText });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to test webhook' });
    }
  }
});

// DELETE /api/alerts/:id
schedulingRouter.delete('/alerts/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ message: 'Alert deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});
