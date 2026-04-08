import { Router, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { appPool, createConnectionPool } from '../services/db';
import { cleanupHistory } from './history';
import { getDict } from './schema-dictionary';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validateSQL, executeSafeQuery } from '../utils/sqlValidator';
import { applyDataMasking } from '../utils/data-masker';
import { createChatModel, getChatModelConfig, fetchProviderModels } from '../services/ai';
import { getSimilarSQL, buildRagContext } from '../services/vanna-rag';
import { getRelevantDocs, buildDocsContext } from '../services/vanna-docs';
import { retrieveTopTables } from '../services/table-retrieval';
import {
  getCachedSchemaWithText,
  saveSchemaSnapshot,
  buildSchemaTextFromEnriched,
  getTableDDL,
  buildFocusedSchemaFromTables,
  inferLogicalFKs,
} from '../services/schema-store';
import {
  selectTables,
  needsMenuRefresh,
  type SelectedTable,
} from '../services/table-selector';
import {
  buildTableMenuFromPool,
  saveTableMenu,
  getCachedTableMenu,
  invalidateTableMenu,
  type TableMenuItem,
} from '../services/table-menu';
import { generateSQL } from '../services/sql-generator';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { embedText } from '../services/embeddings';
import { checkSemanticCache, saveSemanticCache } from '../services/semantic-cache';
import { rerankTablesWithLLM } from '../services/table-reranker';

export const chatRouter = Router();

chatRouter.use(authMiddleware);

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  connectionId: z.number().optional(),
  aiProvider: z.enum(['openai', 'grok', 'gemini', 'claude']).optional(),
  apiKeyId: z.number().optional(),
  model: z.string().min(1).max(100).optional(),
  sessionId: z.number().optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })).optional(),
});

// ─── Chat Session helpers ──────────────────────────────────────────────────────

async function createChatSession(userId: number, title = 'New conversation'): Promise<number> {
  const result = await appPool.query(
    'INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id',
    [userId, title]
  );
  return (result.rows[0] as { id: number }).id;
}

async function getChatHistory(userId: number, sessionId: number): Promise<Array<{ role: string; content: string }>> {
  const result = await appPool.query(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT 50`,
    [sessionId]
  );
  return result.rows as Array<{ role: string; content: string }>;
}

async function saveChatMessages(
  userId: number,
  sessionId: number,
  userMsg: string,
  assistantContent: string,
  assistantSql: string | null,
  assistantResult: Record<string, unknown> | null,
  assistantError: string | null,
): Promise<void> {
  try {
    // Save user message
    await appPool.query(
      `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
      [sessionId, userMsg]
    );
    // Save assistant message
    await appPool.query(
      `INSERT INTO chat_messages (session_id, role, content, sql, sql_result, error)
       VALUES ($1, 'assistant', $2, $3, $4, $5)`,
      [sessionId, assistantContent, assistantSql, assistantResult ? JSON.stringify(assistantResult) : null, assistantError]
    );

    // Auto-title: if title is still "New conversation", set it to the first user message
    const titleCandidate = userMsg.length > 60 ? userMsg.slice(0, 57) + '...' : userMsg;
    await appPool.query(
      `UPDATE chat_sessions
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND title = 'New conversation'`,
      [titleCandidate, sessionId]
    );
  } catch (err) {
    console.error('[saveChatMessages]', err);
  }
}

// ─── Schema Cache ───────────────────────────────────────────────────────────

interface SchemaColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  description?: string;
  sample_values?: string[];
}

interface FKInfo {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

interface EnrichedSchema {
  columns: SchemaColumn[];
  foreignKeys: FKInfo[];
}

const schemaCache = new Map<string, { data: EnrichedSchema; ts: number }>();
const schemaIndexCache = new Map<string, SchemaIndex>();
const SCHEMA_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedSchema(key: string): EnrichedSchema | null {
  const entry = schemaCache.get(key);
  if (entry && Date.now() - entry.ts < SCHEMA_TTL_MS) return entry.data;
  return null;
}

function setCachedSchema(key: string, data: EnrichedSchema): void {
  schemaCache.set(key, { data, ts: Date.now() });
  // Rebuild index on schema update
  schemaIndexCache.delete(key);
}

// ─── Schema Semantic Search (BM25-like keyword scoring) ───────────────────────

interface SchemaIndex {
  tables: SchemaTableEntry[];
  // Maps "schema.table" → columns + FKs
  tableMap: Record<string, SchemaTableEntry>;
}

interface SchemaTableEntry {
  table_schema: string;
  table_name: string;
  columns: { column_name: string; data_type: string; description?: string }[];
  foreignKeys: { column_name: string; fk: string }[];
  // Pre-computed tokens for fast matching
  tokens: string[];
}

function normalizeToken(s: string): string {
  return s.toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-zàáạảãâầấậẩẫăắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởùúụủũưừứựửữỳýỵỷỹ\s\d]/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeToken(text).split(/\s+/).filter(t => t.length > 1);
}

// ─── Translate Vietnamese → English using DB dictionary ────────────────────────────
async function translateViToEn(query: string): Promise<string[]> {
  try {
    const dict = await getDict();
    const extraTokens: string[] = [];
    const lowerQuery = normalizeToken(query);

    for (const entry of dict) {
      // Match any Vietnamese keyword against the query
      for (const vi of entry.vi) {
        const viNorm = normalizeToken(vi);
        if (viNorm && (lowerQuery.includes(viNorm) || viNorm.split(' ').some(w => w.length > 2 && lowerQuery.includes(w)))) {
          extraTokens.push(...tokenize(entry.en.join(' ')));
          break;
        }
      }
    }

    return extraTokens;
  } catch {
    return []; // If DB fails, return empty (fallback to keyword-only matching)
  }
}

function scoreMatch(tokens: string[], queryTokens: string[]): number {
  if (!tokens.length || !queryTokens.length) return 0;
  let score = 0;
  for (const qt of queryTokens) {
    // Exact token match (highest)
    if (tokens.includes(qt)) {
      score += 10;
      continue;
    }
    // Prefix match (medium)
    for (const t of tokens) {
      if (t.startsWith(qt) || qt.startsWith(t)) {
        score += 5;
        break;
      }
    }
  }
  return score;
}

function buildSchemaIndex(enriched: EnrichedSchema): SchemaIndex {
  const { columns, foreignKeys } = enriched;

  // Group columns by table
  const tableColumns: Record<string, SchemaColumn[]> = {};
  for (const col of columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableColumns[key]) tableColumns[key] = [];
    tableColumns[key].push(col);
  }

  // Group FKs by table
  const tableFKs: Record<string, FKInfo[]> = {};
  for (const fk of foreignKeys) {
    const key = `${fk.table_schema}.${fk.table_name}`;
    if (!tableFKs[key]) tableFKs[key] = [];
    tableFKs[key].push(fk);
  }

  const tableMap: Record<string, SchemaTableEntry> = {};
  for (const [fullTable, cols] of Object.entries(tableColumns)) {
    const [schema, table] = fullTable.split('.');
    const fks = tableFKs[fullTable] ?? [];

    const tokens = [
      schema,
      table,
      ...cols.map(c => c.column_name),
      ...cols.map(c => normalizeToken(c.column_name)),
      ...fks.map(fk => `fk_${fk.column_name}_${fk.foreign_table_schema}_${fk.foreign_table_name}`),
    ].filter(Boolean);

    // Also add table name parts as separate tokens
    tokens.push(...table.split('_'));
    tokens.push(...normalizeToken(table).split(' '));

    tableMap[fullTable] = {
      table_schema: schema,
      table_name: table,
      columns: cols.map(c => ({ column_name: c.column_name, data_type: c.data_type, description: c.description })),
      foreignKeys: fks.map(fk => ({
        column_name: fk.column_name,
        fk: `${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`,
      })),
      tokens: [...new Set(tokens)],
    };
  }

  return {
    tables: Object.values(tableMap),
    tableMap,
  };
}

function getOrBuildIndex(connectionId: number, enriched: EnrichedSchema): SchemaIndex {
  const cacheKey = `${connectionId}`;
  if (!schemaIndexCache.has(cacheKey)) {
    schemaIndexCache.set(cacheKey, buildSchemaIndex(enriched));
  }
  return schemaIndexCache.get(cacheKey)!;
}

async function searchSchema(index: SchemaIndex, userQuestion: string, topK = 8): Promise<SchemaTableEntry[]> {
  const queryTokens = tokenize(userQuestion);
  // Also add English equivalents from DB dictionary
  const translatedTokens = await translateViToEn(userQuestion);
  const allQueryTokens = [...new Set([...queryTokens, ...translatedTokens])];

  if (!allQueryTokens.length) return index.tables.slice(0, topK);

  // Score every table
  const scored = index.tables.map(table => ({
    table,
    score: scoreMatch(table.tokens, allQueryTokens),
  }));

  // Sort by score descending, add schema/schema bonus
  const schemaMentionBonus: Record<string, number> = {};
  for (const qt of allQueryTokens) {
    for (const t of index.tables) {
      if (t.table_schema.toLowerCase().includes(qt) || qt.includes(t.table_schema.toLowerCase())) {
        const key = `${t.table_schema}.${t.table_name}`;
        schemaMentionBonus[key] = (schemaMentionBonus[key] ?? 0) + 20;
      }
    }
  }

  for (const s of scored) {
    const key = `${s.table.table_schema}.${s.table.table_name}`;
    s.score += schemaMentionBonus[key] ?? 0;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK).map(s => s.table);

  // Always include all tables from schema "public" if user mentions no specific schema
  const hasPublicMention = allQueryTokens.some(q => q === 'public');
  if (!hasPublicMention && top.length < topK) {
    const publicTables = index.tables.filter(t => t.table_schema === 'public');
    for (const pt of publicTables) {
      if (top.length >= topK) break;
      if (!top.find(t => `${t.table_schema}.${t.table_name}` === `${pt.table_schema}.${pt.table_name}`)) {
        top.push(pt);
      }
    }
  }

  return top;
}

