/**
 * vanna-docs.ts — Admin routes for business rules documentation
 * Endpoints: list, add, delete docs
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  upsertDoc,
  upsertDocsBulk,
  listDocs,
  deleteDoc,
} from '../services/vanna-docs';

export const vannaDocsRouter = Router();
vannaDocsRouter.use(authMiddleware);

const addDocSchema = z.object({
  connectionId: z.number().nullable(),
  category: z.string().max(50),
  title: z.string().max(200),
  content: z.string().max(5000),
});

const addDocsBulkSchema = z.object({
  connectionId: z.number().nullable(),
  docs: z.array(z.object({
    category: z.string().max(50),
    title: z.string().max(200),
    content: z.string().max(5000),
  })),
});

async function resolveApiKey(req: AuthRequest): Promise<string> {
  const userId = req.userId!;
  const row = await appPool.query(
    `SELECT api_key FROM api_keys
     WHERE user_id = $1
     ORDER BY is_default DESC, id DESC LIMIT 1`,
    [userId],
  );
  if (!row.rows.length) throw new Error('No API key found');
  return (row.rows[0] as { api_key: string }).api_key;
}

// GET /api/vanna-docs — list all docs
vannaDocsRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const connId = req.query.connectionId ? Number(req.query.connectionId) : undefined;
    const docs = await listDocs(connId);
    res.json({ total: docs.length, docs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/vanna-docs — add one doc
vannaDocsRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { connectionId, category, title, content } = addDocSchema.parse(req.body);
    const apiKey = await resolveApiKey(req);
    const id = await upsertDoc(connectionId, category, title, content, apiKey);
    res.json({ success: true, id });
  } catch (err) {
    if (err instanceof z.ZodError) res.status(400).json({ error: 'Validation', details: err.issues });
    else { console.error(err); res.status(500).json({ error: String(err) }); }
  }
});

// POST /api/vanna-docs/bulk — add many docs at once
vannaDocsRouter.post('/bulk', async (req: AuthRequest, res: Response) => {
  try {
    const { connectionId, docs } = addDocsBulkSchema.parse(req.body);
    const apiKey = await resolveApiKey(req);
    const { inserted, errors } = await upsertDocsBulk(connectionId, docs, apiKey);
    res.json({ success: true, inserted, errors });
  } catch (err) {
    if (err instanceof z.ZodError) res.status(400).json({ error: 'Validation', details: err.issues });
    else { console.error(err); res.status(500).json({ error: String(err) }); }
  }
});

// DELETE /api/vanna-docs/:id
vannaDocsRouter.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }
    const deleted = await deleteDoc(id);
    res.json({ success: deleted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
