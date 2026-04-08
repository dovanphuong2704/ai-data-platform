/**
 * table-selector.ts - LLM 1: Receptionist
 *
 * Uses a fast/cheap LLM to select 5-10 relevant tables from the Menu
 * based on the user's natural language question.
 *
 * Fallback: Uses hybrid search (table-retrieval.ts) if LLM fails.
 */

import { appPool } from './db';
import { chatWithModel } from './ai';
import { retrieveTopTables } from './table-retrieval';
import { renderMenuText, type TableMenuItem } from './table-menu';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectedTable {
  schema: string;
  table: string;
  reason: string;
}

export interface TableSelectionResult {
  selectedTables: SelectedTable[];
  reasoning: string;
  method: 'llm' | 'fallback';
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

// Using ASCII-safe text to avoid encoding issues
const SELECTOR_SYSTEM_PROMPT = [
  "Ban la chuyen gia phan tich database.",
  "",
  "Nhiem vu: Doc cau hoi cua user -> chon ra cac bang PostgreSQL can thiet de viet SQL.",
  "",
  "QUY TAC:",
  "- Chon TOI DA 10 bang, UU TIEN bang can thiet nhat",
  "- Neu cau hoi ve dia ban (tinh/huyen/xa) -> chon bang HVCH",
  "- Neu cau hoi ve dien tich, rung, dat, lop phu -> chon bang LDLR",
  "- Neu cau hoi ve camera, giam sat, thiet bi -> chon bang CAM",
  "- Neu cau hoi ve thoi tiet, mua, nhiet do, NDVI -> chon bang KQTT",
  "- Neu cau hoi ve toa do, khong gian, ban kinh -> chon bang GIS",
  "- Chi chon bang thuc su can thiet, khong chon qua nhieu",
  "- Uu tien bang co FK lien ket voi nhau",
  "",
  "TRA VE JSON thuan (khong markdown, khong giai thich):",
  '{"selectedTables":[{"schema":"ten_schema","table":"ten_bang","reason":"tai sao chon"}],"reasoning":"tom tat"}',
].join('\n');

// ─── Fast Model Mapping ────────────────────────────────────────────────────────

const FAST_MODEL_MAP: Record<string, string> = {
  gemini:  'gemini-2.5-flash',
  openai:  'gpt-4o-mini',
  grok:    'grok-2-mini',
  claude:  'claude-3-5-haiku-20241022',
};

export function getFastModel(provider: string): string {
  return FAST_MODEL_MAP[provider] ?? 'gemini-2.0-flash';
}

export function getSmartModel(provider: string): string {
  const map: Record<string, string> = {
    gemini: 'gemini-2.5-flash',
    openai: 'gpt-4o',
    grok: 'grok-2',
    claude: 'claude-3-5-sonnet-20241022',
  };
  return map[provider] ?? 'gemini-2.5-flash';
}

// ─── Main Selector ────────────────────────────────────────────────────────────

/**
 * Select relevant tables using LLM (Receptionist).
 * Falls back to hybrid search if LLM fails or times out.
 */
export async function selectTables(
  userQuestion: string,
  menuItems: TableMenuItem[],
  connectionId: number,
  provider: string,
  apiKey: string,
  topK = 8,
): Promise<TableSelectionResult> {
  const menuText = renderMenuText(menuItems);

  // Try LLM first
  try {
    const result = await selectTablesWithLLM(userQuestion, menuText, provider, apiKey);
    console.log('[DEBUG] Selected tables:', JSON.stringify(result.selectedTables, null, 2));
    console.log(`[table-selector] LLM selected: ${result.selectedTables.length} tables`);
    return result;
  } catch (err) {
    console.warn('[table-selector] LLM failed, falling back to hybrid search:', err instanceof Error ? err.message : err);
  }

  // Fallback: hybrid search
  console.log('[table-selector] Using hybrid search fallback');
  const fallbackTables = await retrieveTopTables(userQuestion, connectionId, apiKey, topK, 0.2);

  const selectedTables: SelectedTable[] = fallbackTables.map(t => ({
    schema: t.table_schema,
    table: t.table_name,
    reason: `Hybrid search similarity: ${((t.similarity ?? 0) * 100).toFixed(1)}%`,
  }));

  return { selectedTables, reasoning: 'Hybrid search fallback', method: 'fallback' };
}

/**
 * Call LLM to select tables from menu text.
 */
async function selectTablesWithLLM(
  userQuestion: string,
  menuText: string,
  provider: string,
  apiKey: string,
): Promise<TableSelectionResult> {
  // Timeout: 10 seconds for LLM call
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('LLM timeout (>10s)')), 10000)
  );

  const llmPromise = chatWithModel({
    provider,
    apiKey,
    model: getFastModel(provider),
    systemMessage: SELECTOR_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Cau hoi: "${userQuestion}"\n\n${menuText}`,
    }],
    temperature: 0.1,
    maxTokens: 1024,
  });

  const response = await Promise.race([llmPromise, timeoutPromise]);

  // Parse JSON from response — safe incremental parsing
  const raw = response.content;

  // Strip markdown code fences
  const stripped = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/gi, '')
    .trim();

  // Find first '{' and incrementally find the matching closing '}'
  const firstBraceIdx = stripped.indexOf('{');
  if (firstBraceIdx === -1) {
    throw new Error('Could not find JSON object in LLM response');
  }

  // Try to find matching closing brace by counting nesting level
  let depth = 0;
  let endIdx = -1;
  for (let i = firstBraceIdx; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx === -1) {
    throw new Error('Could not find matching closing brace');
  }

  const candidate = stripped.slice(firstBraceIdx, endIdx);
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    throw new Error('Could not parse JSON from LLM response');
  }

  const parsed = parsedJson as {
    selectedTables: Array<{ schema: string; table: string; reason?: string }>;
    reasoning?: string;
  };

  if (!parsed.selectedTables?.length) {
    throw new Error('LLM returned empty selectedTables');
  }

  return {
    selectedTables: parsed.selectedTables.map(t => ({
      schema: t.schema,
      table: t.table,
      reason: t.reason ?? '',
    })),
    reasoning: parsed.reasoning ?? '',
    method: 'llm',
  };
}

// ─── Auto-refresh menu helper ─────────────────────────────────────────────────

/**
 * Check if menu needs refresh (schema changed).
 */
export async function needsMenuRefresh(connectionId: number, targetPool: { query: (sql: string) => Promise<{ rows: unknown[] }> }): Promise<boolean> {
  const cached = await appPool.query(
    `SELECT generated_at FROM db_table_menus WHERE connection_id = $1`,
    [connectionId]
  );

  if (!cached.rows.length) return true;

  const menuCount = await appPool.query(
    `SELECT menu_json FROM db_table_menus WHERE connection_id = $1`,
    [connectionId]
  );

  if (!menuCount.rows.length) return true;

  const cachedTables = (menuCount.rows[0].menu_json as unknown[]).length;

  const schemaCount = await targetPool.query(`
    SELECT COUNT(DISTINCT table_schema || '.' || table_name) as cnt
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND table_type = 'BASE TABLE'
  `);

  const currentTables = parseInt((schemaCount.rows[0] as { cnt: string }).cnt, 10);
  return cachedTables !== currentTables;
}
