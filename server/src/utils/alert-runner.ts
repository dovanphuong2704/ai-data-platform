import { appPool, createConnectionPool } from '../services/db';
import { validateSQL, executeSafeQuery } from './sqlValidator';

interface Alert {
  id: number;
  userId: number;
  name: string;
  querySql: string;
  thresholdValue: number;
  condition: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne';
  connectionId: number | null;
}

const ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

function compareAlertCondition(value: number, threshold: number, condition: Alert['condition']): boolean {
  switch (condition) {
    case 'gt':  return value > threshold;
    case 'lt':  return value < threshold;
    case 'gte': return value >= threshold;
    case 'lte': return value <= threshold;
    case 'eq':  return value === threshold;
    case 'ne':  return value !== threshold;
  }
}

async function dispatchWebhooks(alert: Alert, currentValue: number): Promise<void> {
  const result = await appPool.query(
    'SELECT id, webhook_url FROM alert_webhooks WHERE alert_id = $1 AND is_enabled = TRUE',
    [alert.id]
  );

  if (!result.rows.length) return;

  const dashboardUrl = process.env.CLIENT_ORIGIN
    ? `${process.env.CLIENT_ORIGIN}/dashboard`
    : 'http://localhost:3000/dashboard';

  for (const row of result.rows) {
    const webhookId = row.id as number;
    const webhookUrl = row.webhook_url as string;

    const payload = {
      alert_name: alert.name,
      triggered_at: new Date().toISOString(),
      condition: alert.condition,
      threshold: alert.thresholdValue,
      current_value: currentValue,
      sql: alert.querySql,
      dashboard_url: dashboardUrl,
    };

    // Attempt 1 + 1 retry on failure
    let sent = false;
    for (let attempt = 1; attempt <= 2 && !sent; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const fetchRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        sent = fetchRes.ok;
        if (!sent) {
          console.warn(`[AlertRunner] Webhook #${webhookId} returned ${fetchRes.status}, attempt ${attempt}`);
        }
      } catch (err) {
        console.warn(`[AlertRunner] Webhook #${webhookId} dispatch error (attempt ${attempt}):`, err);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!sent) {
      console.error(`[AlertRunner] Webhook #${webhookId} failed after 2 attempts: ${webhookUrl}`);
    } else {
      console.log(`[AlertRunner] Webhook #${webhookId} dispatched successfully`);
    }
  }
}

async function checkAlert(alert: Alert): Promise<void> {
  const connStr = await getConnectionString(alert.userId, alert.connectionId ?? undefined);
  if (!connStr) {
    console.warn(`[AlertRunner] No connection for alert #${alert.id}, skipping`);
    return;
  }

  const validation = validateSQL(alert.querySql);
  if (!validation.valid) {
    console.warn(`[AlertRunner] Invalid SQL for alert #${alert.id}: ${validation.error}`);
    await appPool.query(
      `UPDATE alerts SET last_checked_at = NOW() WHERE id = $1`,
      [alert.id]
    );
    return;
  }

  const pool = await createConnectionPool(connStr);
  try {
    const result = await executeSafeQuery(pool, validation.sql!, 10_000);

    // Extract first numeric value from first row, first column
    let numericValue: number | null = null;
    if (result.rows.length > 0) {
      const firstValue = Object.values(result.rows[0])[0];
      if (typeof firstValue === 'number' && !isNaN(firstValue)) {
        numericValue = firstValue;
      } else if (typeof firstValue === 'string') {
        const parsed = parseFloat(firstValue);
        if (!isNaN(parsed)) numericValue = parsed;
      }
    }

    await appPool.query(
      `UPDATE alerts SET last_checked_at = NOW() WHERE id = $1`,
      [alert.id]
    );

    if (numericValue === null) {
      console.warn(`[AlertRunner] Alert #${alert.id}: no numeric value in result`);
      return;
    }

    const triggered = compareAlertCondition(numericValue, alert.thresholdValue, alert.condition);

    if (triggered) {
      console.log(`[AlertRunner] 🚨 ALERT TRIGGERED: "${alert.name}" — value ${numericValue} (threshold ${alert.condition} ${alert.thresholdValue})`);
      await appPool.query(
        `UPDATE alerts SET last_triggered_at = NOW() WHERE id = $1`,
        [alert.id]
      );
      await dispatchWebhooks(alert, numericValue);
    } else {
      console.log(`[AlertRunner] Alert #${alert.id} "${alert.name}": OK — value ${numericValue}`);
    }
  } catch (err) {
    console.error(`[AlertRunner] Alert #${alert.id} error:`, err);
    await appPool.query(
      `UPDATE alerts SET last_checked_at = NOW() WHERE id = $1`,
      [alert.id]
    );
  } finally {
    await pool.end();
  }
}

async function runAlertChecks(): Promise<void> {
  const result = await appPool.query(
    `SELECT id, user_id, name, query_sql, threshold_value, condition, connection_id
     FROM alerts WHERE is_active = TRUE`
  );

  for (const row of result.rows) {
    const alert = row as {
      id: number; user_id: number; name: string; query_sql: string;
      threshold_value: number; condition: string; connection_id: number | null;
    };
    await checkAlert({
      id: alert.id,
      userId: alert.user_id,
      name: alert.name,
      querySql: alert.query_sql,
      thresholdValue: alert.threshold_value,
      condition: alert.condition as Alert['condition'],
      connectionId: alert.connection_id,
    });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export const alertRunner = {
  start: (): void => {
    // Run immediately on start
    runAlertChecks().catch((err) => console.error('[AlertRunner] Run error:', err));

    // Then repeat every 5 minutes
    intervalId = setInterval(() => {
      runAlertChecks().catch((err) => console.error('[AlertRunner] Run error:', err));
    }, ALERT_CHECK_INTERVAL_MS);

    console.log('[AlertRunner] Started — checking every 5 minutes');
  },

  stop: (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[AlertRunner] Stopped');
    }
  },

  /** Trigger a one-off check for a specific alert */
  checkOne: async (alertId: number): Promise<void> => {
    const result = await appPool.query(
      `SELECT id, user_id, name, query_sql, threshold_value, condition, connection_id
       FROM alerts WHERE id = $1 AND is_active = TRUE`,
      [alertId]
    );
    if (!result.rows.length) return;
    const row = result.rows[0] as { id: number; user_id: number; name: string; query_sql: string; threshold_value: number; condition: string; connection_id: number | null };
    await checkAlert({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      querySql: row.query_sql,
      thresholdValue: row.threshold_value,
      condition: row.condition as Alert['condition'],
      connectionId: row.connection_id,
    });
  },
};
