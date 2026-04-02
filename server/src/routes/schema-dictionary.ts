import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const schemaDictRouter = Router();

schemaDictRouter.use(authMiddleware);

const dictSchema = z.object({
  vi_keywords: z.string().min(1).max(500),
  en_keywords: z.string().min(1).max(500),
  category: z.string().max(50).optional(),
  is_active: z.boolean().optional(),
});

const updateDictSchema = dictSchema.partial();

// ── In-memory cache ─────────────────────────────────────────────────────────────
// Loaded from DB, refreshed on update. Key = null (global per server).
let dictCache: Array<{ vi: string[]; en: string[]; category: string }> | null = null;
let dictCacheTs = 0;
const DICT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function loadDictFromDb(): Promise<Array<{ vi: string[]; en: string[]; category: string }>> {
  const result = await appPool.query(
    `SELECT vi_keywords, en_keywords, category FROM schema_dictionary
     WHERE is_active = TRUE
     ORDER BY category, id`,
  );
  return result.rows.map(row => ({
    vi: String(row.vi_keywords).split(',').map(s => s.trim()).filter(Boolean),
    en: String(row.en_keywords).split(',').map(s => s.trim()).filter(Boolean),
    category: String(row.category || 'general'),
  }));
}

async function getDict(): Promise<Array<{ vi: string[]; en: string[]; category: string }>> {
  if (!dictCache || Date.now() - dictCacheTs > DICT_CACHE_TTL_MS) {
    dictCache = await loadDictFromDb();
    dictCacheTs = Date.now();
  }
  return dictCache;
}

function invalidateDictCache(): void {
  dictCache = null;
  dictCacheTs = 0;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/schema-dictionary — list all entries (paginated)
schemaDictRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    const countResult = await appPool.query(
      'SELECT COUNT(*) FROM schema_dictionary'
    );
    const total = Number(countResult.rows[0].count);

    const result = await appPool.query(
      `SELECT id, vi_keywords, en_keywords, category, is_active, created_at, updated_at
       FROM schema_dictionary
       ORDER BY category, id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      entries: result.rows.map(row => ({
        id: row.id,
        vi_keywords: row.vi_keywords,
        en_keywords: row.en_keywords,
        category: row.category,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[schema-dictionary GET]', err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/schema-dictionary/export — export all as JSON (for editing & re-import)
schemaDictRouter.get('/export', async (req: AuthRequest, res) => {
  try {
    const result = await appPool.query(
      `SELECT id, vi_keywords, en_keywords, category, is_active
       FROM schema_dictionary ORDER BY category, id`
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error('[schema-dictionary export]', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/schema-dictionary/import — bulk import (replace or append mode)
schemaDictRouter.post('/import', async (req: AuthRequest, res) => {
  const schema = z.object({
    mode: z.enum(['replace', 'append']).default('append'),
    entries: z.array(z.object({
      vi_keywords: z.string().min(1),
      en_keywords: z.string().min(1),
      category: z.string().optional(),
      is_active: z.boolean().optional(),
    })).min(1),
  });

  try {
    const { mode, entries } = schema.parse(req.body);
    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      if (mode === 'replace') {
        await client.query('DELETE FROM schema_dictionary');
      }

      let inserted = 0;
      for (const entry of entries) {
        await client.query(
          `INSERT INTO schema_dictionary (vi_keywords, en_keywords, category, is_active)
           VALUES ($1, $2, $3, $4)`,
          [entry.vi_keywords, entry.en_keywords, entry.category ?? 'general', entry.is_active ?? true]
        );
        inserted++;
      }

      await client.query('COMMIT');
      invalidateDictCache();

      res.json({ success: true, imported: inserted, mode });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[schema-dictionary import]', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// POST /api/schema-dictionary — create entry
schemaDictRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const body = dictSchema.parse(req.body);
    const result = await appPool.query(
      `INSERT INTO schema_dictionary (vi_keywords, en_keywords, category, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, vi_keywords, en_keywords, category, is_active, created_at, updated_at`,
      [body.vi_keywords, body.en_keywords, body.category ?? 'general', body.is_active ?? true]
    );
    invalidateDictCache();
    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[schema-dictionary POST]', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// PUT /api/schema-dictionary/:id — update entry
schemaDictRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const body = updateDictSchema.parse(req.body);

    const result = await appPool.query(
      `UPDATE schema_dictionary SET
         vi_keywords = COALESCE($1, vi_keywords),
         en_keywords = COALESCE($2, en_keywords),
         category = COALESCE($3, category),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = $5
       RETURNING id, vi_keywords, en_keywords, category, is_active, created_at, updated_at`,
      [body.vi_keywords, body.en_keywords, body.category, body.is_active, id]
    );

    if (!result.rows.length) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    invalidateDictCache();
    res.json({ entry: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[schema-dictionary PUT]', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// DELETE /api/schema-dictionary/:id — delete entry
schemaDictRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    const result = await appPool.query(
      'DELETE FROM schema_dictionary WHERE id = $1 RETURNING id',
      [id]
    );

    if (!result.rows.length) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    invalidateDictCache();
    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('[schema-dictionary DELETE]', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/schema-dictionary/refresh — force reload cache
schemaDictRouter.post('/refresh', async (req: AuthRequest, res) => {
  try {
    invalidateDictCache();
    const dict = await getDict();
    res.json({ success: true, entries: dict.length });
  } catch (err) {
    console.error('[schema-dictionary refresh]', err);
    res.status(500).json({ error: String(err) });
  }
});

// Export getter so chat.ts can use it
export { getDict };
