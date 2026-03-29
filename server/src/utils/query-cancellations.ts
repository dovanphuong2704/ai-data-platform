import { PoolClient } from 'pg';

export interface ActiveQuery {
  client: PoolClient;
  pid: number;
  userId: number;
}

/** In-memory Map: queryId → active query info */
export const activeQueries = new Map<string, ActiveQuery>();

/**
 * Register a new active query so it can be cancelled later.
 */
export function registerQuery(
  queryId: string,
  client: PoolClient,
  pid: number,
  userId: number,
): void {
  activeQueries.set(queryId, { client, pid, userId });
}

/**
 * Cancel an active query by its queryId.
 * Terminates the PostgreSQL backend and releases the client.
 * Returns true if cancelled, false if queryId not found.
 */
export function cancelQuery(queryId: string): boolean {
  const entry = activeQueries.get(queryId);
  if (!entry) return false;

  try {
    // Terminate the PostgreSQL backend process
    entry.client.query('SELECT pg_terminate_backend($1)', [entry.pid]).catch(() => {});
    entry.client.release();
  } finally {
    activeQueries.delete(queryId);
  }
  return true;
}

/**
 * Remove a query from the active map (e.g. after it completes).
 */
export function removeQuery(queryId: string): void {
  activeQueries.delete(queryId);
}

/**
 * Returns all queryIds owned by a given user.
 */
export function getActiveQueriesByUser(userId: number): string[] {
  const result: string[] = [];
  for (const [queryId, entry] of activeQueries.entries()) {
    if (entry.userId === userId) result.push(queryId);
  }
  return result;
}