function buildFocusedSchemaDescription(
  selectedTables: SchemaTableEntry[],
  allTables: SchemaTableEntry[],
  userQuestion: string,
): string {
  const lines: string[] = [];

  // Header: schemas found in selection
  const schemas = [...new Set(selectedTables.map(t => t.table_schema))];
  lines.push(`Các SCHEMA được sử dụng: ${schemas.join(', ')}`);
  lines.push('');

  for (const table of selectedTables) {
    const fkList = table.foreignKeys
      .map(fk => `  FK: ${table.table_schema}.${table.table_name}.${fk.column_name} → ${fk.fk}`)
      .join('\n');

    const colList = table.columns
      .map(c => {
        const desc = c.description ? ` — ${c.description}` : '';
        const isCodeCol = /_code$|_id$/.test(c.column_name);
        const codeWarning = isCodeCol ? ' ⚠️ MÃ ĐỊNH DANH - KHÔNG lọc tên tiếng Việt ở đây. PHẢI JOIN bảng danh mục.' : '';
        return `  - ${c.column_name} (${c.data_type})${desc}${codeWarning}`;
      })
      .join('\n');

    lines.push(`${table.table_schema}.${table.table_name}:`);
    if (fkList) lines.push(fkList);
    lines.push(colList);
    lines.push('');
  }

  // Also list ALL schemas (so AI knows what's available)
  const allSchemas = [...new Set(allTables.map(t => t.table_schema))];
  lines.push('TẤT CẢ SCHEMA TRONG DATABASE: ' + allSchemas.join(', '));
  lines.push('');
  lines.push('CÂU HỎI CỦA USER: ' + userQuestion);

  return lines.join('\n');
}

export function invalidateSchemaCache(connectionId: number): void {
  for (const k of schemaCache.keys()) {
    if (k.startsWith(`${connectionId}:`)) schemaCache.delete(k);
  }
  schemaIndexCache.delete(`${connectionId}`);
}

export function clearAllSchemaCache(): void {
  schemaCache.clear();
  schemaIndexCache.clear();
}

// ─── Helper functions ────────────────────────────────────────────────────────

async function getUserApiKey(
  userId: number,
  provider?: string,
  apiKeyId?: number,
): Promise<{ id: number; api_key: string; provider: string } | null> {
  function normalizeKey(val: string): string { return val; }

  if (apiKeyId) {
    const byId = await appPool.query(
      `SELECT id, api_key, provider FROM api_keys WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [apiKeyId, userId]
    );
    if (!byId.rows.length) return null;
    const row = byId.rows[0] as { id: number; api_key: string; provider: string };
    if (provider && row.provider !== provider) return null;
    return { id: row.id, api_key: normalizeKey(row.api_key), provider: row.provider };
  }

  // One single query with priority ordering instead of sequential fallbacks
  const result = await appPool.query(`
    SELECT id, api_key, provider
    FROM api_keys
    WHERE user_id = $1
      ${provider ? 'AND provider = $2' : ''}
    ORDER BY
      is_default = TRUE  DESC,
      ${provider ? "provider = $2 DESC," : ''}
      id = id            DESC
    LIMIT 1
  `, provider ? [userId, provider] : [userId]);

  if (!result.rows.length) return null;
  const row = result.rows[0] as { id: number; api_key: string; provider: string };
  return { id: row.id, api_key: normalizeKey(row.api_key), provider: row.provider };
}

async function getConnectionDetails(
  userId: number,
  connectionId?: number
): Promise<{
  id: number;
  db_host: string;
  db_port: string;
  db_name: string;
  db_user: string;
  db_password: string;
} | null> {
  if (connectionId) {
    const result = await appPool.query(
      `SELECT id, db_host, db_port, db_name, db_user, db_password
       FROM db_connections WHERE id = $1 AND user_id = $2`,
      [connectionId, userId]
    );
    return (result.rows[0] as {
      id: number; db_host: string; db_port: string;
      db_name: string; db_user: string; db_password: string;
    }) ?? null;
  }
  const result = await appPool.query(
    `SELECT id, db_host, db_port, db_name, db_user, db_password
     FROM db_connections WHERE user_id = $1 AND is_default = TRUE LIMIT 1`,
    [userId]
  );
  return (result.rows[0] as {
    id: number; db_host: string; db_port: string;
    db_name: string; db_user: string; db_password: string;
  }) ?? null;
}

async function fetchSchema(pool: Pool): Promise<EnrichedSchema> {
  // Fetch columns with PostgreSQL column descriptions
  const colResult = await pool.query<SchemaColumn>(`
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.column_default,
      col_description(pc.oid, c.ordinal_position::int) AS description
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    LEFT JOIN pg_class pc
      ON pc.relname = c.table_name
     AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = c.table_schema)
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  // Fetch FK constraints
  const fkResult = await pool.query<FKInfo>(`
    SELECT
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      ccu.table_schema AS foreign_table_schema,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  `);

  // Fetch sample values for key columns (top 5 distinct values per table, up to 10 tables max)
  const sampleValuesMap: Record<string, string[]> = {};
  const tables = [...new Set(colResult.rows.map(r => `${r.table_schema}.${r.table_name}`))].slice(0, 10);

  for (const fullTable of tables) {
    const [schema, table] = fullTable.split('.');
    try {
      // Get up to 5 distinct values from first 3 non-date/text columns
      const sampleResult = await pool.query(`
        SELECT * FROM "${schema}"."${table}" LIMIT 3
      `, []);
      if (sampleResult.rows.length > 0) {
        sampleValuesMap[fullTable] = sampleResult.rows.slice(0, 3);
      }
    } catch {
      // Skip tables we can't read (permission denied, etc.)
    }
  }

  // Infer logical FKs from naming convention
  const logicalFKs = inferLogicalFKs(colResult.rows);

  // Merge: real FKs first, then logical FKs (deduplicate by key)
  const seenFK = new Set<string>();
  const allFKs: FKInfo[] = [...fkResult.rows];

  for (const lfk of logicalFKs) {
    const key = `${lfk.table_schema}.${lfk.table_name}.${lfk.column_name}->${lfk.foreign_table_schema}.${lfk.foreign_table_name}.${lfk.foreign_column_name}`;
    if (!seenFK.has(key)) {
      seenFK.add(key);
      allFKs.push(lfk);
    }
  }

  return {
    columns: colResult.rows,
    foreignKeys: allFKs,
  };
}

function buildSchemaDescription(enriched: EnrichedSchema): string {
  const { columns, foreignKeys } = enriched;

  const tableMap: Record<string, SchemaColumn[]> = {};
  for (const col of columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableMap[key]) tableMap[key] = [];
    tableMap[key].push(col);
  }

  // Build FK reference map
  const fkMap: Record<string, string[]> = {};
  for (const fk of foreignKeys) {
    const key = `${fk.table_schema}.${fk.table_name}`;
    if (!fkMap[key]) fkMap[key] = [];
    fkMap[key].push(
      `${fk.column_name} → ${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`
    );
  }

  const lines: string[] = [];

  for (const [table, cols] of Object.entries(tableMap)) {
    lines.push(`${table}:`);
    // Foreign keys
    if (fkMap[table]) {
      lines.push(`  [FOREIGN KEYS: ${fkMap[table].join(', ')}]`);
    }
    // Columns
    const colList = cols
      .map((c) => {
        const desc = c.description ? ` — ${c.description}` : '';
        return `  - ${c.column_name} (${c.data_type})${desc}`;
      })
      .join('\n');
    lines.push(colList);
    lines.push('');
  }

  return lines.join('\n');
}

