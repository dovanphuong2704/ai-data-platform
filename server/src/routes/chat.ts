import { Router, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { appPool, createConnectionPool } from '../services/db';
import { cleanupHistory } from './history';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validateSQL, executeSafeQuery } from '../utils/sqlValidator';
import { createChatModel, getChatModelConfig, fetchProviderModels } from '../services/ai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';

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
}

const schemaCache = new Map<string, { data: SchemaColumn[]; ts: number }>();
const SCHEMA_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedSchema(key: string): SchemaColumn[] | null {
  const entry = schemaCache.get(key);
  if (entry && Date.now() - entry.ts < SCHEMA_TTL_MS) return entry.data;
  return null;
}

function setCachedSchema(key: string, data: SchemaColumn[]): void {
  schemaCache.set(key, { data, ts: Date.now() });
}

export function invalidateSchemaCache(connectionId: number): void {
  for (const k of schemaCache.keys()) {
    if (k.startsWith(`${connectionId}:`)) schemaCache.delete(k);
  }
}

export function clearAllSchemaCache(): void {
  schemaCache.clear();
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

async function fetchSchema(pool: Pool): Promise<SchemaColumn[]> {
  const result = await pool.query<SchemaColumn>(`
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
    LIMIT 500
  `);
  return result.rows;
}

function buildSchemaDescription(columns: SchemaColumn[]): string {
  const tableMap: Record<string, SchemaColumn[]> = {};
  for (const col of columns) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!tableMap[key]) tableMap[key] = [];
    tableMap[key].push(col);
  }
  return Object.entries(tableMap)
    .map(([table, cols]) => {
      const colList = cols
        .map((c) => `  - ${c.column_name} (${c.data_type})`)
        .join('\n');
      return `${table}:\n${colList}`;
    })
    .join('\n\n');
}

