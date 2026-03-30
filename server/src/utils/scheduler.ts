import { appPool, createConnectionPool } from '../services/db';
import { validateSQL, executeSafeQuery } from './sqlValidator';

interface ScheduledJob {
  id: number;
  userId: number;
  sql: string;
  connectionId: number | null;
  cronExpression: string;
  timeout: ReturnType<typeof setTimeout> | null;
}

/** In-memory job registry: scheduleId → job */
const jobs = new Map<number, ScheduledJob>();

/**
 * Parse a cron expression (node-cron format) and return the next run time in ms.
 * Supports: minute hour day month dayOfWeek
 * e.g. "0 * * * *" → next occurrence of minute 0 of the next hour
 */
function parseCronNextMs(expression: string): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return 60_000; // fallback 1 min

  const now = new Date();
  const currentMinute = now.getMinutes();
  const currentHour = now.getHours();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const [minStr, hourStr, dayStr, monthStr, dowStr] = parts;

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') {
      const result: number[] = [];
      for (let i = min; i <= max; i++) result.push(i);
      return result;
    }
    // Handle */n syntax (every N units)
    if (field.startsWith('*/')) {
      const step = Number(field.slice(2));
      if (!isNaN(step) && step > 0) {
        const result: number[] = [];
        for (let i = min; i <= max; i++) {
          if (i % step === 0) result.push(i);
        }
        return result;
      }
    }
    const result: number[] = [];
    for (const part of field.split(',')) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        for (let i = start; i <= end; i++) result.push(i);
      } else {
        result.push(Number(part));
      }
    }
    return result;
  };

  const minutes = parseField(minStr, 0, 59);
  const hours = parseField(hourStr, 0, 23);
  const days = parseField(dayStr, 1, 31);
  const months = parseField(monthStr, 1, 12);
  const dows = parseField(dowStr, 0, 6);

  // Find next valid minute
  for (let offset = 0; offset < 60 * 24 * 366; offset++) {
    const candidate = new Date(now.getTime() + offset * 60_000);
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const dw = candidate.getDay();
    const y = candidate.getFullYear();

    if (!minutes.includes(m)) continue;
    if (!hours.includes(h)) continue;
    if (!days.includes(d)) continue;
    if (!months.includes(mo)) continue;
    if (!dows.includes(dw)) continue;

    // Set to exact minute, 0 seconds
    candidate.setSeconds(0, 0);
    return candidate.getTime() - now.getTime();
  }

  return 60_000; // fallback
}

async function getConnectionString(userId: number, connectionId?: number): Promise<string | null> {
  if (connectionId) {
    const result = await appPool.query(
      `SELECT db_host, db_port, db_name, db_user, db_password
       FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, userId]
    );
    if (!result.rows.length) return null;
    const c = result.rows[0];
    return `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`;
  }
  const result = await appPool.query(
    `SELECT db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE user_id = $1 AND is_default = TRUE LIMIT 1`,
    [userId]
  );
  if (!result.rows.length) return null;
  const c = result.rows[0];
  return `postgresql://${c.db_user}:${c.db_password}@${c.db_host}:${c.db_port}/${c.db_name}`;
}

async function runScheduledQuery(job: ScheduledJob): Promise<void> {
  console.log(`[Scheduler] Running scheduled query #${job.id}: ${job.sql.slice(0, 60)}...`);

  const connStr = await getConnectionString(job.userId, job.connectionId ?? undefined);
  if (!connStr) {
    console.warn(`[Scheduler] No connection for job #${job.id}, skipping`);
    return;
  }

  const validation = validateSQL(job.sql);
  if (!validation.valid) {
    console.warn(`[Scheduler] Invalid SQL for job #${job.id}: ${validation.error}`);
    await appPool.query(
      `UPDATE scheduled_queries SET last_run_at = NOW(), last_run_status = 'error' WHERE id = $1`,
      [job.id]
    );
    return;
  }

  const pool = await createConnectionPool(connStr);
  try {
    const execResult = await executeSafeQuery(pool, validation.sql!, 60_000);
    await appPool.query(
      `UPDATE scheduled_queries SET last_run_at = NOW(), last_run_status = 'success', last_run_result = $1 WHERE id = $2`,
      [JSON.stringify({
        columns: execResult.columns,
        rows: execResult.rows,
        rowCount: execResult.rowCount,
        duration_ms: execResult.duration_ms,
      }), job.id]
    );
    console.log(`[Scheduler] Job #${job.id} completed successfully in ${execResult.duration_ms}ms`);
  } catch (err) {
    console.error(`[Scheduler] Job #${job.id} failed:`, err);
    await appPool.query(
      `UPDATE scheduled_queries SET last_run_at = NOW(), last_run_status = 'error', last_run_result = $1 WHERE id = $2`,
      [JSON.stringify({ error: String(err) }), job.id]
    );
  } finally {
    await pool.end();
  }

  // Schedule next run
  scheduleJob(job.id, job.userId, job.sql, job.connectionId, job.cronExpression);
}

function scheduleJob(
  id: number,
  userId: number,
  sql: string,
  connectionId: number | null,
  cronExpression: string,
): void {
  const delayMs = parseCronNextMs(cronExpression);
  const timeout = setTimeout(() => {
    const job = jobs.get(id);
    if (job) {
      runScheduledQuery(job);
    }
  }, delayMs);

  // Replace existing timeout if re-scheduling
  const existing = jobs.get(id);
  if (existing?.timeout) clearTimeout(existing.timeout);

  jobs.set(id, { id, userId, sql, connectionId, cronExpression, timeout });
}

async function loadActiveSchedules(): Promise<void> {
  const result = await appPool.query(
    `SELECT id, user_id, sql, connection_id, schedule_cron FROM scheduled_queries WHERE is_active = TRUE`
  );
  for (const row of result.rows) {
    const job = row as { id: number; user_id: number; sql: string; connection_id: number | null; schedule_cron: string };
    scheduleJob(job.id, job.user_id, job.sql, job.connection_id, job.schedule_cron);
  }
  console.log(`[Scheduler] Loaded ${result.rows.length} active scheduled query(s)`);
}

export const scheduler = {
  start: async (): Promise<void> => {
    await loadActiveSchedules();
  },
  /** Reload a single schedule after CRUD update */
  reloadSchedule: async (id: number): Promise<void> => {
    const result = await appPool.query(
      `SELECT id, user_id, sql, connection_id, schedule_cron, is_active FROM scheduled_queries WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) {
      jobs.delete(id);
      return;
    }
    const row = result.rows[0] as { id: number; user_id: number; sql: string; connection_id: number | null; schedule_cron: string; is_active: boolean };
    if (!row.is_active) {
      const existing = jobs.get(id);
      if (existing?.timeout) clearTimeout(existing.timeout);
      jobs.delete(id);
    } else {
      scheduleJob(row.id, row.user_id, row.sql, row.connection_id, row.schedule_cron);
    }
  },
};