function buildSystemPrompt(schema: string, recentHistory?: string, ragContext?: string, docsContext?: string): string {
  return `Bạn là Trợ lý AI phân tích dữ liệu thân thiện. Bạn giỏi viết SQL PostgreSQL và luôn trả lời bằng tiếng Việt có dấu, rõ ràng và hữu ích.

### 🎯 PHONG CÁCH TRẢ LỜI:
- LUÔN trả lời THÂN THIỆN, nhiệt tình và chuyên nghiệp.
- Khi người dùng hỏi dữ liệu → phân tích kết quả, chỉ ra xu hướng, bất thường hoặc điểm đáng chú ý.
- Khi người dùng chào hỏi → đáp lại lịch sự rồi hỏi họ cần hỗ trợ gì.
- KHÔNG bao giờ trả lời đơn thuần bằng số liệu thô. LUÔN có lời phân tích kèm theo.
- Dùng emoji phù hợp (📊, 🔥, 📍, etc.) để response sinh động hơn.

### 🛑 QUY TẮC BẮT BUỘC (TUÂN THỦ TUYỆT ĐỐI):

1. **KIỂM TRA SCHEMA TRƯỚC KHI TRẢ LỜI:**
   - Bạn PHẢI quét toàn bộ danh sách "DANH SÁCH SCHEMA CHI TIẾT" bên dưới từ đầu đến cuối.
   - Nếu tên schema hoặc table xuất hiện trong danh sách -> BẮT BUỘC viết SQL, không được phép từ chối.
   - Đọc thêm phần comment để hiểu rõ hơn về các bảng.
   - Tuyệt đối không được nói "không tìm thấy" nếu từ khóa đó có tồn tại trong phần SCHEMA DATABASE.

2. **XỬ LÝ KHI THIẾU THÔNG TIN:**
   - Nếu user hỏi về schema X mà bạn thấy trong danh sách nhưng không rõ bảng/cột -> Dùng:
     SELECT table_name FROM information_schema.tables WHERE table_schema = 'X'
   - Nếu thấy bảng nhưng không rõ cột -> Dùng: SELECT * FROM schema.table LIMIT 5 để xem trước dữ liệu.
   - KHÔNG BAO GIỜ từ chối viết SQL vì lý do "không biết cấu trúc".

3. **QUY TẮC TRUY VẤN SQL:**
   - LUÔN dùng prefix: schema_name.table_name.
   - CHỈ thực hiện lệnh SELECT. Cấm các lệnh thay đổi dữ liệu (INSERT, DELETE, DROP...).
   - NÊN thêm LIMIT N vào cuối SQL để tránh trả về quá nhiều dòng. Nếu user không chỉ định → thêm LIMIT 1000.
   - Nếu người dùng chỉ định giới hạn số bản ghi (LIMIT), hãy tuân thủ.
   - Sử dụng các Foreign Keys đã cung cấp để thực hiện JOIN chính xác.
   - Quan trọng: Khi thấy column có suffix _code hoặc _id (ví dụ: commune_code, district_code, tree_spec_code), PHẢI JOIN đến bảng reference tương ứng (ví dụ: commune, district, tree_specie) để lấy tên hiển thị, không bao giờ chỉ GROUP BY theo _code.
   - Nghiêm cấm tuyệt đối: KHÔNG dùng ILIKE/LIKE/= với từ tiếng Việt (keo, cháy, tự nhiên...) trên cột _code hoặc _id. Chỉ dùng ILIKE trên cột chứa TÊN (thường có suffix _name, _def, _verna, _latin).

4. **ĐỊNH DẠNG PHẢN HỒI — VIẾT TỰ NHIÊN, KHÔNG CẦN JSON:**
   Sau khi viết SQL xong, HÃY VIẾT 1-3 CÂU phân tích kết quả bằng tiếng Việt có dấu, như một người trợ lý thật sự.
   - Gợi ý xu hướng, bất thường, hoặc điểm đáng chú ý.
   - Không cần trả JSON, chỉ viết text thường.
   - Ví dụ: "Dưới đây là kết quả... Có thể thấy...", "Đáng chú ý là...", "Tổng cộng có X bản ghi..."
   - Nếu là lỗi → giải thích lỗi và gợi ý cách sửa.

5. **QUY TẮC CHART TYPE:**
   - "bar": so sánh categories (tháng, loại, nhóm, vùng)
   - "line": xu hướng theo thời gian (ngày/tháng/quý/năm)
   - "pie": tỷ lệ phần trăm (tối đa 7-8 categories)
   - "area": xu hướng tích lũy theo thời gian
   - Nếu không chắc chắn → "table"

6. **QUY TẮC PHÂN TÍCH:** Giải thích bằng tiếng Việt có dấu, 2-5 câu. Chỉ ra xu hướng tăng/giảm, bất thường. KHÔNG đọc lại toàn bộ số liệu.

7. **VÍ DỤ MINH HỌA:**
   - User: Trong schema fire có bảng nào? → SQL: SELECT table_name FROM information_schema.tables WHERE table_schema = 'fire'
   - User: Điểm cháy hôm nay? → SQL: SELECT COUNT(*) AS total, DATE_TRUNC('day', created_at) AS ngay FROM fire.fire_points WHERE created_at >= CURRENT_DATE GROUP BY 2 ORDER BY 2 LIMIT 20
   - User: Xin chào → type:"answer", analysis:"Xin chào! Tôi là trợ lý AI phân tích dữ liệu."

### 🧠 QUY TRÌNH SUY NGHĨ NỘI BỘ (INTERNAL MONOLOGUE):
- BƯỚC 1: Xác định các thực thể (Schema, Table) trong câu hỏi của User.
- BƯỚC 2: Tìm kiếm chính xác các thực thể đó trong danh sách SCHEMA DATABASE bên dưới.
- BƯỚC 3: Nếu tìm thấy thực thể 'fire' (hoặc bất kỳ tên nào khác), ngay lập tức xây dựng câu lệnh SQL tương ứng.
- BƯỚC 4: Nếu thực sự không thấy sau khi đã quét toàn bộ, hãy viết SQL truy vấn information_schema.schemata để kiểm tra lại hệ thống.

---
${recentHistory ? `📜 NGỮ CẢNH HỘI THOẠI GẦN ĐÂY:\n${recentHistory}\n` : ''}
${ragContext ? `\n${ragContext}` : ''}
${docsContext ? docsContext : ''}

### 🗄️ DANH SÁCH SCHEMA CHI TIẾT (DÙNG CHÍNH XÁC TÊN DƯỚI ĐÂY):
${schema}`;
}

function buildFixPrompt(
  type: 'SYNTAX' | 'DATABASE' | 'COLUMN',
  errorMessage: string,
  currentSql: string,
  ddlText: string,
  userQuestion: string,
  _schemaJson?: { columns: Array<{ table_schema: string; table_name: string; column_name: string }> },
): string {
  if (type === 'DATABASE') {
    return [
      `=== LAN SUA LAN THU ${type} ===`,
      `Cau hoi nguoi dung: "${userQuestion}"`,
      "",
      `=== LOI TU DATABASE ===`,
      errorMessage,
      "",
      `=== SQL HIEN TAI ===`,
      currentSql,
      "",
      `=== DDL (SCHEMA) ===`,
      ddlText || '(khong co DDL)',
      "",
      `=== YEU CAU SUA SQL ===`,
      "- Doc loi tu Database phia tren",
      "- Neu loi 'column X does not exist':",
      "  * Neu SQL dung column name nhung DDL khong co -> column do thuoc BANG DANH MUC, can JOIN qua cot _code",
      "  * VD: tree_spec_name -> tim tree_spec_code trong bang chinh -> JOIN tree_specie ON tree_spec_code = code",
      "  * VD: commune_name -> tim commune_code -> JOIN commune ON commune_code = code",
      "  * Tim cot _code trong bang chinh, JOIN den bang danh muc bang code = code de lay ten",
      "- Neu loi 'table X does not exist': kiem tra lai ten bang",
      "- Neu loi syntax: kiem tra dau cham phay, dau ngoac, tu khoa SQL",
      "- Giu nguyen cac phan DUNG cua SQL",
      "- Tra ve SQL da sua trong tag [sql]...[sql]",
    ].join('\n');
  }
  if (type === 'COLUMN') {
    return [
      `=== LAN SUA LAN THU ${type} ===`,
      `Cau hoi nguoi dung: "${userQuestion}"`,
      "",
      `=== LOI COLUMN KHONG TON TAI ===`,
      errorMessage,
      "",
      `=== SQL HIEN TAI ===`,
      currentSql,
      "",
      `=== YEU CAU ===`,
      "- Mot so cot trong SQL khong ton tai trong schema",
      "- Hay tim cot _code tuong ung trong cung bang de JOIN den bang danh muc lay ten",
      "- Neu column co _name/_desc ma khong ton tai -> tim cot _code cung bang -> JOIN den bang danh muc",
      "- Giu nguyen cac phan DUNG",
      "- Tra ve SQL da sua trong tag [sql]...[sql]",
    ].join('\n');
  }
  return [
    `=== LOI SYNTAX SQL ===`,
    errorMessage,
    "",
    `=== SQL HIEN TAI ===`,
    currentSql,
    "",
    'Hay sua SQL tren va tra ve ket qua trong tag [sql]...[sql]',
  ].join('\n');
}

// ── Column validator (pre-execution) ──────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'JOIN', 'LEFT', 'RIGHT',
  'INNER', 'OUTER', 'FULL', 'CROSS', 'AND', 'NOT', 'WITH', 'AS', 'ON',
  'IN', 'IS', 'NULL', 'LIMIT', 'OFFSET', 'UNION', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'EXISTS', 'BETWEEN', 'LIKE', 'ASC', 'DESC',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF',
  'CAST', 'ROUND', 'DATE', 'NOW', 'CURRENT', 'TRUE', 'FALSE',
  'ALL', 'DISTINCT', 'ANY', 'TABLE', 'INDEX', 'SCHEMA', 'DATABASE',
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
]);

function extractColumnRefsFromSQL(sql: string): Array<{ schema?: string; table: string; column: string }> {
  const refs: Array<{ schema?: string; table: string; column: string }> = [];
  const pattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    if (!SQL_KEYWORDS.has(match[2].toUpperCase())) {
      refs.push({ schema: match[1], table: match[2], column: match[3] });
    }
  }
  return refs;
}

