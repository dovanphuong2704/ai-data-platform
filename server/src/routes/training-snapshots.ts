/**
 * training-snapshots.ts
 * GET/POST/DELETE /api/training/snapshots - Schema snapshot management
 */

import { Router } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { appPool, createConnectionPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getSchemaSnapshot, saveSchemaSnapshot, deleteSchemaSnapshot } from '../services/schema-store';
import { syncForeignKeys } from '../services/foreign-key-retrieval';
import { buildTableMenuFromPool, saveTableMenu } from '../services/table-menu';

export const trainingSnapshotsRouter = Router();
trainingSnapshotsRouter.use(authMiddleware);

const refreshSchema = z.object({
  connectionId: z.number(),
});

// GET /api/training/snapshots?connId=2
trainingSnapshotsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(req.query.connId as string, 10);
    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const snapshot = await getSchemaSnapshot(connId);
    if (!snapshot) {
      res.json({ data: null, message: 'No snapshot cached' });
      return;
    }

    res.json({
      data: {
        table_count: snapshot.table_count,
        column_count: snapshot.column_count,
        version_hash: snapshot.version_hash,
        updated_at: snapshot.updated_at,
        preview_text: snapshot.schema_text.slice(0, 2000),
      },
    });
  } catch (err) {
    console.error('[training-snapshots] get error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/training/snapshots/refresh/:connId
trainingSnapshotsRouter.post('/refresh/:connId', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(String(req.params.connId), 10);
    if (!connId) {
      res.status(400).json({ error: 'connectionId required' });
      return;
    }

    const connRow = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connId, req.userId]
    );
    if (!connRow.rows.length) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const { db_host, db_port, db_name, db_user, db_password } = connRow.rows[0];
    const pool = await createConnectionPool(
      `postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}`
    );

    try {
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

      const { inferLogicalFKs } = await import('../services/schema-store');
      const logicalFKs = inferLogicalFKs(colResult.rows);
      const seenFK = new Set<string>();
      const allFKs = [...fkResult.rows];
      for (const lfk of logicalFKs) {
        const key = `${lfk.table_schema}.${lfk.table_name}.${lfk.column_name}->${lfk.foreign_table_schema}.${lfk.foreign_table_name}.${lfk.foreign_column_name}`;
        if (!seenFK.has(key)) { seenFK.add(key); allFKs.push(lfk); }
      }

      await saveSchemaSnapshot(connId, { columns: colResult.rows, foreignKeys: allFKs }, '');
      res.json({ success: true, tables: colResult.rows.length, fks: allFKs.length });
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error('[training-snapshots] refresh error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/training/snapshots/:connId
trainingSnapshotsRouter.delete('/:connId', async (req: AuthRequest, res) => {
  try {
    const connId = parseInt(String(req.params.connId), 10);
    await deleteSchemaSnapshot(connId);
    res.json({ success: true });
  } catch (err) {
    console.error('[training-snapshots] delete error:', err);
    res.status(500).json({ error: String(err) });
  }
});
