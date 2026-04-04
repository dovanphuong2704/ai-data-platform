/**
 * training-summaries.ts
 * GET /api/training/summaries - Table summaries with embeddings
 */

import { Router } from 'express';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const trainingSummariesRouter = Router();
trainingSummariesRouter.use(authMiddleware);

// GET /api/training/summaries?connectionId=2&page=1
trainingSummariesRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(req.query.connectionId as string, 10);
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string, 10) || 50);
    const offset = (page - 1) * limit;

    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const [dataResult, countResult] = await Promise.all([
      appPool.query(`
        SELECT table_schema, table_name, summary_text, column_list, fk_hint, embedding
        FROM db_table_summaries
        WHERE connection_id = $1
        ORDER BY table_schema, table_name
        LIMIT $2 OFFSET $3
      `, [connId, limit, offset]),
      appPool.query(
        `SELECT COUNT(*) AS total FROM db_table_summaries WHERE connection_id = $1`,
        [connId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    res.json({
      entries: dataResult.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[training-summaries] error:', err);
    res.status(500).json({ error: String(err) });
  }
});
