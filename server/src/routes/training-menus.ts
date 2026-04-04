/**
 * training-menus.ts
 * GET/DELETE /api/training/menus - Table menu CRUD
 */

import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { invalidateTableMenu } from '../services/table-menu';

export const trainingMenusRouter = Router();
trainingMenusRouter.use(authMiddleware);

// GET /api/training/menus?connectionId=2
trainingMenusRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(req.query.connectionId as string, 10);
    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const result = await appPool.query(
      `SELECT id, connection_id, menu_json, total_tables, generated_at
       FROM db_table_menus WHERE connection_id = $1`,
      [connId]
    );

    if (!result.rows.length) {
      res.json({ data: null, message: 'No menu cached' });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[training-menus] error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/training/menus/:connId
trainingMenusRouter.delete('/:connId', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(String(req.params.connId), 10);
    await invalidateTableMenu(connId);
    res.json({ success: true });
  } catch (err) {
    console.error('[training-menus] delete error:', err);
    res.status(500).json({ error: String(err) });
  }
});
