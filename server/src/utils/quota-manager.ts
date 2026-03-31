import { appPool } from '../services/db';

const WINDOW_DURATION_MS = 60 * 60 * 1000; // 1 hour

export interface QuotaStatus {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  current: number;
  limit: number;
}

/**
 * Check if the user is within their quota for the given operation type.
 * Creates the user_quotas row if it doesn't exist yet.
 *
 * @param userId  - User ID
 * @param type    - 'query' or 'chat'
 * @returns QuotaStatus with allowed flag, remaining count, and resetAt time
 */
export async function checkQuota(
  userId: number,
  type: 'query' | 'chat',
): Promise<QuotaStatus> {
  console.log(`[checkQuota] Starting for user ${userId} type ${type}`);
  const countField = `${type}_count`;
  const limitField = `${type}_limit`;

  // Upsert quota row
  await appPool.query(
    `INSERT INTO user_quotas (user_id, ${countField}, ${limitField}, window_start)
     VALUES ($1, 0, ${type === 'query' ? 100 : 50}, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const row = await appPool.query(
    `SELECT ${countField} AS current, ${limitField} AS "limit", window_start
     FROM user_quotas WHERE user_id = $1`,
    [userId],
  );

  const { current, limit, window_start } = row.rows[0] as {
    current: number;
    limit: number;
    window_start: Date;
  };

  const windowStartMs = new Date(window_start).getTime();
  const now = Date.now();

  // Reset if window expired
  if (now - windowStartMs > WINDOW_DURATION_MS) {
    await appPool.query(
      `UPDATE user_quotas SET ${countField} = 0, window_start = NOW() WHERE user_id = $1`,
      [userId],
    );
    const resetAt = new Date(now + WINDOW_DURATION_MS);
    return { allowed: true, remaining: limit, resetAt, current: 0, limit };
  }

  const remaining = Math.max(0, limit - current);
  const resetAt = new Date(windowStartMs + WINDOW_DURATION_MS);
  return {
    allowed: remaining > 0,
    remaining,
    resetAt,
    current,
    limit,
  };
}

/**
 * Increment the quota counter after a successful operation.
 * Uses atomic UPDATE to avoid race conditions.
 */
export async function incrementQuota(userId: number, type: 'query' | 'chat'): Promise<void> {
  const countField = `${type}_count`;
  console.log(`[incrementQuota] Starting for user ${userId}`);
  await appPool.query(
    `UPDATE user_quotas SET ${countField} = ${countField} + 1 WHERE user_id = $1`,
    [userId],
  );
  console.log(`[incrementQuota] Done for user ${userId}`);
}
