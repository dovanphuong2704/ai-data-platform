/**
 * training-examples.ts
 * CRUD for VI→SQL training examples (extends vanna-rag with pagination + list view)
 */

import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listTrainingData, deleteTrainingData } from '../services/vanna-rag';

export const trainingExamplesRouter = Router();
trainingExamplesRouter.use(authMiddleware);

// GET /api/training/examples?connectionId=2&page=1
trainingExamplesRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(req.query.connectionId as string, 10);
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string, 10) || 20);
    const offset = (page - 1) * limit;

    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const [result, countResult] = await Promise.all([
      appPool.query(`
        SELECT id, connection_id, question_vi, sql, source, created_at
        FROM vanna_training_data
        WHERE connection_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [connId, limit, offset]),
      appPool.query(
        `SELECT COUNT(*) FROM vanna_training_data WHERE connection_id = $1`,
        [connId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    res.json({
      entries: result.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[training-examples] list error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/training/examples
const addExampleSchema = z.object({
  connectionId: z.number(),
  question: z.string().min(1).max(1000),
  sql: z.string().min(1).max(3000),
});

trainingExamplesRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { connectionId, question, sql } = addExampleSchema.parse(req.body);

    // Verify connection ownership
    const connCheck = await appPool.query(
      `SELECT id FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, req.userId]
    );
    if (!connCheck.rows.length) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const result = await appPool.query(`
      INSERT INTO vanna_training_data (connection_id, question_vi, sql, source)
      VALUES ($1, $2, $3, 'manual-ui')
      ON CONFLICT (connection_id, question_vi) DO UPDATE SET
        sql = EXCLUDED.sql, source = EXCLUDED.source
      RETURNING id
    `, [connectionId, question, sql]);

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[training-examples] add error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// DELETE /api/training/examples/:id
trainingExamplesRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) {
      res.status(400).json({ error: 'id required' });
      return;
    }

    await appPool.query(
      `DELETE FROM vanna_training_data WHERE id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[training-examples] delete error:', err);
    res.status(500).json({ error: String(err) });
  }
});
