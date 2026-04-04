/**
 * vanna-rag.ts — Admin routes for Vanna RAG management
 * Endpoints to train, list, and delete VI→SQL training examples.
 */

import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  upsertTrainingData,
  upsertTrainingDataBulk,
  getSimilarSQL,
  countTrainingData,
  listTrainingData,
  deleteTrainingData,
  generateTrainingExamples,
} from '../services/vanna-rag';
import { getChatModelConfig, createChatModel } from '../services/ai';

export const vannaRouter = Router();
vannaRouter.use(authMiddleware);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const manualTrainSchema = z.object({
  connectionId: z.number(),
  question: z.string().min(1).max(1000),
  sql: z.string().min(1).max(3000),
});

const autoTrainSchema = z.object({
  connectionId: z.number(),
  count: z.number().int().min(5).max(100).default(25),
  provider: z.enum(['openai', 'grok', 'gemini', 'claude']).optional(),
  apiKeyId: z.number().optional(),
  model: z.string().optional(),
});

const deleteSchema = z.object({
  id: z.number(),
});

const listSchema = z.object({
  connectionId: z.string().transform(Number),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveApiKey(req: AuthRequest, opts?: { provider?: string; apiKeyId?: number; model?: string }) {
  const userId = req.userId!;

  if (opts?.apiKeyId) {
    const row = await appPool.query(
      `SELECT api_key, provider FROM api_keys WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [opts.apiKeyId, userId]
    );
    if (!row.rows.length) throw new Error('API key not found');
    const r = row.rows[0] as { api_key: string; provider: string };
    return {
      apiKey: r.api_key,
      provider: opts.provider ?? r.provider,
      model: opts.model ?? undefined,
    };
  }

  // Fetch default key
  const row = await appPool.query(
    `SELECT api_key, provider FROM api_keys
     WHERE user_id = $1
     ORDER BY is_default DESC, id DESC LIMIT 1`,
    [userId]
  );
  if (!row.rows.length) throw new Error('No API key configured');
  const r = row.rows[0] as { api_key: string; provider: string };
  return {
    apiKey: r.api_key,
    provider: opts?.provider ?? r.provider,
    model: opts?.model ?? undefined,
  };
}

// ─── POST /api/vanna-rag/train ────────────────────────────────────────────────
/**
 * Add a single VI→SQL training pair manually.
 */
vannaRouter.post('/train', async (req: AuthRequest, res) => {
  try {
    const { connectionId, question, sql } = manualTrainSchema.parse(req.body);
    const { apiKey } = await resolveApiKey(req);
    const id = await upsertTrainingData(connectionId, question, sql, apiKey);
    res.json({ success: true, id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[vanna-rag] train error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// ─── POST /api/vanna-rag/train-auto ───────────────────────────────────────────
/**
 * Auto-generate VI→SQL examples via LLM then embed + store.
 */
vannaRouter.post('/train-auto', async (req: AuthRequest, res) => {
  try {
    const { connectionId, count, provider, apiKeyId, model } = autoTrainSchema.parse(req.body);
    const { apiKey, provider: resolvedProvider, model: resolvedModel } = await resolveApiKey(req, { provider, apiKeyId, model });

    // 1. Fetch schema for this connection
    const connRow = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, req.userId]
    );
    if (!connRow.rows.length) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    const conn = connRow.rows[0] as { db_host: string; db_port: string; db_name: string; db_user: string; db_password: string };
    const pgPool = await appPool.query(
      `SELECT
         t.table_schema, t.table_name, c.column_name, c.data_type
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY t.table_schema, t.table_name, c.ordinal_position`
    );
    const schemaRows = pgPool.rows as Array<{ table_schema: string; table_name: string; column_name: string; data_type: string }>;

    // Build simple schema description
    const schemaLines: string[] = [];
    for (const r of schemaRows) {
      schemaLines.push(`${r.table_schema}.${r.table_name}.${r.column_name} (${r.data_type})`);
    }
    const schemaDescription = schemaLines.join('\n');

    // 2. Generate examples via LLM
    const generated = await generateTrainingExamples(
      schemaDescription,
      resolvedProvider,
      apiKey,
      resolvedModel ?? '',
      count,
    );

    if (!generated.length) {
      res.status(500).json({ error: 'Failed to generate any training examples' });
      return;
    }

    // 3. Embed + store
    const { inserted, errors } = await upsertTrainingDataBulk(connectionId, generated, apiKey);

    res.json({
      success: true,
      generated: generated.length,
      inserted,
      errors,
      examples: generated.slice(0, 5), // preview first 5
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[vanna-rag] train-auto error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// ─── GET /api/vanna-rag/examples ─────────────────────────────────────────────
/**
 * List all training examples for a connection.
 */
vannaRouter.get('/examples', async (req: AuthRequest, res) => {
  try {
    const { connectionId } = listSchema.parse(req.query);
    const examples = await listTrainingData(connectionId);
    const total = await countTrainingData(connectionId);
    res.json({ total, examples });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid params', details: err.issues });
    } else {
      console.error('[vanna-rag] list error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// ─── GET /api/vanna-rag/count ─────────────────────────────────────────────────
/**
 * Quick count of training examples.
 */
vannaRouter.get('/count', async (req: AuthRequest, res) => {
  try {
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;
    const count = await countTrainingData(connectionId);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── DELETE /api/vanna-rag/examples/:id ──────────────────────────────────────
/**
 * Delete a training example by ID.
 */
vannaRouter.delete('/examples/:id', async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const deleted = await deleteTrainingData(id);
    res.json({ success: deleted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/vanna-rag/test ─────────────────────────────────────────────────
/**
 * Test retrieval: given a question, return top-K similar examples.
 */
vannaRouter.get('/test', async (req: AuthRequest, res) => {
  try {
    const question = req.query.question as string;
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : 0;
    const topK = req.query.topK ? Number(req.query.topK) : 5;
    if (!question) {
      res.status(400).json({ error: 'question param required' });
      return;
    }
    const { apiKey } = await resolveApiKey(req);
    const examples = await getSimilarSQL(question, connectionId, apiKey, topK);
    res.json({ question, examples });
  } catch (err) {
    console.error('[vanna-rag] test error:', err);
    res.status(500).json({ error: String(err) });
  }
});