/**
 * Standard Levenshtein edit distance — O(mn) time, O(min(m,n)) space.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two rows instead of full matrix for memory efficiency
  let prevRow: number[] = [];
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const currRow: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,      // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

/**
 * Find a fuzzy match for a column name among candidates.
 * Returns the matched column name, or null if no good match found.
 */
function findFuzzyMatch(
  columnName: string,
  candidates: string[],
): string | null {
  const colLower = columnName.toLowerCase();
  const MAX_DISTANCE = 2;

  // 1. Exact (case-insensitive) — handled by validateColumns already, skip
  // 2. Levenshtein match
  let bestMatch: string | null = null;
  let bestDist = Infinity;

  for (const candidate of candidates) {
    const canLower = candidate.toLowerCase();

    // Levenshtein distance check
    const dist = levenshteinDistance(colLower, canLower);
    if (dist <= MAX_DISTANCE && dist < bestDist) {
      bestDist = dist;
      bestMatch = candidate;
    }

    // Prefix match bonus: "customer_id" ↔ "cust_id"
    if (colLower.length >= 4 && canLower.length >= 4) {
      if (colLower.startsWith(canLower.slice(0, 4)) || canLower.startsWith(colLower.slice(0, 4))) {
        if (bestDist > 0) { bestDist = 0; bestMatch = candidate; }
      }
    }
  }

  return bestMatch;
}

/**
 * Validate column references against schema before DB execution.
 * Returns { valid: true, fixedSql?: string } if valid.
 * Returns { valid: false, error: string } if cannot fix.
 * Uses fuzzy matching to auto-correct column typos before calling LLM.
 */
function validateColumns(
  sql: string,
  schemaJson: { columns: Array<{ table_schema: string; table_name: string; column_name: string }> },
): string | null {
  const refs = extractColumnRefsFromSQL(sql);
  if (!refs.length) return null;

  // Build lookup: table → set of valid column names (lowercase)
  const tableColumns = new Map<string, Set<string>>();
  for (const col of schemaJson.columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableColumns.has(key)) tableColumns.set(key, new Set());
    tableColumns.get(key)!.add(col.column_name.toLowerCase());
  }

  // Build flat list for fuzzy matching
  const flatColumns: string[] = [];
  for (const [, cols] of tableColumns) {
    for (const c of cols) flatColumns.push(c);
  }

  let fixedSql = sql;
  let hasChange = false;

  for (const ref of refs) {
    const tableKey = ref.schema
      ? `${ref.schema}.${ref.table}`.toLowerCase()
      : ref.table.toLowerCase();
    const candidates = tableColumns.get(tableKey);

    if (!candidates) {
      // Table doesn't exist in schema at all — let LLM handle it
      continue;
    }

    if (candidates.has(ref.column.toLowerCase())) {
      continue; // exact match — OK
    }

    // Try fuzzy match
    const fuzzyFound = findFuzzyMatch(ref.column, [...candidates]);
    if (fuzzyFound) {
      // Replace column name in SQL
      const escaped = ref.column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
      fixedSql = fixedSql.replace(pattern, fuzzyFound);
      hasChange = true;
      console.log(`[FUZZY] '${ref.column}' → '${fuzzyFound}' in table '${ref.table}'`);
    } else {
      // Truly invalid column — LLM fix needed
      const suggestion = [...candidates].slice(0, 3).join(', ');
      return `Column '${ref.column}' in '${ref.table}' does not exist in schema. Did you mean: ${suggestion}?`;
    }
  }

  if (hasChange) return null; // fixed — no error
  return null;
}

// ── LIMIT Guardrail ───────────────────────────────────────────────────────────

/**
 * Auto-inject LIMIT clause if SQL doesn't already have one.
 * Handles CTE (WITH ...) queries by appending LIMIT to final SELECT.
 */
function injectLimit(sql: string, limit: number): string {
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  // Skip if already has LIMIT
  if (/\bLIMIT\b/i.test(trimmed)) return sql;

  // Handle CTE: WITH ... SELECT ... → add LIMIT to the last SELECT
  if (trimmed.toUpperCase().startsWith('WITH')) {
    const lastSelectIdx = trimmed.toUpperCase().lastIndexOf('SELECT');
    if (lastSelectIdx === -1) return sql;

    // Find end of final SELECT: semicolon or end of string
    const semiIdx = trimmed.lastIndexOf(';');
    const endIdx = semiIdx > lastSelectIdx ? semiIdx : trimmed.length;
    const endChar = trimmed.endsWith(';') ? ';' : '';

    const before = trimmed.slice(0, lastSelectIdx);
    const finalSelect = trimmed.slice(lastSelectIdx, endIdx);
    return before + finalSelect + ` LIMIT ${limit}` + endChar;
  }

  // Simple case: append LIMIT before semicolon
  if (trimmed.endsWith(';')) {
    return trimmed.slice(0, -1) + ` LIMIT ${limit};`;
  }
  return trimmed + ` LIMIT ${limit}`;
}

// ── attemptSqlWithRetry ────────────────────────────────────────────────────────

interface SqlRetryResult {
  success: boolean;
  sql?: string;
  error?: string;
  sqlResult?: {
    columns: string[]; rows: Record<string, unknown>[];
    rowCount: number; duration_ms: number; limited: boolean;
    truncated?: boolean;
    totalRows?: number;
  };
}

/**
 * Execute SQL with up to maxRetries LLM-assisted fixes for DATABASE errors.
 * Step 0: LIMIT guardrail — auto-inject LIMIT if missing
 * Step 1: validateColumns pre-check
 * Step 2: try execute
 * Step 3: if DATABASE error -> buildFixPrompt -> LLM -> validate -> execute
 * Step 4: repeat up to maxRetries
 * Step 5: post-check — truncate large results
 */
async function attemptSqlWithRetry(
  pool: Pool,
  sql: string,
  ddlText: string,
  chatModel: BaseChatModel,
  maxRetries: number,
  _userId: number,
  _connId: number,
  userQuestion: string,
  schemaJson?: { columns: Array<{ table_schema: string; table_name: string; column_name: string }> },
): Promise<SqlRetryResult> {
  // ── LIMIT GUARDRAIL: auto-inject LIMIT if missing ──
  const MAX_QUERY_ROWS = parseInt(process.env.MAX_QUERY_ROWS ?? '1000');
  const SOFT_LIMIT_ROWS = parseInt(process.env.SOFT_LIMIT_ROWS ?? '5000');

  let currentSql = sql;
  if (!/\bLIMIT\b/i.test(currentSql.trim())) {
    currentSql = injectLimit(currentSql, MAX_QUERY_ROWS);
    console.log(`[LIMIT GUARDRAIL] Auto-added LIMIT ${MAX_QUERY_ROWS}`);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ── Pre-execution column validation ──
    if (schemaJson && schemaJson.columns.length > 0) {
      const colError = validateColumns(currentSql, schemaJson);
      if (colError) {
        if (attempt === maxRetries) {
          return { success: false, sql: currentSql, error: colError };
        }
        // Ask LLM to fix
        const fixPrompt = buildFixPrompt('COLUMN', colError, currentSql, ddlText, userQuestion, schemaJson);
        const response = await chatModel.invoke([new HumanMessage({ content: fixPrompt })]);
        const content = typeof response === 'string' ? response : (response as { content?: string }).content ?? '';
        const fixedSql = (content.match(/\[sql\]([\s\S]*?)\[\/sql\]/i)?.[1] ?? content.match(/\b(SELECT[\s\S]+?;?)\b/i)?.[0])?.replace(/;$/, '');
        if (fixedSql && fixedSql !== currentSql) {
          currentSql = fixedSql;
          continue;
        }
        return { success: false, sql: currentSql, error: colError };
      }
    }

    // ── Try execute ──
    try {
      const result = await executeQueryOnPool(pool, currentSql);

      // ── POST-CHECK: handle large result sets ──
      if (result.rowCount > SOFT_LIMIT_ROWS) {
        console.log(`[LIMIT GUARDRAIL] Result truncated: ${result.rowCount} > ${SOFT_LIMIT_ROWS}`);
        return {
          success: true,
          sql: currentSql,
          sqlResult: {
            ...result,
            rows: result.rows.slice(0, 100),
            limited: true,
            truncated: true,
            totalRows: result.rowCount,
          },
        };
      }

      return { success: true, sql: currentSql, sqlResult: result };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Not a retryable DATABASE error
      if (!errorMsg.includes('does not exist') && !errorMsg.includes('syntax error at')) {
        return { success: false, sql: currentSql, error: errorMsg };
      }

      // Last attempt — give up
      if (attempt === maxRetries) {
        return { success: false, sql: currentSql, error: errorMsg };
      }

      // Ask LLM to fix
      const fixPrompt = buildFixPrompt('DATABASE', errorMsg, currentSql, ddlText, userQuestion, schemaJson);
      const response = await chatModel.invoke([new HumanMessage({ content: fixPrompt })]);
      const content = typeof response === 'string' ? response : (response as { content?: string }).content ?? '';

      // Extract fixed SQL from response
      const fixedSql = (content.match(/\[sql\]([\s\S]*?)\[\/sql\]/i)?.[1]
        ?? content.match(/\b(SELECT[\s\S]+?;?)\b/i)?.[0])?.replace(/;$/, '');

      if (!fixedSql || fixedSql === currentSql) {
        return { success: false, sql: currentSql, error: `Loi: ${errorMsg}. LLM khong the sua duoc.` };
      }

      currentSql = fixedSql;
    }
  }

  return { success: false, sql: currentSql, error: 'Max retries exceeded' };
}

