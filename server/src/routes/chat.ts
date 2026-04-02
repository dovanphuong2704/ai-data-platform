import { Router, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { appPool, createConnectionPool } from '../services/db';
import { cleanupHistory } from './history';
import { getDict } from './schema-dictionary';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validateSQL, executeSafeQuery } from '../utils/sqlValidator';
import { createChatModel, getChatModelConfig, fetchProviderModels } from '../services/ai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

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
        return `  - ${c.column_name} (${c.data_type})${desc}`;
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
  // Fetch columns with descriptions
  const colResult = await pool.query<SchemaColumn>(`
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.column_default,
      NULL AS description
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
    LIMIT 500
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

  return {
    columns: colResult.rows,
    foreignKeys: fkResult.rows,
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

function buildSystemPrompt(schema: string, recentHistory?: string): string {
  return `Bạn là Chuyên gia phân tích dữ liệu SQL PostgreSQL. Nhiệm vụ của bạn là chuyển đổi câu hỏi của người dùng thành truy vấn SQL chính xác.

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
   - KHÔNG BAO GIỜ thêm LIMIT vào câu SQL.
   - Nếu người dùng chỉ định giới hạn số bản ghi (LIMIT), hãy tuân thủ.
   - Sử dụng các Foreign Keys đã cung cấp để thực hiện JOIN chính xác.

4. **ĐỊNH DẠNG PHẢN HỒI JSON (DUY NHẤT):**
   Trả về JSON nguyên bản, không bao bọc trong code block (không dùng markdown), không thêm văn bản thừa.
   {"type":"table"|"chart"|"analysis"|"answer", "sql":"Câu lệnh SQL", "chartType":"bar"|"line"|"pie"|"area", "chartLabel":"Tiêu đề", "analysis":"Giải thích kết quả bằng tiếng Việt (2-5 câu), chỉ ra xu hướng hoặc bất thường."}

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

### 🗄️ DANH SÁCH SCHEMA CHI TIẾT (DÙNG CHÍNH XÁC TÊN DƯỚI ĐÂY):
${schema}`;
}

interface SqlRetryResult {
  success: boolean;
  sql?: string;
  error?: string;
  sqlResult?: {
    columns: string[]; rows: Record<string, unknown>[];
    rowCount: number; duration_ms: number; limited: boolean;
  };
}

async function attemptSqlWithRetry(
  pool: Pool,
  initialSql: string,
  systemPrompt: string,
  chatModel: BaseChatModel,
  maxRetries = 2,
  _userId: number,
  _connectionId: number,
): Promise<SqlRetryResult> {
  let sql = initialSql;
  console.log('systemPrompt', systemPrompt);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const validation = validateSQL(sql);

    if (!validation.valid) {
      if (attempt < maxRetries) {
        const fixPrompt = `Lỗi SQL: ${validation.error}\nSQL hiện tại: ${sql}\nHãy sửa SQL và trả về JSON.`;
        const msgs: (HumanMessage | SystemMessage)[] = [
          new SystemMessage({ content: systemPrompt }),
          new HumanMessage({ content: fixPrompt }),
        ];
        const response = await chatModel.invoke(msgs);
        const content = typeof response === 'string' ? response : (response as { content?: string }).content ?? '';
        const parsed = await parseAIResponse(content as string);
        if (parsed.sql && parsed.sql !== sql) { sql = parsed.sql; continue; }
      }
      return { success: false, error: validation.error ?? 'Invalid SQL', sql };
    }

    try {
      const result = await executeQueryOnPool(pool, validation.sql!);
      return { success: true, sql: validation.sql, sqlResult: result };
    } catch (execErr) {
      if (attempt < maxRetries) {
        const fixPrompt = `Lỗi khi chạy SQL: ${execErr}\nSQL: ${validation.sql}\nHãy sửa SQL và trả về JSON.`;
        const msgs: (HumanMessage | SystemMessage)[] = [
          new SystemMessage({ content: systemPrompt }),
          new HumanMessage({ content: fixPrompt }),
        ];
        const response = await chatModel.invoke(msgs);
        const content = typeof response === 'string' ? response : (response as { content?: string }).content ?? '';
        const parsed = await parseAIResponse(content as string);
        if (parsed.sql && parsed.sql !== sql) { sql = parsed.sql; continue; }
      }
      return { success: false, error: String(execErr), sql: validation.sql };
    }
  }
  return { success: false, error: 'Max retries exceeded', sql };
}

interface AIResponse {
  type: string;
  sql?: string;
  chartType?: string;
  chartLabel?: string;
  analysis?: string;
}

async function parseAIResponse(raw: string): Promise<AIResponse> {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned) as AIResponse;
  } catch {
    return { type: 'answer', analysis: raw };
  }
}

const VALID_CHART_TYPES = ['bar', 'line', 'pie', 'area', 'scatter'];

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

    // ── Step 2: Single pool for schema + execute ──
    const connectionString = `postgresql://${connection.db_user}:${connection.db_password}@${connection.db_host}:${connection.db_port}/${connection.db_name}`;
    const pool = await createConnectionPool(connectionString);

    let enrichedSchema: EnrichedSchema = { columns: [], foreignKeys: [] };
    try {
      const cacheKey = `${connection.id}:${connection.db_host}:${connection.db_name}`;
      enrichedSchema = getCachedSchema(cacheKey) ?? await fetchSchema(pool);
      if (!getCachedSchema(cacheKey)) setCachedSchema(cacheKey, enrichedSchema);
    } finally {
      await pool.end();
    }

    // Build schema index and find relevant tables via semantic search
    const schemaIndex = getOrBuildIndex(connection.id, enrichedSchema);
    const relevantTables = await searchSchema(schemaIndex, message, 8);
    const schemaDescription = buildFocusedSchemaDescription(relevantTables, schemaIndex.tables, message);

    // Build recent history summary for system prompt context
    let recentHistory: string | undefined;
    if (chatHistory && chatHistory.length > 0) {
      recentHistory = chatHistory.slice(-20).map(m =>
        `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 200)}`
      ).join('\n');
    }

    const systemPrompt = buildSystemPrompt(schemaDescription, recentHistory);

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
      const modelConfig = getChatModelConfig(keyRecord.provider, keyRecord.api_key, model);
      const chatModel = createChatModel(keyRecord.provider, keyRecord.api_key, modelConfig);

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

      const response = await chatModel.invoke(langChainMessages);
      const responseContent = typeof response === 'string' ? response : (response as { content?: string }).content;

      const parsed = await parseAIResponse(responseContent as string);
      finalType = parsed.type ?? 'answer';
      finalAnalysis = parsed.analysis;
      initialChartType = parsed.chartType;

      if (parsed.sql) {
        const execPool = await createConnectionPool(connectionString);
        try {
          // Attempt with retry (up to 2 times) if SQL fails
          const retryResult = await attemptSqlWithRetry(
            execPool,
            parsed.sql,
            systemPrompt,
            chatModel,
            2,
            req.userId!,
            connection.id,
          );

          if (retryResult.success && retryResult.sqlResult) {
            sqlResult = retryResult.sqlResult;
            executedSql = retryResult.sql ?? null;
          } else {
            sqlError = retryResult.error ?? 'SQL execution failed';
            executedSql = (retryResult.sql ?? parsed.sql) ?? null;
          }

          // Log to sql_query_history
          appPool.query(
            `INSERT INTO sql_query_history
             (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.userId, connection.id, executedSql ?? parsed.sql ?? '', sqlResult ? 'success' : 'error',
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

    const assistantContent = finalAnalysis ?? (sqlResult ? `Returned ${sqlResult.rowCount} rows.` : 'Done.');

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

    sendSSE(res, 'status', { message: 'Fetching schema...' });

    // ── Step 2: Single pool + schema cache ──
    const connectionString = `postgresql://${connection.db_user}:${connection.db_password}@${connection.db_host}:${connection.db_port}/${connection.db_name}`;
    poolRef = await createConnectionPool(connectionString);

    const cacheKey = `${connection.id}:${connection.db_host}:${connection.db_name}`;
    let enrichedSchema = getCachedSchema(cacheKey);

    if (!enrichedSchema) {
      enrichedSchema = await fetchSchema(poolRef);
      setCachedSchema(cacheKey, enrichedSchema);
    }

    // ── Step 2b: Fetch chat history for context ──
    const chatHistory = await getChatHistory(userId, resolvedSessionId);

    // Build recent history summary for system prompt
    let recentHistory: string | undefined;
    if (chatHistory && chatHistory.length > 0) {
      recentHistory = chatHistory.slice(-20).map(m =>
        `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 200)}`
      ).join('\n');
    }

    // Semantic search: find relevant tables based on user question
    const schemaIndex = getOrBuildIndex(connection.id, enrichedSchema);
    const relevantTables = await searchSchema(schemaIndex, message, 8);
    const schemaDescription = buildFocusedSchemaDescription(relevantTables, schemaIndex.tables, message);
    const systemPrompt = buildSystemPrompt(schemaDescription, recentHistory);

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
    const parsed = await parseAIResponse(responseContent);

    // ── Step 4: Execute SQL with retry on the SAME pool ──
    let sqlExecResult: Awaited<ReturnType<typeof executeQueryOnPool>> | null = null;
    let sqlExecError: string | null = null;
    let executedSql: string | null = null;

    if (parsed.sql) {
      sendSSE(res, 'sql', { sql: parsed.sql });

      const retryResult = await attemptSqlWithRetry(
        poolRef,
        parsed.sql,
        systemPrompt,
        chatModel,
        2,
        userId,
        connection.id,
      );

      if (retryResult.success && retryResult.sqlResult) {
        sqlExecResult = retryResult.sqlResult;
        executedSql = retryResult.sql ?? parsed.sql ?? null;
        sendSSE(res, 'result', {
          columns: sqlExecResult.columns,
          rows: sqlExecResult.rows,
          rowCount: sqlExecResult.rowCount,
          duration_ms: sqlExecResult.duration_ms,
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
      || (sqlExecResult ? `Returned ${sqlExecResult.rowCount} rows.` : 'Done.');
    saveChatMessages(
      userId, resolvedSessionId,
      message, assistantContent,
      executedSql ?? null,
      sqlExecResult ? { columns: sqlExecResult.columns, rows: sqlExecResult.rows, rowCount: sqlExecResult.rowCount } : null,
      sqlExecError
    ).catch(err => console.error('[saveChatMessages]', err));

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
