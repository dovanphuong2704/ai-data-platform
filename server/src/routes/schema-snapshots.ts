/**
 * schema-snapshots.ts — Admin routes for schema snapshot management
 *
 * GET  /api/schema-snapshots          — list all snapshots
 * GET  /api/schema-snapshots/:connId  — get snapshot for a connection
 * POST /api/schema-snapshots/refresh  — force refresh from target DB
 * DELETE /api/schema-snapshots/:connId — delete snapshot
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { appPool, createConnectionPool } from '../services/db';
import {
  listSchemaSnapshots,
  getSchemaSnapshot,
  saveSchemaSnapshot,
  deleteSchemaSnapshot,
  getCachedSchemaWithText,
  buildSchemaTextFromEnriched,
  EnrichedSchema,
} from '../services/schema-store';
import { syncForeignKeys } from '../services/foreign-key-retrieval';

export const schemaSnapshotsRouter = Router();
schemaSnapshotsRouter.use(authMiddleware);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTargetPool(connectionId: number, userId: number): Promise<Pool> {
  const connRow = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  if (!connRow.rows.length) throw new Error('Connection not found');
  const c = connRow.rows[0] as { db_host: string; db_port: string; db_name: string; db_user: string; db_password: string };
  return createConnectionPool(
    `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`
  );
}

// ─── GET /api/schema-snapshots ───────────────────────────────────────────────
/** List all snapshots */
schemaSnapshotsRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const snapshots = await listSchemaSnapshots();
    res.json({
      total: snapshots.length,
      snapshots: snapshots.map(s => ({
        connection_id: s.connection_id,
        table_count: s.table_count,
        column_count: s.column_count,
        version_hash: s.version_hash,
        updated_at: s.updated_at,
      })),
    });
  } catch (err) {
    console.error('[schema-snapshots] list error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/schema-snapshots/:connId ───────────────────────────────────────
/** Get snapshot for a connection */
schemaSnapshotsRouter.get('/:connId', async (req: AuthRequest, res: Response) => {
  try {
    const connId = parseInt(String(req.params.connId), 10);
    if (isNaN(connId)) { res.status(400).json({ error: 'Invalid connection ID' }); return; }

    // Verify user owns this connection
    const owner = await appPool.query(
      `SELECT 1 FROM db_connections WHERE id = $1 AND user_id = $2`, [connId, req.userId]
    );
    if (!owner.rows.length) { res.status(403).json({ error: 'Not authorized' }); return; }

    const snapshot = await getSchemaSnapshot(connId);
    if (!snapshot) { res.status(404).json({ error: 'No snapshot found' }); return; }

    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/schema-snapshots/refresh ───────────────────────────────────────
const refreshSchema = z.object({
  connectionId: z.number(),
});

/** Force-refresh a snapshot from the target DB */
schemaSnapshotsRouter.post('/refresh', async (req: AuthRequest, res: Response) => {
  try {
    const { connectionId } = refreshSchema.parse(req.body);

    // Verify user owns this connection
    const owner = await appPool.query(
      `SELECT 1 FROM db_connections WHERE id = $1 AND user_id = $2`, [connectionId, req.userId]
    );
    if (!owner.rows.length) { res.status(403).json({ error: 'Not authorized or not found' }); return; }

    sendSSE(res, 'status', { message: 'Fetching schema from target DB...' });

    const targetPool = await getTargetPool(connectionId, req.userId!);

    try {
      // Fetch fresh schema
      const colResult = await targetPool.query(`
        SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
               c.column_default, NULL AS description
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
        LIMIT 500
      `);

      const fkResult = await targetPool.query(`
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

      const enriched: EnrichedSchema = {
        columns: colResult.rows as EnrichedSchema['columns'],
        foreignKeys: fkResult.rows as EnrichedSchema['foreignKeys'],
      };

      // Build focused text (empty question for full schema)
      const schemaText = buildSchemaTextFromEnriched(enriched, '');

      // Save snapshot
      const snapshot = await saveSchemaSnapshot(connectionId, enriched, schemaText);

      // Also sync FKs (in background — non-blocking)
      syncForeignKeys(connectionId, targetPool)
        .then(r => console.log(`[schema-refresh] conn ${connectionId} FKs: ${r.synced} hard, ${r.softSynced} soft, ${r.errors} errors`))
        .catch(e => console.warn(`[schema-refresh] conn ${connectionId} FK sync failed:`, e));

      res.json({
        success: true,
        connection_id: snapshot.connection_id,
        table_count: snapshot.table_count,
        column_count: snapshot.column_count,
        updated_at: snapshot.updated_at,
      });
    } finally {
      await targetPool.end();
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error('[schema-snapshots] refresh error:', err);
      res.status(500).json({ error: String(err) });
    }
  }
});

// ─── DELETE /api/schema-snapshots/:connId ─────────────────────────────────────
/** Delete a snapshot */
schemaSnapshotsRouter.delete('/:connId', async (req: AuthRequest, res: Response) => {
  try {
    const connId = parseInt(String(req.params.connId), 10);
    if (isNaN(connId)) { res.status(400).json({ error: 'Invalid connection ID' }); return; }

    const owner = await appPool.query(
      `SELECT 1 FROM db_connections WHERE id = $1 AND user_id = $2`, [connId, req.userId]
    );
    if (!owner.rows.length) { res.status(403).json({ error: 'Not authorized or not found' }); return; }

    await deleteSchemaSnapshot(connId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Tiny SSE helper (inline to avoid circular import) ─────────────────────────
function sendSSE(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
