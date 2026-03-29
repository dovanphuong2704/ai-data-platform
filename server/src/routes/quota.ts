import { Router } from 'express';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const quotaRouter = Router();

quotaRouter.use(authMiddleware);

// GET /api/quota — get current quota status for user
quotaRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'SELECT query_count, query_limit, chat_count, chat_limit, window_start FROM user_quotas WHERE user_id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.json({
        query: { current: 0, limit: 100, remaining: 100 },
        chat: { current: 0, limit: 50, remaining: 50 },
        windowStart: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3600000).toISOString(),
      });
      return;
    }

    const row = result.rows[0] as {
      query_count: number;
      query_limit: number;
      chat_count: number;
      chat_limit: number;
      window_start: Date;
    };

    const WINDOW_MS = 60 * 60 * 1000;
    const now = Date.now();
    const windowStartMs = new Date(row.window_start).getTime();
    const expired = now - windowStartMs > WINDOW_MS;

    const queryRemaining = expired ? row.query_limit : Math.max(0, row.query_limit - row.query_count);
    const chatRemaining = expired ? row.chat_limit : Math.max(0, row.chat_limit - row.chat_count);

    res.json({
      query: {
        current: expired ? 0 : row.query_count,
        limit: row.query_limit,
        remaining: queryRemaining,
      },
      chat: {
        current: expired ? 0 : row.chat_count,
        limit: row.chat_limit,
        remaining: chatRemaining,
      },
      windowStart: new Date(windowStartMs).toISOString(),
      resetAt: new Date(windowStartMs + WINDOW_MS).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quota' });
  }
});