interface AIResponse {
  type: string;
  sql?: string;
  chartType?: string;
  chartLabel?: string;
  analysis?: string;
}

async function parseAIResponse(raw: string): Promise<AIResponse> {
  // 1. Extract SQL from [sql]...[/sql] tags first
  const sqlMatch = raw.match(/\[sql\]([\s\S]*?)\[\/sql\]/i);
  const sql = sqlMatch ? sqlMatch[1].trim().replace(/;$/, '') : null;

  // 2. Build narrative = everything BEFORE [sql] + everything AFTER [/sql]
  //    This ensures msg.content never contains SQL tags
  let narrativeBefore = '';
  let narrativeAfter = '';

  if (sqlMatch) {
    narrativeBefore = raw.slice(0, sqlMatch.index).trim();
    const sqlEndIndex = raw.lastIndexOf('[/sql]');
    narrativeAfter = raw.slice(sqlEndIndex + 6).trim();
  }

  // 3. Try to parse JSON at the end (LLM writes SQL first, then JSON)
  //    We strip everything before the first { so JSON parse works reliably
  let remainingText = '';
  if (sqlMatch) {
    const sqlEndIndex = raw.lastIndexOf('[/sql]');
    remainingText = raw.slice(sqlEndIndex + 6).trim();
  } else {
    // No [sql] tags — maybe LLM wrote plain SELECT; try to strip SQL from response
    const selectIdx = raw.toUpperCase().indexOf('SELECT');
    if (selectIdx !== -1) {
      const semiIdx = raw.lastIndexOf(';');
      remainingText = raw.slice(0, selectIdx).trim() + ' ' +
        (semiIdx > selectIdx ? raw.slice(semiIdx + 1) : '').trim();
    } else {
      remainingText = raw.trim();
    }
  }

  // Try JSON — strip markdown code fences
  const jsonCandidate = remainingText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  if (jsonCandidate.startsWith('{') || jsonCandidate.startsWith('[')) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      // Use LLM's own analysis if present and non-empty
      const analysis = parsed.analysis && parsed.analysis.length > 10 ? parsed.analysis : '';
      return { ...parsed, sql: sql ?? parsed.sql, analysis };
    } catch {
      // Fall through — use remainingText as narrative
    }
  }

  // 3. Combine narrative before + after, filter out SQL-like tokens
  const combinedNarrative = [narrativeBefore, narrativeAfter]
    .filter(Boolean)
    .join('\n')
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^\{/, '')
    .replace(/^\[/, '')
    .trim();

  // Strip any remaining SQL tokens (like "SELECT", "FROM", etc.) from narrative
  const isNonTrivialNarrative = (text: string) =>
    text.length > 10
    && !text.toUpperCase().startsWith('SELECT')
    && !text.startsWith('{')
    && !text.startsWith('[')
    && !text.toUpperCase().startsWith('FROM')
    && !text.toUpperCase().startsWith('WHERE');

  const finalNarrative = isNonTrivialNarrative(combinedNarrative)
    ? combinedNarrative
    : narrativeAfter;

  if (sql) {
    return { type: 'answer', sql, analysis: finalNarrative || undefined };
  }
  return { type: 'answer', analysis: raw };
}

const VALID_CHART_TYPES = ['bar', 'line', 'pie', 'area', 'scatter'];

/**
 * Build a friendly, human-readable response instead of raw SQL.
 * Fully generic — no hardcoded table/column names.
 */
function buildFriendlyResponse(
  userMessage: string,
  sqlResult: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number } | null,
  sqlError: string | null,
  _selectedTables: SelectedTable[],
): string {
  // ── Greeting ──
  const greetingTriggers = ['xin chào', 'chào', 'hi', 'hello', 'hey', 'alo', 'tôi là'];
  const isGreeting = greetingTriggers.some(g => userMessage.toLowerCase().includes(g))
    && userMessage.length < 40;
  if (isGreeting) {
    return 'Xin chào! 👋 Tôi là trợ lý AI phân tích dữ liệu. Bạn cần hỗ trợ gì hôm nay?';
  }

  // ── Error ──
  if (sqlError) {
    return `😕 Có lỗi xảy ra khi chạy SQL: *${sqlError}*. Bạn thử diễn đạt lại câu hỏi nhé!`;
  }

  // ── No result ──
  if (!sqlResult || sqlResult.rowCount === 0) {
    // Return user-friendly message with diagnostic hints
    return '😕 Không có kết quả phù hợp.\n\nGợi ý: Có thể do:\n• Bộ lọc quá ngặt (ngày/tháng không đúng)\n• Dữ liệu chưa được nhập vào hệ thống\n• Tên bảng/cột không chính xác\n\nThử điều chỉnh lại câu hỏi nhé!';
  }

  const { columns, rows, rowCount } = sqlResult;
  const col0 = columns[0] ?? '';
  const col1 = columns[1] ?? columns[columns.length - 1] ?? '';

  // ── Single aggregate value (count, sum, avg...) ──
  const isAggregateOnly = columns.length <= 2 && rows.length === 1
    && columns.some(c => /count|sum|avg|total|min|max|so_luong|tong|dem/i.test(c));
  if (isAggregateOnly) {
    const val = rows[0][col1] ?? rows[0][col0];
    if (val !== undefined && val !== null) {
      const num = Number(val);
      return isNaN(num)
        ? `✅ Kết quả: **${val}**. Bạn cần tôi phân tích thêm không?`
        : `✅ Kết quả: **${num.toLocaleString('vi-VN')}**. Bạn cần tôi phân tích thêm không?`;
    }
  }

  // ── Generic table with numeric second column → show sorted top + total ──
  const numIdx = columns.findIndex(c => /area|dt|dien_tich|so_luong|amount|value|sum|count/i.test(c));
  const nameIdx = columns.findIndex(c =>
    /name|tên|ten_|label|district|commune|province|huyen|xa|city|user|camera|fire|weather/i.test(c)
    && c !== columns[numIdx ?? -1]
  );

  if (numIdx !== -1 && nameIdx !== -1 && rows.length <= 20) {
    const numCol = columns[numIdx];
    const nameCol = columns[nameIdx];
    const sorted = [...rows].sort((a, b) => {
      const va = Number((a as Record<string, string>)[numCol]);
      const vb = Number((b as Record<string, string>)[numCol]);
      return isNaN(va) ? 1 : isNaN(vb) ? -1 : vb - va;
    });
    const top = sorted[0] as Record<string, string>;
    const total = sorted.reduce((s, r) => {
      const v = Number((r as Record<string, string>)[numCol]);
      return s + (isNaN(v) ? 0 : v);
    }, 0);
    const topName = top[nameCol] ?? '(unknown)';
    const topVal = Number(top[numCol]).toLocaleString('vi-VN');

    const lines = sorted.slice(0, 10).map((r, i) => {
      const row = r as Record<string, string>;
      const name = row[nameCol] ?? '';
      const val = Number(row[numCol]).toLocaleString('vi-VN');
      return `${i + 1}. **${name}** — ${val}`;
    });

    const totalLine = rows.length > 1 && total > 0
      ? `\n📍 Giá trị cao nhất: **${topName}** (${topVal}). Tổng cộng: **${Math.round(total).toLocaleString('vi-VN')}**.`
      : '';

    return `📊 Kết quả (${rowCount} dòng):\n\n${lines.join('\n')}${totalLine}`;
  }

  // ── Default ──
  return `✅ Đã truy vấn thành công! Trả về **${rowCount} dòng** dữ liệu.\n\n`
    + `Bạn có muốn tôi phân tích thêm, xuất biểu đồ, hoặc hỏi thêm thông tin gì không?`;
}

function resolveChartType(
  aiChartType: string | undefined,
  finalType: string,
  sqlResult: { columns: string[]; rows: unknown[] } | null,
): string | null {
  if (finalType !== 'chart' && finalType !== 'analysis') return null;
  if (!sqlResult || sqlResult.rows.length === 0) return null;
  // Trust AI's recommendation if valid, otherwise smart fallback
  if (aiChartType && VALID_CHART_TYPES.includes(aiChartType)) return aiChartType;
  // Smart server-side fallback
  if (sqlResult.columns.length > 2) return 'line';
  return 'bar';
}

async function executeQueryOnPool(
  pool: Pool,
  sql: string
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  duration_ms: number;
  limited: boolean;
}> {
  const result = await executeSafeQuery(pool, sql, 30_000);
  return {
    columns: result.columns,
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.rowCount ?? 0,
    duration_ms: result.duration_ms,
    limited: result.limited,
  };
}

// ─── Route ───────────────────────────────────────────────────────────────────

