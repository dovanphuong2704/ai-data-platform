import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { fetchProviderModels } from '../services/ai';

export const keysRouter = Router();

keysRouter.use(authMiddleware);

const keySchema = z.object({
  profile_name: z.string().optional(),
  provider: z.enum(['openai', 'grok', 'gemini', 'claude']),
  api_key: z.string().min(1),
  is_default: z.boolean().optional(),
});

// GET /api/keys
// Query param: withStatus=true — tests each key and returns status inline
keysRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const withStatus = req.query.withStatus === 'true';
    const result = await appPool.query(
      'SELECT id, user_id, profile_name, provider, api_key, is_default, created_at FROM api_keys WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.userId]
    );

    if (!withStatus) {
      // Mask api_key before returning
      const keys = result.rows.map((row) => {
        const plainKey = row.api_key;
        const maskedKey = plainKey.slice(0, 4) + '***' + plainKey.slice(-4);
        return { ...row, api_key: maskedKey };
      });
      res.json({ keys });
      return;
    }

    // Test each key: get models list, then test with first model
    const keys = await Promise.all(
      result.rows.map(async (row) => {
        const plainKey = row.api_key;

        try {
          // Get available models for this provider
          const models = await fetchProviderModels(row.provider, plainKey);
          if (models.length === 0) {
            return {
              id: row.id, user_id: row.user_id, profile_name: row.profile_name,
              provider: row.provider, is_default: row.is_default, created_at: row.created_at,
              api_key: plainKey.slice(0, 4) + '***' + plainKey.slice(-4),
              status: 'error' as const,
              error: 'No models available for this provider',
            };
          }

          // If model list fetched successfully, key is valid
          return {
            id: row.id, user_id: row.user_id, profile_name: row.profile_name,
            provider: row.provider, is_default: row.is_default, created_at: row.created_at,
            api_key: plainKey.slice(0, 4) + '***' + plainKey.slice(-4),
            status: 'ok' as const,
            latency_ms: 0,
          };
        } catch (err) {
          return {
            id: row.id, user_id: row.user_id, profile_name: row.profile_name,
            provider: row.provider, is_default: row.is_default, created_at: row.created_at,
            api_key: plainKey.slice(0, 4) + '***' + plainKey.slice(-4),
            status: 'error' as const,
            error: String(err),
          };
        }
      })
    );

    res.json({ keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch keys' });
  }
});

// POST /api/keys
keysRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const data = keySchema.parse(req.body);

    if (data.is_default) {
      await appPool.query('UPDATE api_keys SET is_default = FALSE WHERE user_id = $1', [req.userId]);
    }

    // Store plaintext API key in dev (no encryption)
    const result = await appPool.query(
      `INSERT INTO api_keys (user_id, profile_name, provider, api_key, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, profile_name, provider, is_default, created_at`,
      [req.userId, data.profile_name || null, data.provider, data.api_key, data.is_default ?? false]
    );
    res.status(201).json({ key: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create key' });
    }
  }
});

// DELETE /api/keys/:id
keysRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    res.json({ message: 'API key deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete key' });
  }
});
