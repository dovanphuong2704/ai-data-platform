// data-masker.ts — Sensitive column masking for SQL query results
//
// Loads mask patterns per connection (global + per-connection overrides).
// Applies masking to query results before sending to frontend.

import { appPool } from '../services/db';

interface MaskConfig {
  pattern: string;
  type: 'hash' | 'null' | 'redact';
}

// ─── Default global patterns ───────────────────────────────────────────────────

const DEFAULT_PATTERNS: MaskConfig[] = [
  { pattern: 'password', type: 'hash' },
  { pattern: 'passwd', type: 'hash' },
  { pattern: 'pwd', type: 'hash' },
  { pattern: 'secret', type: 'hash' },
  { pattern: 'token', type: 'redact' },
  { pattern: 'api_key', type: 'redact' },
  { pattern: 'ssn', type: 'null' },
  { pattern: 'credit_card', type: 'null' },
  { pattern: 'card_number', type: 'null' },
  { pattern: 'cvv', type: 'null' },
  { pattern: 'pin', type: 'hash' },
  { pattern: 'salary', type: 'hash' },
  { pattern: 'wage', type: 'hash' },
  { pattern: 'dob', type: 'redact' },
  { pattern: 'date_of_birth', type: 'redact' },
];

// ─── Apply mask to a single value ──────────────────────────────────────────────

function applyMask(value: unknown, type: string): string {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'null':    return '[REDACTED]';
    case 'hash':    return '********';
    case 'redact':  return '[HIDDEN]';
    default:        return '[MASKED]';
  }
}

// ─── Load patterns from DB (cached) ─────────────────────────────────────────────

const cache = new Map<number, MaskConfig[]>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadMaskPatterns(connectionId: number): Promise<MaskConfig[]> {
  const cached = cache.get(connectionId);
  if (cached) return cached;

  try {
    const result = await appPool.query<MaskConfig>(
      `SELECT column_pattern AS pattern, mask_type AS type
       FROM sensitive_columns
       WHERE connection_id = $1 OR connection_id = -1
       ORDER BY connection_id DESC, id ASC`,
      [connectionId],
    );
    const patterns = (result.rows.length > 0 ? result.rows : DEFAULT_PATTERNS);
    cache.set(connectionId, patterns);
    // Auto-expire cache
    setTimeout(() => cache.delete(connectionId), CACHE_TTL_MS);
    return patterns;
  } catch {
    return DEFAULT_PATTERNS;
  }
}

/**
 * Detect which columns in the result set are sensitive.
 * Returns array of masked column names for frontend display.
 */
export function detectSensitiveColumns(
  columns: string[],
  maskConfigs: MaskConfig[],
): string[] {
  const masked: string[] = [];
  for (const col of columns) {
    for (const cfg of maskConfigs) {
      try {
        const regex = new RegExp(cfg.pattern, 'i');
        if (regex.test(col)) { masked.push(col); break; }
      } catch { /* invalid regex, skip */ }
    }
  }
  return masked;
}

/**
 * Mask sensitive columns in query result rows.
 * Returns new rows array (does not mutate input).
 */
export function maskSensitiveData(
  rows: Record<string, unknown>[],
  columns: string[],
  maskConfigs: MaskConfig[],
): { rows: Record<string, unknown>[]; maskedColumns: string[] } {
  const maskedCols = detectSensitiveColumns(columns, maskConfigs);
  if (maskedCols.length === 0) {
    return { rows, maskedColumns: [] };
  }

  const maskedRows = rows.map(row => {
    const masked = { ...row };
    for (const col of maskedCols) {
      const cfg = maskConfigs.find(c => {
        try { return new RegExp(c.pattern, 'i').test(col); } catch { return false; }
      });
      masked[col] = applyMask(row[col], cfg?.type ?? 'hash');
    }
    return masked;
  });

  return { rows: maskedRows, maskedColumns: maskedCols };
}

// ─── High-level API ────────────────────────────────────────────────────────────

export interface MaskResult {
  rows: Record<string, unknown>[];
  maskedColumns: string[];
}

export async function applyDataMasking(
  rows: Record<string, unknown>[],
  columns: string[],
  connectionId: number,
): Promise<MaskResult> {
  const configs = await loadMaskPatterns(connectionId);
  return maskSensitiveData(rows, columns, configs);
}