// POST /api/chat/test-model
chatRouter.post('/test-model', async (req: AuthRequest, res) => {
  try {
    const { provider, apiKeyId, model } = req.body as {
      provider?: string; apiKeyId?: number; model?: string;
    };

    if (!apiKeyId) {
      res.status(400).json({ success: false, error: 'apiKeyId is required' });
      return;
    }

    const keyResult = await appPool.query(
      'SELECT provider, api_key FROM api_keys WHERE id = $1 AND user_id = $2',
      [apiKeyId, req.userId]
    );

    if (keyResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }

    const keyRecord = keyResult.rows[0] as { provider: string; api_key: string };
    const resolvedProvider = provider ?? keyRecord.provider;

    const config = getChatModelConfig(resolvedProvider, keyRecord.api_key, model);
    const testModel = createChatModel(resolvedProvider, keyRecord.api_key, config);

    const start = Date.now();
    try {
      const response = await testModel.invoke([new AIMessage({ content: 'Hi' })]);
      const latency_ms = Date.now() - start;
      res.json({ success: true, latency_ms, model: config.modelName });
    } catch (err) {
      res.json({ success: false, error: String(err) });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /api/chat/models?apiKeyId=1
chatRouter.get('/models', async (req: AuthRequest, res) => {
  const apiKeyId = req.query.apiKeyId ? Number(req.query.apiKeyId) : undefined;

  if (!apiKeyId) {
    res.status(400).json({ error: 'apiKeyId query param required' });
    return;
  }

  const keyResult = await appPool.query(
    'SELECT provider, api_key FROM api_keys WHERE id = $1 AND user_id = $2',
    [apiKeyId, req.userId]
  );

  if (keyResult.rows.length === 0) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }

  const { provider, api_key } = keyResult.rows[0] as { provider: string; api_key: string };

  console.log(`[GET /models] apiKeyId=${apiKeyId} provider=${provider} key=${api_key.slice(0, 10)}...`);

  try {
    const models = await fetchProviderModels(provider, api_key);
    console.log(`[GET /models] returned ${models.length} models:`, models.slice(0, 3));
    res.json({ models, provider });
  } catch (err) {
    console.error(`[GET /models] ERROR:`, err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/chat/explain-plan — show PostgreSQL execution plan
chatRouter.post('/explain-plan', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { sql, connectionId } = req.body as { sql?: string; connectionId?: number };
    if (!sql || !connectionId) {
      res.status(400).json({ error: 'sql and connectionId are required' });
      return;
    }

    const validation = validateSQL(sql);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const connection = await getConnectionDetails(req.userId!, connectionId);
    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const connStr = `postgresql://${connection.db_user}:${connection.db_password}@${connection.db_host}:${connection.db_port}/${connection.db_name}`;
    const pool = await createConnectionPool(connStr);
    try {
      const result = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`
      );
      res.json({ plan: result.rows.map(r => r['QUERY PLAN']).join('\n') });
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error('[explain-plan]', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/chat
chatRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { message, connectionId, aiProvider, apiKeyId, model, sessionId, history } =
      chatSchema.parse(req.body);

    // ── Step 1: Resolve or create chat session ──
    let resolvedSessionId = sessionId;
    if (!resolvedSessionId) {
      resolvedSessionId = await createChatSession(req.userId!);
    }

    // ── Step 1b: Fetch chat history for context ──
    const chatHistory = await getChatHistory(req.userId!, resolvedSessionId);

    // ── Step 2: Fetch key + connection in parallel ──
    const [keyRecord, connection] = await Promise.all([
      getUserApiKey(req.userId!, aiProvider, apiKeyId),
      getConnectionDetails(req.userId!, connectionId),
    ]);

    if (!keyRecord) {
      res.status(400).json({ error: 'No API key configured. Please add an API key in Settings.' });
      return;
    }
    if (!connection) {
      res.status(400).json({ error: 'No database connection configured. Please add a DB connection in Settings.' });
      return;
    }

    // ── Step 2: Setup connection pool ──
    const connectionString = `postgresql://${connection.db_user}:${connection.db_password}@${connection.db_host}:${connection.db_port}/${connection.db_name}`;
    const pool = await createConnectionPool(connectionString);

    // ── Step 3: Fetch / cache schema + table menu ──
    const cacheKey = `${connection.id}:${connection.db_host}:${connection.db_name}`;
    let enrichedSchema = getCachedSchema(cacheKey);

    if (!enrichedSchema) {
      const cached = await getCachedSchemaWithText(connection.id, message);
      if (cached) {
        enrichedSchema = cached.schema;
        setCachedSchema(cacheKey, enrichedSchema);
      }
    }

    if (!enrichedSchema) {
      try {
        enrichedSchema = await fetchSchema(pool);
        setCachedSchema(cacheKey, enrichedSchema);
        const schemaText = buildSchemaTextFromEnriched(enrichedSchema, message);
        saveSchemaSnapshot(connection.id, enrichedSchema, schemaText).catch(err =>
          console.warn('[schema-store] save failed:', err)
        );
      } finally {
        await pool.end();
      }
    } else {
      await pool.end();
    }

    // ── Step 4: Get or build table menu ──
    let menuItems = await getCachedTableMenu(connection.id);

    if (!menuItems) {
      const menuPool = await createConnectionPool(connectionString);
      try {
        menuItems = await buildTableMenuFromPool(menuPool);
        await saveTableMenu(connection.id, menuItems);
        console.log(`[table-menu] Built menu: ${menuItems.length} tables`);
      } finally {
        await menuPool.end();
      }
    }

    // ── Step 5: LLM 1 — Receptionist: Select relevant tables ──
    const { selectedTables, reasoning: tableSelectionReason, method: tableMethod } = await selectTables(
      message,
      menuItems,
      connection.id,
      keyRecord.provider,
      keyRecord.api_key,
      8,
    );

    console.log(`[table-selector] Selected ${selectedTables.length} tables (${tableMethod}): ${
      selectedTables.map(t => `${t.schema}.${t.table}`).join(', ')
    }`);

    // Build recent history summary
    let recentHistory: string | undefined;
    const previousQuestions: string[] = [];
    if (chatHistory && chatHistory.length > 0) {
      recentHistory = chatHistory.slice(-20).map(m =>
        `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 200)}`
      ).join('\n');
      // Extract previous user questions for context
      chatHistory.slice(0, -1).forEach(m => {
        if (m.role === 'user') previousQuestions.push(m.content);
      });
    }

    // ── Step 6: LLM 2 — Chef: Generate SQL from concentrated prompt ──
    let sqlResult: {
      columns: string[]; rows: Record<string, unknown>[];
      rowCount: number; duration_ms: number; limited: boolean;
    } | null = null;
    let sqlError: string | null = null;
    let finalAnalysis: string | undefined;
    let finalType = 'answer';
    let executedSql: string | null = null;
    let initialChartType: string | undefined;

    try {
      const generationResult = await generateSQL(
        message,
        selectedTables,
        menuItems,
        enrichedSchema,
        connection.id,
        keyRecord.api_key,
        keyRecord.provider,
        model,
        previousQuestions,
      );

      executedSql = generationResult.sql;
      console.log(`[sql-generator] SQL generated (RAG: ${generationResult.ragExamplesUsed}, Docs: ${generationResult.docsUsed}, Reviews: ${generationResult.reviewAttempts})`);
      if (generationResult.reviewResult) {
        console.log(`[sql-generator] Review: isValid=${generationResult.reviewResult.isValid}, confidence=${generationResult.reviewResult.confidence}`);
        if (generationResult.reviewResult.issues.length > 0) {
          console.log(`[sql-generator] Review issues:`, generationResult.reviewResult.issues);
        }
      }

      // Build concentrated system prompt for SQL execution/retry
      const focusedDDL = selectedTables.map(t =>
        `${t.schema}.${t.table}: ${t.reason}`
      ).join(', ');

      const focusedSchema = `Bảng được chọn: ${focusedDDL}`;

      // Build concentrated system prompt for SQL execution/retry
      const systemPrompt = buildSystemPrompt(
        focusedSchema,
        recentHistory,
        '', // RAG context already baked into generationResult.sql via generateSQL
        '',
      );

      // Parse the RAW response to extract SQL + narrative (before SQL tag + after [/sql] tag)
      const parsed = await parseAIResponse(generationResult.rawResponse ?? generationResult.sql);
      finalType = parsed.type ?? 'table';
      finalAnalysis = parsed.analysis ?? generationResult.explanation;
      initialChartType = parsed.chartType;

      if (parsed.sql || generationResult.sql) {
        // Use the raw-response-parsed SQL (has narrative), fallback to generationResult.sql
        executedSql = parsed.sql || generationResult.sql;
        const execPool = await createConnectionPool(connectionString);
        try {
          const retryResult = await attemptSqlWithRetry(
            execPool,
            parsed.sql ?? generationResult.sql ?? '',
            focusedSchema,
            createChatModel(
              keyRecord.provider,
              keyRecord.api_key,
              getChatModelConfig(keyRecord.provider, keyRecord.api_key, model),
            ),
            2,
            req.userId!,
            connection.id,
            message,
            enrichedSchema,
          );

          if (retryResult.success && retryResult.sqlResult) {
            sqlResult = retryResult.sqlResult;
            executedSql = retryResult.sql ?? null;
          } else {
            sqlError = retryResult.error ?? 'SQL execution failed';
            executedSql = (retryResult.sql ?? generationResult.sql) ?? null;
          }

          appPool.query(
            `INSERT INTO sql_query_history
             (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.userId, connection.id, executedSql ?? '', sqlResult ? 'success' : 'error',
            sqlResult?.duration_ms ?? null, sqlResult?.rowCount ?? null, sqlError]
          ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
        } finally {
          await execPool.end();
        }
      }
    } catch (err) {
      console.error('Chat/LangChain error:', err);
      res.status(500).json({ error: 'AI processing failed', details: String(err) });
      return;
    }

    const assistantContent = (finalAnalysis && finalAnalysis.length > 10)
      ? finalAnalysis
      : buildFriendlyResponse(message, sqlResult, sqlError, selectedTables);

    // ── Save messages to DB (non-blocking) ──
    saveChatMessages(
      req.userId!, resolvedSessionId!,
      message, assistantContent,
      executedSql,
      sqlResult ? { columns: sqlResult.columns, rows: sqlResult.rows, rowCount: sqlResult.rowCount } : null,
      sqlError
    ).catch(err => console.error('[saveChatMessages]', err));

    res.json({
      type: finalType,
      response: assistantContent,
      analysis: finalAnalysis ?? null,
      sql: executedSql,
      chartType: resolveChartType(initialChartType, finalType, sqlResult),
      sqlResult,
      sqlError,
      sessionId: resolvedSessionId,
      // Two-step flow metadata
      selectedTables,
      tableSelectionReason,
      tableMethod,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.issues });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Chat failed', details: String(err) });
    }
  }
});

// ─── SSE Streaming ────────────────────────────────────────────────────────────

const MAX_CONCURRENT_STREAMS = 50;
let activeStreamCount = 0;

function sendSSE(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// GET /api/chat/stream — token-by-token streaming via SSE
chatRouter.get('/stream', async (req: AuthRequest, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (activeStreamCount >= MAX_CONCURRENT_STREAMS) {
    res.status(503).json({ error: 'Too many concurrent streams. Please try again later.' });
    return;
  }

  const userId = req.userId;
  const { message, connectionId, aiProvider, apiKeyId, model, sessionId } = req.query as Record<string, string>;
  if (!message) {
    res.status(400).json({ error: 'message query param required' });
    return;
  }

  // ── Resolve or create chat session ──
  let resolvedSessionId = sessionId ? Number(sessionId) : await createChatSession(userId);

  activeStreamCount++;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let poolRef: Pool | null = null;

  const cleanup = () => {
    activeStreamCount = Math.max(0, activeStreamCount - 1);
    if (poolRef) {
      poolRef.end().catch(() => { });
      poolRef = null;
    }
  };

  req.on('close', cleanup);

  try {
    // Send sessionId to frontend immediately
    sendSSE(res, 'session', { sessionId: resolvedSessionId });

    // ── Step 1: Parallel DB lookups ──
    const [keyRecord, connection] = await Promise.all([
      getUserApiKey(userId, aiProvider, apiKeyId ? Number(apiKeyId) : undefined),
      getConnectionDetails(userId, connectionId ? Number(connectionId) : undefined),
    ]);

    if (!keyRecord) {
      sendSSE(res, 'error', { error: 'No API key configured. Please add an API key in Settings.' });
      res.end(); cleanup(); return;
    }
    if (!connection) {
      sendSSE(res, 'error', { error: 'No database connection configured. Please add a DB connection in Settings.' });
      res.end(); cleanup(); return;
    }

    // ── Step 0: Semantic Cache Check ──
    const connStr = `postgresql://${connection.db_user}:${connection.db_password}@${connection.db_host}:${connection.db_port}/${connection.db_name}`;
    let questionVec: number[] = [];
    try {
      questionVec = await embedText(message, keyRecord.api_key);
      const cacheResult = await checkSemanticCache(message, questionVec, connection.id, userId);

      if (cacheResult.hit && cacheResult.entry) {
        sendSSE(res, 'thinking', { message: 'Tìm thấy trong cache...' });
        // Re-execute cached SQL on fresh DB to get up-to-date data
        const freshPool = await createConnectionPool(connStr);
        try {
          const { executeSafeQuery } = await import('../utils/sqlValidator');
          const fresh = await executeSafeQuery(freshPool, cacheResult.entry.sql_query, 30_000);
          const masked = await applyDataMasking(
            fresh.rows as Record<string, unknown>[],
            fresh.columns as string[],
            connection.id
          );
          sendSSE(res, 'result', {
            columns: fresh.columns as string[],
            rows: masked.rows,
            rowCount: fresh.rowCount ?? 0,
            duration_ms: fresh.duration_ms,
            fromCache: true,
            maskedColumns: masked.maskedColumns,
          });
        } finally {
          await freshPool.end();
        }
        sendSSE(res, 'done', {});
        res.end();
        cleanup();
        return;
      }

      if (cacheResult.partial && cacheResult.entry) {
        sendSSE(res, 'thinking', {
          message: `Tìm thấy SQL tương tự (${(cacheResult.entry.similarity * 100).toFixed(0)}%), đang kiểm tra...`
        });
      }
    } catch (cacheErr) {
      console.warn('[semantic-cache] check failed, continuing:', cacheErr);
    }

    sendSSE(res, 'status', { message: 'Retrieving relevant tables...' });

    // Always create pool early (needed for attemptSqlWithRetry regardless of table retrieval result)
    poolRef = await createConnectionPool(connStr);

    // ── Phase 1: Table Retrieval — Top 20 via vector, then LLM rerank to Top 5-7 ──
    const candidates = await retrieveTopTables(message, connection.id, keyRecord.api_key, 20, 0.15);

    let topTables = candidates;
    if (candidates.length > 5) {
      sendSSE(res, 'status', { message: `Tim thay ${candidates.length} bang, LLM dang loc chon...` });
      try {
        const reranked = await rerankTablesWithLLM(
          candidates, message,
          keyRecord.provider, keyRecord.api_key, model
        );
        topTables = candidates.filter(t =>
          reranked.selectedTables.includes(`${t.table_schema}.${t.table_name}`)
        );
        sendSSE(res, 'status', {
          message: `LLM chon ${topTables.length} bang: ${reranked.selectedTables.join(', ')}`
        });
      } catch (err) {
        console.warn('[table-reranker] fallback to top-5:', err);
        topTables = candidates.slice(0, 5);
        sendSSE(res, 'status', { message: `Fallback: top ${topTables.length} bang` });
      }
    } else {
      sendSSE(res, 'status', {
        message: topTables.length
          ? `Top ${topTables.length} tables: ${topTables.map(t => `${t.table_schema}.${t.table_name}`).join(', ')}`
          : 'No table summaries found, falling back to full schema...'
      });
    }

    // ── Phase 2: DDL — only Top 5 tables' schema (with data types) ──
    let schemaDescription = '';
    let enrichedSchema: EnrichedSchema = { columns: [], foreignKeys: [] };
    if (topTables.length > 0) {
      // Fetch DDL with column types from snapshot
      // Include FK target tables too (they might not be in topTables)
      const snapshot = await getTableDDL(
        connection.id,
        topTables.map(t => ({ schema: t.table_schema, name: t.table_name }))
      );

      // Also fetch FK target tables that are NOT in topTables
      const fkTargetKeys = new Set<string>();
      for (const fk of snapshot.foreignKeys) {
        fkTargetKeys.add(`${fk.foreign_table_schema}.${fk.foreign_table_name}`);
      }
      const extraTables = [...fkTargetKeys].filter(k => {
        const [s, n] = k.split('.');
        return !topTables.some(t => t.table_schema === s && t.table_name === n);
      });
      const extraDdl = extraTables.length
        ? await getTableDDL(connection.id, extraTables.map(k => { const [s, n] = k.split('.'); return { schema: s, name: n }; }))
        : { columns: [], foreignKeys: [] };

      // Merge
      const ddl = {
        columns: [...snapshot.columns, ...extraDdl.columns],
        foreignKeys: [...snapshot.foreignKeys, ...extraDdl.foreignKeys],
      };
      enrichedSchema = ddl;
      const schemaLines: string[] = [];
      const schemas = [...new Set(topTables.map(t => t.table_schema))];
      schemaLines.push(`Cac SCHEMA: ${schemas.join(', ')}`);

      const colsByTable: Record<string, typeof ddl.columns> = {};
      for (const c of ddl.columns) {
        const key = `${c.table_schema}.${c.table_name}`;
        if (!colsByTable[key]) colsByTable[key] = [];
        colsByTable[key].push(c);
      }
      const fksByTable: Record<string, typeof ddl.foreignKeys> = {};
      for (const fk of ddl.foreignKeys) {
        const key = `${fk.table_schema}.${fk.table_name}`;
        if (!fksByTable[key]) fksByTable[key] = [];
        fksByTable[key].push(fk);
      }

      for (const t of topTables) {
        const key = `${t.table_schema}.${t.table_name}`;
        schemaLines.push(`${t.table_schema}.${t.table_name}:`);
        const fks = fksByTable[key] ?? [];
        for (const fk of fks) {
          schemaLines.push(`  FK: ${fk.column_name} → ${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`);
        }
        const cols = colsByTable[key] ?? [];
        for (const c of cols) {
          const desc = c.description ? ` — ${c.description}` : '';
          const isCodeCol = /_code$|_id$/.test(c.column_name);
          const codeWarning = isCodeCol ? ' ⚠️ MÃ ĐỊNH DANH - KHÔNG lọc tên tiếng Việt ở đây. PHẢI JOIN bảng danh mục.' : '';
          schemaLines.push(`  - ${c.column_name} (${c.data_type})${desc}${codeWarning}`);
        }
        if (t.summary_text) schemaLines.push(`  Mo ta: ${t.summary_text}`);
        schemaLines.push('');
      }
      // Also include FK-target tables that are NOT in topTables (e.g. core.commune from district FK)
      for (const extraKey of extraTables) {
        const [s, n] = extraKey.split('.');
        schemaLines.push(`${s}.${n}:`);
        const fks = fksByTable[extraKey] ?? [];
        for (const fk of fks) {
          schemaLines.push(`  FK: ${fk.column_name} → ${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`);
        }
        const cols = colsByTable[extraKey] ?? [];
        for (const c of cols) {
          const desc = c.description ? ` — ${c.description}` : '';
          const isCodeCol = /_code$|_id$/.test(c.column_name);
          const codeWarning = isCodeCol ? ' ⚠️ MÃ ĐỊNH DANH - KHÔNG lọc tên tiếng Việt ở đây. PHẢI JOIN bảng danh mục.' : '';
          schemaLines.push(`  - ${c.column_name} (${c.data_type})${desc}${codeWarning}`);
        }
        schemaLines.push('');
      }
      schemaDescription = schemaLines.join('\n');
    } else {
      // Fallback: full schema via snapshot — close pool from topTables path, reopen
      await poolRef.end();
      poolRef = await createConnectionPool(connStr);
      const cacheKey = `${connection.id}:${connection.db_host}:${connection.db_name}`;
      let es = getCachedSchema(cacheKey);
      if (!es) {
        const cached = await getCachedSchemaWithText(connection.id, message);
        if (cached) { es = cached.schema; setCachedSchema(cacheKey, es); }
      }
      if (!es) {
        es = await fetchSchema(poolRef);
        setCachedSchema(cacheKey, es);
        saveSchemaSnapshot(connection.id, es, buildSchemaTextFromEnriched(es, message))
          .catch(err => console.warn('[schema-store] save failed:', err));
      }
      enrichedSchema = es;
      const schemaIndex = getOrBuildIndex(connection.id, enrichedSchema);
      const relevantTables = await searchSchema(schemaIndex, message, 8);
      schemaDescription = buildFocusedSchemaDescription(relevantTables, schemaIndex.tables, message);
    }

    // ── Phase 2b: Fetch chat history for context ──
    const chatHistory = await getChatHistory(userId, resolvedSessionId);
    let recentHistory: string | undefined;
    if (chatHistory && chatHistory.length > 0) {
      recentHistory = chatHistory.slice(-20).map(m =>
        `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 200)}`
      ).join('\n');
    }

    // ── Phase 3: RAG — VI→SQL examples + business docs ──
    let ragContext = '';
    let docsContext = '';
    try {
      const [similarExamples, docs] = await Promise.all([
        getSimilarSQL(message, connection.id, keyRecord.api_key, 5, 0.55),
        getRelevantDocs(message, connection.id, keyRecord.api_key, 3, 0.5),
      ]);
      if (similarExamples.length > 0) ragContext = buildRagContext(similarExamples);
      if (docs.length > 0) {
        docsContext = buildDocsContext(docs);
        sendSSE(res, 'status', { message: `Found ${similarExamples.length} SQL examples, ${docs.length} docs...` });
      }
    } catch (ragErr) {
      console.warn('[RAG] retrieval failed, continuing:', ragErr);
    }

    const systemPrompt = buildSystemPrompt(schemaDescription, recentHistory, ragContext, docsContext);

    sendSSE(res, 'thinking', { message: 'Generating SQL...' });

    // ── Step 3: Token-by-token AI streaming ──
    const modelConfig = getChatModelConfig(keyRecord.provider, keyRecord.api_key, model);
    const chatModel = createChatModel(
      keyRecord.provider,
      keyRecord.api_key,
      { ...modelConfig, streaming: true, thinkingBudget: 2048 }
    );

    // Include chat history in messages for context
    const langChainMessages: (HumanMessage | SystemMessage | AIMessage)[] = [
      new SystemMessage({ content: systemPrompt }),
    ];
    if (chatHistory && chatHistory.length > 0) {
      for (const msg of chatHistory) {
        if (msg.role === 'user') langChainMessages.push(new HumanMessage({ content: msg.content }));
        else if (msg.role === 'assistant') langChainMessages.push(new AIMessage({ content: msg.content }));
        else if (msg.role === 'system') langChainMessages.push(new SystemMessage({ content: msg.content }));
      }
    }
    langChainMessages.push(new HumanMessage({ content: message }));

    const stream = await chatModel.stream(langChainMessages);

    let fullResponse = '';

    // Stream each token to frontend as it arrives (first-token latency ≈ instant)
    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = typeof chunk === 'string' ? chunk : (chunk as { content?: string }).content;
      if (text) {
        fullResponse += text;
        sendSSE(res, 'token', { text });
      }
    }

    const responseContent = fullResponse.trim();
    // Strip thinking/thinking blocks before parsing
    const cleanResponse = responseContent
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/think>/gi, '')
      .replace(/<think>/gi, '')
      .trim();
    const parsed = await parseAIResponse(cleanResponse);

    // ── Step 4: Execute SQL with retry on the SAME pool ──
    let sqlExecResult: {
      columns: string[]; rows: Record<string, unknown>[];
      rowCount: number; duration_ms: number; limited: boolean;
      truncated?: boolean; totalRows?: number;
    } | null = null;
    let sqlExecError: string | null = null;
    let executedSql: string | null = null;

    if (parsed.sql) {
      sendSSE(res, 'sql', { sql: parsed.sql });

      const retryResult = await attemptSqlWithRetry(
        poolRef,
        parsed.sql,
        schemaDescription,
        chatModel,
        2,
        userId,
        connection.id,
        message,
        enrichedSchema,
      );

      if (retryResult.success && retryResult.sqlResult) {
        sqlExecResult = retryResult.sqlResult;
        executedSql = retryResult.sql ?? parsed.sql ?? null;
        const resultData = sqlExecResult as {
          columns: string[]; rows: Record<string, unknown>[];
          rowCount: number; duration_ms: number; limited: boolean;
          truncated?: boolean; totalRows?: number;
        };
        // Apply data masking for sensitive columns
        const masked = await applyDataMasking(resultData.rows, resultData.columns, connection.id);
        sendSSE(res, 'result', {
          columns: resultData.columns,
          rows: masked.rows,
          rowCount: resultData.rowCount,
          duration_ms: resultData.duration_ms,
          truncated: resultData.truncated ?? false,
          totalRows: resultData.totalRows ?? resultData.rowCount,
          maskedColumns: masked.maskedColumns,
        });
      } else {
        sqlExecError = retryResult.error ?? 'SQL execution failed';
        executedSql = (retryResult.sql ?? parsed.sql) ?? null;
        sendSSE(res, 'error', { error: sqlExecError, sql: executedSql ?? undefined });
      }

      // Log to sql_query_history
      appPool.query(
        `INSERT INTO sql_query_history
         (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, connection.id, executedSql ?? parsed.sql ?? '', sqlExecResult ? 'success' : 'error',
          sqlExecResult?.duration_ms ?? null, sqlExecResult?.rowCount ?? null, sqlExecError]
      ).then(() => cleanupHistory(userId)).catch(err => console.error('History log error:', err));
    }

    // ── Step 5: Stream analysis text token-by-token ──
    let streamedAnalysis = '';
    if (parsed.analysis) {
      for (const char of parsed.analysis) {
        if (res.writableEnded) break;
        sendSSE(res, 'analysis', { text: char });
        streamedAnalysis += char;
        // Tiny yield to keep pipe open for concurrent writes
        await new Promise(r => setImmediate(r));
      }
    }

    // ── Save messages to DB (non-blocking) ──
    const assistantContent = streamedAnalysis
      || ((parsed.analysis && parsed.analysis.length > 10) ? parsed.analysis : '')
      || buildFriendlyResponse(message, sqlExecResult, sqlExecError, []);
    saveChatMessages(
      userId, resolvedSessionId,
      message, assistantContent,
      executedSql ?? null,
      sqlExecResult ? { columns: sqlExecResult.columns, rows: sqlExecResult.rows, rowCount: sqlExecResult.rowCount } : null,
      sqlExecError
    ).catch(err => console.error('[saveChatMessages]', err));

    // ── Save to Semantic Cache ──
    if (sqlExecResult && questionVec.length > 0) {
      saveSemanticCache(
        connection.id, userId, message,
        questionVec,
        executedSql ?? parsed.sql ?? '',
        { columns: sqlExecResult.columns, rows: sqlExecResult.rows, rowCount: sqlExecResult.rowCount }
      ).catch(err => console.warn('[semantic-cache] save failed:', err));
    }

    sendSSE(res, 'done', {});
    res.end();
    cleanup();
  } catch (err) {
    console.error('SSE stream error:', err);
    try {
      if (!res.writableEnded) {
        sendSSE(res, 'error', { error: String(err) });
        res.end();
      }
    } catch { /* already ended */ }
    cleanup();
  }
});
