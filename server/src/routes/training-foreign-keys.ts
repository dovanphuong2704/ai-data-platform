/**
 * training-foreign-keys.ts
 * GET /api/training/foreign-keys - List FKs from db_foreign_keys table
 */

import { Router } from 'express';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const trainingForeignKeysRouter = Router();
trainingForeignKeysRouter.use(authMiddleware);

// GET /api/training/foreign-keys?connectionId=2&page=1
trainingForeignKeysRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(req.query.connectionId as string, 10);
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, parseInt(req.query.limit as string, 10) || 100);
    const offset = (page - 1) * limit;

    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const [dataResult, countResult] = await Promise.all([
      appPool.query(`
        SELECT id, source_schema, source_table, source_column,
               target_schema, target_table, target_column,
               direction, hint_text, keywords, created_at
        FROM db_foreign_keys
        WHERE connection_id = $1
        ORDER BY source_schema, source_table, source_column
        LIMIT $2 OFFSET $3
      `, [connId, limit, offset]),
      appPool.query(
        `SELECT COUNT(*) FROM db_foreign_keys WHERE connection_id = $1`,
        [connId]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    res.json({
      entries: dataResult.rows,
      totalCount: total,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[training-foreign-keys] error:', err);
    res.status(500).json({ error: String(err) });
  }
});
