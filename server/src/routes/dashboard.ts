import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const dashboardRouter = Router();

dashboardRouter.use(authMiddleware);

const itemSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['table', 'chart', 'query']),
  data: z.record(z.string(), z.unknown()),
  chartType: z.string().optional(),
});

// GET /api/dashboard
dashboardRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'SELECT id, data, created_at FROM user_dashboards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// POST /api/dashboard
dashboardRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const data = itemSchema.parse(req.body);

    const result = await appPool.query(
      'INSERT INTO user_dashboards (user_id, data) VALUES ($1, $2) RETURNING id, data, created_at',
      [req.userId, data]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to add to dashboard' });
    }
  }
});

// PUT /api/dashboard/:id
dashboardRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = itemSchema.partial().parse(req.body);

    const result = await appPool.query(
      'UPDATE user_dashboards SET data = data || $1 WHERE id = $2 AND user_id = $3 RETURNING id, data, created_at',
      [JSON.stringify(data), id, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Dashboard item not found' });
      return;
    }

    res.json({ item: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update dashboard item' });
    }
  }
});

// DELETE /api/dashboard/:id
dashboardRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM user_dashboards WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Dashboard item not found' });
      return;
    }
    res.json({ message: 'Dashboard item removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove dashboard item' });
  }
});
