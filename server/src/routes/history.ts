import { Router } from 'express';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const historyRouter = Router();

historyRouter.use(authMiddleware);

const MAX_HISTORY_PER_USER = 500;
const HISTORY_RETENTION_DAYS = 30;

// ─── Auto-cleanup ─────────────────────────────────────────────────────────────
// Runs non-blocking after each INSERT to keep table lean.
// Keeps at most MAX_HISTORY_PER_USER records per user + removes anything older than 30 days.

async function cleanupHistory(userId: number): Promise<void> {
  try {
    // Step 1: Delete records older than 30 days
    await appPool.query(
      `DELETE FROM sql_query_history
       WHERE user_id = $1
         AND created_at < NOW() - INTERVAL '${HISTORY_RETENTION_DAYS} days'`,
      [userId]
    );

    // Step 2: If still over MAX_HISTORY_PER_USER, delete the oldest extras
    await appPool.query(
      `DELETE FROM sql_query_history
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM sql_query_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT ${MAX_HISTORY_PER_USER}
         )`,
      [userId]
    );
  } catch (err) {
    console.error('[cleanupHistory]', err);
  }
}

// ─── GET /api/history ─────────────────────────────────────────────────────────
historyRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const result = await appPool.query(
      `SELECT id, connection_id, sql, status, duration_ms, rows_returned, error_message, created_at
       FROM sql_query_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const countResult = await appPool.query(
      'SELECT COUNT(*) as total FROM sql_query_history WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      history: result.rows,
      total: Number(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ─── DELETE /api/history/:id ────────────────────────────────────────────────
historyRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM sql_query_history WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'History entry not found' });
      return;
    }
    res.json({ message: 'History entry deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete history entry' });
  }
});

// ─── DELETE /api/history ────────────────────────────────────────────────────
historyRouter.delete('/', async (req: AuthRequest, res) => {
  try {
    await appPool.query(
      'DELETE FROM sql_query_history WHERE user_id = $1',
      [req.userId]
    );
    res.json({ message: 'All history cleared' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

export { cleanupHistory };
