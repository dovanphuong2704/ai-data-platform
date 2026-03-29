import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const savedQueriesRouter = Router();

savedQueriesRouter.use(authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(255),
  sql: z.string().min(1),
  description: z.string().optional(),
  connectionId: z.number().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/saved-queries — list (no sql content)
savedQueriesRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, name, description, connection_id, created_at, updated_at
       FROM saved_queries
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.userId]
    );
    res.json({ savedQueries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch saved queries' });
  }
});

// GET /api/saved-queries/:id — get single with full SQL
savedQueriesRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, name, sql, description, connection_id, created_at, updated_at
       FROM saved_queries
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Saved query not found' });
      return;
    }
    res.json({ savedQuery: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch saved query' });
  }
});

// POST /api/saved-queries — create
savedQueriesRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const data = createSchema.parse(req.body);
    const result = await appPool.query(
      `INSERT INTO saved_queries (user_id, name, sql, description, connection_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, connection_id, created_at, updated_at`,
      [req.userId, data.name, data.sql, data.description ?? null, data.connectionId ?? null]
    );
    res.status(201).json({ savedQuery: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create saved query' });
    }
  }
});

// PUT /api/saved-queries/:id — update
savedQueriesRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const data = updateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
    if (data.sql !== undefined) { fields.push(`sql = $${idx++}`); values.push(data.sql); }
    if (data.description !== undefined) { fields.push(`description = $${idx++}`); values.push(data.description); }
    if (data.connectionId !== undefined) { fields.push(`connection_id = $${idx++}`); values.push(data.connectionId); }
    fields.push(`updated_at = NOW()`);

    if (fields.length === 1) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id, req.userId);
    const result = await appPool.query(
      `UPDATE saved_queries SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Saved query not found' });
      return;
    }
    res.json({ savedQuery: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update saved query' });
    }
  }
});

// DELETE /api/saved-queries/:id
savedQueriesRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM saved_queries WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Saved query not found' });
      return;
    }
    res.json({ message: 'Saved query deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete saved query' });
  }
});
