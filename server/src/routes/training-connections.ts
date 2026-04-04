/**
 * training-connections.ts
 * GET /api/training/connections - List all connections with training status
 */

import { Router } from 'express';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const trainingConnectionsRouter = Router();
trainingConnectionsRouter.use(authMiddleware);

// GET /api/training/connections
trainingConnectionsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const result = await appPool.query(`
      SELECT
        c.id,
        c.profile_name,
        c.db_host,
        c.db_port,
        c.db_name,
        c.db_user,
        c.is_default,
        c.created_at,
        -- Menu
        m.total_tables,
        m.generated_at AS menu_generated_at,
        -- Summaries
        (SELECT COUNT(*) FROM db_table_summaries s WHERE s.connection_id = c.id) AS summary_count,
        -- FKs
        (SELECT COUNT(*) FROM db_foreign_keys f WHERE f.connection_id = c.id) AS fk_count,
        (SELECT COUNT(*) FROM db_foreign_keys f WHERE f.connection_id = c.id) AS soft_fk_count,
        -- Examples
        (SELECT COUNT(*) FROM vanna_training_data v WHERE v.connection_id = c.id) AS example_count,
        -- Snapshot
        s.table_count,
        s.column_count,
        s.version_hash,
        s.updated_at AS snapshot_updated_at
      FROM db_connections c
      LEFT JOIN db_table_menus m ON m.connection_id = c.id
      LEFT JOIN db_schema_snapshots s ON s.connection_id = c.id
      WHERE c.user_id = $1
      ORDER BY c.is_default DESC, c.created_at DESC
    `, [userId]);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[training-connections] error:', err);
    res.status(500).json({ error: String(err) });
  }
});
