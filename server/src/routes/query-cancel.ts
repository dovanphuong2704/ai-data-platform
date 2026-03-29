import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { cancelQuery, getActiveQueriesByUser } from '../utils/query-cancellations';

export const queryCancelRouter = Router();

queryCancelRouter.use(authMiddleware);

const cancelSchema = z.object({
  queryId: z.string().min(1),
});

// POST /api/query/cancel
queryCancelRouter.post('/cancel', async (req: AuthRequest, res) => {
  try {
    const { queryId } = cancelSchema.parse(req.body);
    const cancelled = cancelQuery(queryId);
    if (!cancelled) {
      res.status(404).json({ error: 'Query not found or already completed' });
      return;
    }
    res.json({ message: 'Query cancelled', queryId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to cancel query' });
    }
  }
});

// GET /api/query/active — list active queries for current user
queryCancelRouter.get('/active', async (req: AuthRequest, res) => {
  try {
    const queryIds = getActiveQueriesByUser(req.userId!);
    res.json({ activeQueries: queryIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active queries' });
  }
});
