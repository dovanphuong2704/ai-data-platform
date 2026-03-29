import { Router } from 'express';
import { z } from 'zod';
import { appPool } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const alertWebhooksRouter = Router();

alertWebhooksRouter.use(authMiddleware);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const webhookCreateSchema = z.object({
  webhookUrl: z.string().url(),
  webhook_url: z.string().url(),
});

const webhookUpdateSchema = z.object({
  isEnabled: z.boolean().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely parse a route param that may be string | string[] */
function parseParam(val: string | string[] | undefined): number | null {
  if (!val) return null;
  const s = Array.isArray(val) ? val[0] : val;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

/** Verify alert belongs to user */
async function verifyAlertOwnership(alertId: number, userId: number): Promise<boolean> {
  const result = await appPool.query(
    'SELECT id FROM alerts WHERE id = $1 AND user_id = $2',
    [alertId, userId]
  );
  return result.rows.length > 0;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/alerts/:id/webhooks
alertWebhooksRouter.get('/alerts/:id/webhooks', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.id);
    if (alertId === null) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const result = await appPool.query(
      'SELECT id, alert_id, webhook_url, is_enabled, created_at FROM alert_webhooks WHERE alert_id = $1 ORDER BY created_at DESC',
      [alertId]
    );
    res.json({ webhooks: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

// POST /api/alerts/:id/webhooks
alertWebhooksRouter.post('/alerts/:id/webhooks', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.id);
    if (alertId === null) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    // Accept either camelCase or snake_case key name
    const rawBody = req.body as Record<string, unknown>;
    const webhookUrl = (rawBody.webhookUrl ?? rawBody.webhook_url) as string | undefined;
    if (!webhookUrl) {
      res.status(400).json({ error: 'webhookUrl is required' });
      return;
    }
    const result = await appPool.query(
      `INSERT INTO alert_webhooks (alert_id, webhook_url)
       VALUES ($1, $2)
       RETURNING id, alert_id, webhook_url, is_enabled, created_at`,
      [alertId, webhookUrl]
    );
    res.status(201).json({ webhook: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to create webhook' });
    }
  }
});

// PUT /api/alerts/:alertId/webhooks/:webhookId
alertWebhooksRouter.put('/alerts/:alertId/webhooks/:webhookId', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.alertId);
    const webhookId = parseParam(req.params.webhookId);
    if (alertId === null || webhookId === null) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const data = webhookUpdateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.isEnabled !== undefined) {
      fields.push(`is_enabled = $${idx++}`);
      values.push(data.isEnabled);
    }

    if (!fields.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(webhookId, alertId);
    const result = await appPool.query(
      `UPDATE alert_webhooks SET ${fields.join(', ')}
       WHERE id = $${idx++} AND alert_id = $${idx}
       RETURNING id, alert_id, webhook_url, is_enabled, created_at`,
      values
    );

    if (!result.rows.length) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    res.json({ webhook: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Failed to update webhook' });
    }
  }
});

// DELETE /api/alerts/:alertId/webhooks/:webhookId
alertWebhooksRouter.delete('/alerts/:alertId/webhooks/:webhookId', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.alertId);
    const webhookId = parseParam(req.params.webhookId);
    if (alertId === null || webhookId === null) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const result = await appPool.query(
      'DELETE FROM alert_webhooks WHERE id = $1 AND alert_id = $2 RETURNING id',
      [webhookId, alertId]
    );

    if (!result.rows.length) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    res.json({ message: 'Webhook deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// POST /api/alerts/:alertId/webhooks/test — test a webhook URL directly (no ID needed)
alertWebhooksRouter.post('/alerts/:alertId/webhooks/test', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.alertId);
    if (alertId === null) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const rawBody = req.body as Record<string, unknown>;
    const webhookUrl = (rawBody.webhookUrl ?? rawBody.webhook_url) as string | undefined;
    if (!webhookUrl) {
      res.status(400).json({ error: 'webhookUrl is required' });
      return;
    }

    const payload = {
      alert_name: '🔔 Test Alert',
      triggered_at: new Date().toISOString(),
      condition: 'eq',
      threshold: 0,
      current_value: 0,
      sql: 'SELECT 1 AS test',
      dashboard_url: process.env.CLIENT_ORIGIN
        ? `${process.env.CLIENT_ORIGIN}/dashboard`
        : 'http://localhost:3000/dashboard',
      _test: true,
    };

    let ok = false;
    let statusText = 'unknown';

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
      ok = fetchRes.ok;
      statusText = fetchRes.statusText;
    } catch (fetchErr) {
      statusText = fetchErr instanceof Error ? fetchErr.message : 'Request failed';
    }

    res.json({ success: ok, status: statusText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to test webhook' });
  }
});

// POST /api/alerts/:alertId/webhooks/:webhookId/test — test existing webhook delivery
alertWebhooksRouter.post('/alerts/:alertId/webhooks/:webhookId/test', async (req: AuthRequest, res) => {
  try {
    const alertId = parseParam(req.params.alertId);
    const webhookId = parseParam(req.params.webhookId);
    if (alertId === null || webhookId === null) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const isOwner = await verifyAlertOwnership(alertId, req.userId!);
    if (!isOwner) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    const result = await appPool.query(
      'SELECT webhook_url FROM alert_webhooks WHERE id = $1 AND alert_id = $2',
      [webhookId, alertId]
    );

    if (!result.rows.length) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    const webhookUrl = result.rows[0].webhook_url as string;

    // Send test payload
    const payload = {
      alert_name: '🔔 Test Alert',
      triggered_at: new Date().toISOString(),
      condition: 'eq',
      threshold: 0,
      current_value: 0,
      sql: 'SELECT 1 AS test',
      dashboard_url: process.env.CLIENT_ORIGIN
        ? `${process.env.CLIENT_ORIGIN}/dashboard`
        : 'http://localhost:3000/dashboard',
      _test: true,
    };

    let ok = false;
    let statusText = '';

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
      ok = fetchRes.ok;
      statusText = fetchRes.statusText;
    } catch (fetchErr) {
      statusText = fetchErr instanceof Error ? fetchErr.message : 'Request failed';
    }

    res.json({ success: ok, status: statusText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to test webhook' });
  }
});
