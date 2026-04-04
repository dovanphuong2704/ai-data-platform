/**
 * training-seed.ts
 * POST /api/training/seed - Run seeding for specific sections
 */

import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { appPool, createConnectionPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { seedConnection } from '../services/connection-seeder';
import { getChatModelConfig } from '../services/ai';

export const trainingSeedRouter = Router();
trainingSeedRouter.use(authMiddleware);

const seedSchema = z.object({
  connectionId: z.number(),
  sections: z.array(z.enum(['all', 'menu', 'summaries', 'fks', 'examples', 'snapshot'])).default(['all']),
});

// POST /api/training/seed
trainingSeedRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { connectionId, sections } = seedSchema.parse(req.body);

    // Verify connection ownership + get credentials
    const connRow = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, req.userId]
    );
    if (!connRow.rows.length) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    // Get API key
    const keyRow = await appPool.query(
      `SELECT api_key, provider FROM api_keys WHERE user_id = $1 ORDER BY is_default DESC, id DESC LIMIT 1`,
      [req.userId]
    );
    if (!keyRow.rows.length) {
      res.status(400).json({ error: 'No API key configured' });
      return;
    }
    const { api_key, provider } = keyRow.rows[0] as { api_key: string; provider: string };

    // If only specific sections, do targeted seeding inline
    if (!sections.includes('all')) {
      const { db_host, db_port, db_name, db_user, db_password } = connRow.rows[0];
      const pool = await createConnectionPool(
        `postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}`
      );

      try {
        const results: Record<string, unknown> = {};

        if (sections.includes('menu')) {
          const { buildTableMenuFromPool, saveTableMenu } = await import('../services/table-menu');
          const items = await buildTableMenuFromPool(pool);
          await saveTableMenu(connectionId, items);
          results.menu = items.length;
        }

        if (sections.includes('fks')) {
          const { syncForeignKeys } = await import('../services/foreign-key-retrieval');
          const r = await syncForeignKeys(connectionId, pool);
          results.fks = { hard: r.synced, soft: r.softSynced };
        }

        if (sections.includes('snapshot')) {
          const { saveSchemaSnapshot, inferLogicalFKs } = await import('../services/schema-store');
          const colResult = await pool.query(`
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
                   c.column_default,
                   col_description(pc.oid, c.ordinal_position::int) AS description
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            LEFT JOIN pg_class pc
              ON pc.relname = c.table_name
             AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema)
            WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
          `);
          const fkResult = await pool.query(`
            SELECT tc.table_schema, tc.table_name, kcu.column_name,
                   ccu.table_schema AS foreign_table_schema,
                   ccu.table_name AS foreign_table_name,
                   ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          `);
          const logicalFKs = inferLogicalFKs(colResult.rows);
          const seenFK = new Set<string>();
          const allFKs = [...fkResult.rows];
          for (const lfk of logicalFKs) {
            const key = `${lfk.table_schema}.${lfk.table_name}.${lfk.column_name}->${lfk.foreign_table_schema}.${lfk.foreign_table_name}.${lfk.foreign_column_name}`;
            if (!seenFK.has(key)) { seenFK.add(key); allFKs.push(lfk); }
          }
          await saveSchemaSnapshot(connectionId, { columns: colResult.rows, foreignKeys: allFKs }, '');
          results.snapshot = { tables: colResult.rows.length, fks: allFKs.length };
        }

        // summaries and examples require full seed (they use embeddings)
        if (sections.includes('summaries') || sections.includes('examples')) {
          // summaries + examples need full seedConnection
          const fullResult = await seedConnection(connectionId, api_key, provider);
          if (sections.includes('summaries')) results.summaries = fullResult.tableSummaries;
          if (sections.includes('examples')) results.examples = fullResult.trainingExamples;
        }

        res.json({ success: true, sections: sections.join(','), results });
        return;
      } finally {
        await pool.end();
      }
    }

    // Full seed
    const result = await seedConnection(connectionId, api_key, provider);
    res.json({
      success: true,
      sections: 'all',
      results: {
        menu: result.tableMenu,
        summaries: result.tableSummaries,
        fks: { hard: result.foreignKeys },
        snapshot: result.schemaSnapshot,
        examples: result.trainingExamples,
        errors: result.errors,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[training-seed] error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});