function buildSystemPrompt(schema: string): string {
  return `You are an AI SQL assistant for a PostgreSQL database with MULTIPLE schemas.
Your job: convert natural language questions into precise SQL queries.

IMPORTANT RULES:
- This database contains MULTIPLE schemas: public, filter, fire, camera, config, weatherlink, user, detect, map, and more
- ALWAYS use schema prefix when referencing tables: schema_name.table_name
  - Example: SELECT * FROM camera.devices NOT SELECT * FROM devices
  - Example: SELECT * FROM public.users NOT SELECT * FROM users
- ONLY output valid PostgreSQL SELECT statements (no INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, etc.)
- Use proper PostgreSQL syntax
- Always include appropriate JOINs, WHERE clauses, GROUP BY, ORDER BY as needed
- ALWAYS respond with ONLY a valid JSON object — no markdown, no explanations, no text outside the JSON

Response format options:

1. For raw data / table request:
{"type": "table", "sql": "SELECT ..."}

2. For a chart request:
{"type": "chart", "sql": "SELECT ...", "chartType": "bar|line|pie|area|scatter", "chartLabel": "..."}

3. For analysis / insight:
{"type": "analysis", "sql": "SELECT ...", "chartType": "bar|line|pie|area|scatter", "analysis": "Detailed explanation of what the data shows."}

4. For a conversational answer (no SQL needed):
{"type": "answer", "analysis": "Your answer text here."}

Database schema:
${schema}

Respond with ONLY the JSON object.`;
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

    let schemaColumns: SchemaColumn[] = [];
    try {
      const cacheKey = `${connection.id}:${connection.db_host}:${connection.db_name}`;
      schemaColumns = getCachedSchema(cacheKey) ?? await fetchSchema(pool);
      if (!getCachedSchema(cacheKey)) setCachedSchema(cacheKey, schemaColumns);
    } finally {
      await pool.end();
    }

    const schemaDescription = buildSchemaDescription(schemaColumns);
    const systemPrompt = buildSystemPrompt(schemaDescription);

    let sqlResult: {
      columns: string[]; rows: Record<string, unknown>[];
      rowCount: number; duration_ms: number; limited: boolean;
    } | null = null;
    let sqlError: string | null = null;
    let finalAnalysis: string | undefined;
    let finalType = 'answer';
    let executedSql: string | null = null;

    try {
      const modelConfig = getChatModelConfig(keyRecord.provider, keyRecord.api_key, model);
      const chatModel = createChatModel(keyRecord.provider, keyRecord.api_key, modelConfig);

      const langChainMessages: (HumanMessage | SystemMessage | AIMessage)[] = [
        new SystemMessage({ content: systemPrompt }),
      ];

      if (history && history.length > 0) {
        for (const msg of history) {
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

      if (parsed.sql) {
        const validation = validateSQL(parsed.sql);
        if (!validation.valid) {
          sqlError = validation.error ?? 'Invalid SQL';
        } else {
          executedSql = validation.sql!;
          const execPool = await createConnectionPool(connectionString);
          try {
            sqlResult = await executeQueryOnPool(execPool, executedSql);

            // ── Log to sql_query_history ──
            appPool.query(
              `INSERT INTO sql_query_history
               (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [req.userId, connection.id, executedSql, 'success', sqlResult.duration_ms, sqlResult.rowCount, null]
            ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
          } catch (err) {
            sqlError = String(err);

            // ── Log failed query to sql_query_history ──
            appPool.query(
              `INSERT INTO sql_query_history
               (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [req.userId, connection.id, executedSql ?? parsed.sql, 'error', null, null, sqlError]
            ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
          } finally {
            await execPool.end();
          }
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
      chartType: (finalType === 'chart' || finalType === 'analysis')
        ? (sqlResult && sqlResult.rows.length > 0 ? (sqlResult.columns.length > 2 ? 'line' : 'bar') : null)
        : null,
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

  const { message, connectionId, aiProvider, apiKeyId, model, sessionId } = req.query as Record<string, string>;
  if (!message) {
    res.status(400).json({ error: 'message query param required' });
    return;
  }

  // ── Resolve or create chat session ──
  let resolvedSessionId = sessionId ? Number(sessionId) : await createChatSession(req.userId);

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
      poolRef.end().catch(() => {});
      poolRef = null;
    }
  };

  req.on('close', cleanup);

  try {
    // Send sessionId to frontend immediately
    sendSSE(res, 'session', { sessionId: resolvedSessionId });

    // ── Step 1: Parallel DB lookups ──
    const [keyRecord, connection] = await Promise.all([
      getUserApiKey(req.userId, aiProvider, apiKeyId ? Number(apiKeyId) : undefined),
      getConnectionDetails(req.userId, connectionId ? Number(connectionId) : undefined),
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
    let schemaColumns = getCachedSchema(cacheKey);

    if (!schemaColumns) {
      schemaColumns = await fetchSchema(poolRef);
      setCachedSchema(cacheKey, schemaColumns);
    }

    const schemaDescription = buildSchemaDescription(schemaColumns);
    const systemPrompt = buildSystemPrompt(schemaDescription);

    sendSSE(res, 'thinking', { message: 'Generating SQL...' });

    // ── Step 3: Token-by-token AI streaming ──
    const modelConfig = getChatModelConfig(keyRecord.provider, keyRecord.api_key, model);
    const chatModel = createChatModel(
      keyRecord.provider,
      keyRecord.api_key,
      { ...modelConfig, streaming: true }
    );

    const langChainMessages = [
      new SystemMessage({ content: systemPrompt }),
      new HumanMessage({ content: message }),
    ];

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

    // ── Step 4: Execute SQL on the SAME pool ──
    let sqlExecResult: Awaited<ReturnType<typeof executeQueryOnPool>> | null = null;
    let sqlExecError: string | null = null;
    if (parsed.sql) {
      sendSSE(res, 'sql', { sql: parsed.sql });

      const validation = validateSQL(parsed.sql);
      if (!validation.valid) {
        sendSSE(res, 'error', { error: validation.error ?? 'Invalid SQL' });
        // ── Log failed validation to sql_query_history ──
        appPool.query(
          `INSERT INTO sql_query_history
           (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.userId, connection.id, parsed.sql ?? '', 'error', null, null, validation.error ?? 'Invalid SQL']
        ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
      } else {
        try {
          sqlExecResult = await executeQueryOnPool(poolRef, validation.sql!);
          sendSSE(res, 'result', {
            columns: sqlExecResult.columns,
            rows: sqlExecResult.rows,
            rowCount: sqlExecResult.rowCount,
            duration_ms: sqlExecResult.duration_ms,
          });
          // ── Log successful query to sql_query_history ──
          appPool.query(
            `INSERT INTO sql_query_history
             (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.userId, connection.id, validation.sql!, 'success', sqlExecResult.duration_ms, sqlExecResult.rowCount, null]
          ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
        } catch (execErr) {
          sqlExecError = String(execErr);
          sendSSE(res, 'error', { error: sqlExecError, sql: validation.sql });
          // ── Log failed query to sql_query_history ──
          appPool.query(
            `INSERT INTO sql_query_history
             (user_id, connection_id, sql, status, duration_ms, rows_returned, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.userId, connection.id, validation.sql!, 'error', null, null, sqlExecError]
          ).then(() => cleanupHistory(req.userId!)).catch(err => console.error('History log error:', err));
        }
      }
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
      req.userId, resolvedSessionId,
      message, assistantContent,
      parsed.sql ?? null,
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
