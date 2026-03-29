import { Pool, QueryResult as PGQueryResult } from 'pg';
import { QueryResult } from '../types';

const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE',
  'CALL', 'INTO', 'OUTFILE', 'DUMPFILE', 'LOAD_FILE',
  'VACUUM', 'ANALYZE', 'REINDEX', 'COPY',
  'PREPARE', 'DEALLOCATE', 'DO',
];

const BLOCKED_PATTERNS = [
  /;\s*\w+/,                          // multiple statements
  /waitfor\s+delay/i,                 // time-based blind SQL
  /pg_sleep/i,                        // postgres sleep
  /sleep\s*\(/i,                      // generic sleep
  /\bunion\s+select\b/i,              // union injection
  /\bexec\s*\(/i,                     // exec injection
  /\bxp_cmdshell\b/i,                 // xp_cmdshell
];

const MAX_QUERY_LENGTH = 10_000;
const DEFAULT_LIMIT = 1000;

export interface ValidationResult {
  valid: boolean;
  sql?: string;
  error?: string;
}

/**
 * Validates and sanitizes a SQL query string.
 *
 * Rules:
 * - Must start with SELECT or WITH (CTE)
 * - Blocked keywords: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE,
 *   CREATE, GRANT, REVOKE, DENY, EXEC, EXECUTE, CALL, INTO, OUTFILE,
 *   DUMPFILE, LOAD_FILE, VACUUM, ANALYZE, REINDEX, COPY, PREPARE,
 *   DEALLOCATE, DO (case-insensitive)
 * - Injects LIMIT 1000 if not already present
 * - Strips trailing semicolons and extra whitespace
 */
export function validateSQL(sql: string): ValidationResult {
  if (!sql || typeof sql !== 'string') {
    return { valid: false, error: 'Query must be a non-empty string' };
  }

  const trimmed = sql.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Query cannot be empty' };
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { valid: false, error: `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters` };
  }

  // Must start with SELECT or WITH (CTE)
  if (!/^(SELECT|WITH)\s/i.test(trimmed)) {
    return { valid: false, error: 'Only SELECT or WITH queries are allowed' };
  }

  // Block dangerous keywords (case-insensitive word boundary match)
  const upper = trimmed.toUpperCase();
  for (const keyword of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
      return { valid: false, error: `Forbidden keyword: ${keyword}` };
    }
  }

  // Block dangerous patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: 'Query contains a forbidden pattern' };
    }
  }

  // Strip trailing semicolon and extra whitespace
  let clean = trimmed.replace(/;\s*$/, '').trim();

  // Inject LIMIT if not present
  if (!/\bLIMIT\b/i.test(clean)) {
    clean = `${clean} LIMIT ${DEFAULT_LIMIT}`;
    return { valid: true, sql: clean };
  }

  return { valid: true, sql: clean };
}

/**
 * Executes a validated SQL query with a configurable timeout.
 * Wraps the result in a QueryResult-compatible shape.
 *
 * @param pool     - The pg.Pool to execute against
 * @param sql      - The validated (clean) SQL string
 * @param timeoutMs - Query timeout in milliseconds (default 30_000)
 */
export async function executeSafeQuery(
  pool: Pool,
  sql: string,
  timeoutMs = 30_000,
): Promise<QueryResult> {
  const start = Date.now();

  let client;
  try {
    client = await pool.connect();

    // Set statement_timeout on this session (milliseconds)
    await client.query(`SET statement_timeout = ${Math.max(1000, timeoutMs)}`);

    const result: PGQueryResult = await client.query(sql);

    return {
      columns: result.fields.map((f: { name: string }) => f.name),
      rows: result.rows as object[],
      rowCount: result.rowCount ?? undefined,
      duration_ms: Date.now() - start,
      limited: /\bLIMIT\b/i.test(sql),
    };
  } finally {
    if (client) client.release();
  }
}
