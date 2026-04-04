import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { invalidateSchemaCache } from './chat';
import { seedConnection } from '../services/connection-seeder';

export const connectionsRouter = Router();

connectionsRouter.use(authMiddleware);

const connectionSchema = z.object({
  profile_name: z.string().optional(),
  db_host: z.string().min(1),
  db_port: z.string().min(1),
  db_name: z.string().min(1),
  db_user: z.string().min(1),
  db_password: z.string().min(1),
  is_default: z.boolean().optional(),
});

// GET /api/connections
// Query param: withStatus=true — tests each connection and returns status inline
connectionsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const withStatus = req.query.withStatus === 'true';
    const result = await appPool.query(
      'SELECT id, user_id, profile_name, db_host, db_port, db_name, db_user, db_password, is_default, created_at FROM db_connections WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.userId]
    );

    if (!withStatus) {
      // Strip passwords from response
      const safe = result.rows.map(r => { const { db_password, ...rest } = r; return rest; });
      res.json({ connections: safe });
      return;
    }

    // Test each connection concurrently
    const connections = await Promise.all(
      result.rows.map(async (conn) => {
        const { db_password, ...safe } = conn;
        try {
          const connectionString = `postgresql://${conn.db_user}:${db_password}@${conn.db_host}:${conn.db_port}/${conn.db_name}`;
          const testPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
          const start = Date.now();
          await testPool.query('SELECT 1');
          await testPool.end();
          return { ...safe, status: 'ok' as const, latency_ms: Date.now() - start };
        } catch (err) {
          return { ...safe, status: 'error' as const, error: String(err) };
        }
      })
    );

    res.json({ connections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// POST /api/connections
connectionsRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const data = connectionSchema.parse(req.body);

    // If is_default, unset others
    if (data.is_default) {
      await appPool.query('UPDATE db_connections SET is_default = FALSE WHERE user_id = $1', [req.userId]);
    }

    const result = await appPool.query(
      `INSERT INTO db_connections (user_id, profile_name, db_host, db_port, db_name, db_user, db_password, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, profile_name, db_host, db_port, db_name, db_user, is_default, created_at`,
      [req.userId, data.profile_name || null, data.db_host, data.db_port, data.db_name, data.db_user, data.db_password, data.is_default ?? false]
    );

    const newConn = result.rows[0];

    // Auto-seed training data in background (non-blocking)
    appPool.query(
      `SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`
    ).then(keyRow => {
      if (keyRow.rows.length > 0) {
        const { api_key, provider } = keyRow.rows[0] as { api_key: string; provider: string };
        seedConnection(newConn.id, api_key, provider)
          .then(r => console.log(`[seeder] conn ${newConn.id} done:`, r))
          .catch(e => console.error(`[seeder] conn ${newConn.id} failed:`, e));
      }
    }).catch(() => {}); // ignore key lookup errors

    res.status(201).json({ connection: newConn, seeding: 'started' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create connection' });
    }
  }
});

// PUT /api/connections/:id
connectionsRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = connectionSchema.partial().parse(req.body);

    if (data.is_default) {
      await appPool.query('UPDATE db_connections SET is_default = FALSE WHERE user_id = $1', [req.userId]);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(id, req.userId);
    const result = await appPool.query(
      `UPDATE db_connections SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    invalidateSchemaCache(Number(id));

    // Reseed if credentials or host changed (full refresh)
    const changed = data.db_host || data.db_port || data.db_name || data.db_user || data.db_password;
    if (changed) {
      appPool.query(`SELECT api_key, provider FROM api_keys ORDER BY is_default DESC, id DESC LIMIT 1`)
        .then(keyRow => {
          if (keyRow.rows.length > 0) {
            const { api_key, provider } = keyRow.rows[0] as { api_key: string; provider: string };
            seedConnection(Number(id), api_key, provider)
              .then(r => console.log(`[seeder] conn ${id} reseeded:`, r))
              .catch(e => console.error(`[seeder] conn ${id} reseed failed:`, e));
          }
        }).catch(() => {});
    }

    res.json({ connection: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update connection' });
    }
  }
});

// GET /api/connections/:id/test — test a saved DB connection
connectionsRouter.get('/:id/test', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const connResult = await appPool.query(
      'SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );

    if (connResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }

    const { db_host, db_port, db_name, db_user, db_password } = connResult.rows[0];
    const connectionString = `postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}`;
    const testPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });

    const start = Date.now();
    try {
      await testPool.query('SELECT 1');
      const latency_ms = Date.now() - start;
      res.json({ success: true, latency_ms });
    } finally {
      await testPool.end();
    }
  } catch (err) {
    res.json({ success: false, error: String(err) });
  }
});

// DELETE /api/connections/:id
connectionsRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM db_connections WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    invalidateSchemaCache(Number(req.params.id));
    res.json({ message: 'Connection deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

// POST /api/connections/test — test DB credentials
const testSchema = z.object({
  db_host: z.string().min(1),
  db_port: z.string().min(1),
  db_name: z.string().min(1),
  db_user: z.string().min(1),
  db_password: z.string().min(1),
});

connectionsRouter.post('/test', async (req: AuthRequest, res) => {
  try {
    const data = testSchema.parse(req.body);
    const connectionString = `postgresql://${data.db_user}:${data.db_password}@${data.db_host}:${data.db_port}/${data.db_name}`;
    const testPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 3000 });

    const start = Date.now();
    try {
      await testPool.query('SELECT 1');
      const latency_ms = Date.now() - start;
      res.json({ success: true, latency_ms });
    } finally {
      await testPool.end();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      res.json({ success: false, error: String(err) });
    }
  }
});
