export interface User {
  id: number;
  username: string;
  email: string;
  created_at: string;
}

export interface DbConnection {
  id: number;
  user_id: number;
  profile_name: string | null;
  db_host: string;
  db_port: string;
  db_name: string;
  db_user: string;
  is_default: boolean;
  created_at: string;
  status?: 'ok' | 'error';
  latency_ms?: number;
  error?: string;
}

export interface ApiKey {
  id: number;
  user_id: number;
  profile_name: string | null;
  provider: 'openai' | 'grok' | 'gemini' | 'claude';
  api_key?: string; // masked on API response
  is_default: boolean;
  created_at: string;
  status?: 'ok' | 'error';
  latency_ms?: number;
  error?: string;
}

export interface DashboardItem {
  id: number;
  user_id: number;
  data: {
    title?: string;
    type: string;
    sql?: string;
    columns?: string[];
    rows?: Record<string, unknown>[];
    chartType?: string;
  };
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  chartType?: string;
  chartData?: Record<string, unknown>[];
  columns?: string[];
  tableData?: Record<string, unknown>[];
  sqlError?: string;
  pinned?: boolean;
  sessionId?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  sql?: string;
}

export interface ChatResponse {
  response?: string;
  analysis?: string | null;
  type: 'table' | 'analysis' | 'answer';
  sql: string | null;
  chartType: string | null;
  chartSuggestion?: string | null;
  sqlResult: QueryResult | null;
  sqlError: string | null;
  queryId?: string;
  sessionId?: number;
}

// ─── Phase 4: Frontend Core ──────────────────────────────────────────────────

export interface SqlHistoryEntry {
  id: number;
  sql: string;
  status: 'success' | 'error' | 'cancelled';
  duration_ms: number;
  rows_returned: number;
  error_message?: string;
  created_at: string;
  connection_id?: number;
}

export interface QuotaInfo {
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface QueryCancelResponse {
  cancelled: boolean;
  queryId: string;
}

// ─── Phase 5: Frontend UI ─────────────────────────────────────────────────────

export interface SavedQuery {
  id: number;
  name: string;
  sql?: string;           // optional in list endpoint
  description?: string;
  connection_id?: number;
  created_at: string;
  updated_at: string;
}

export interface QuotaResponse {
  remaining: number;
  limit: number;
  window_reset_at: string;
}

export interface ConnectionTestResult {
  success: boolean;
  latency_ms?: number;
  error?: string;
}

// ─── Explorer / Schema ─────────────────────────────────────────────────────────

export interface SchemaOverview {
  schema_name: string;
  table_count: number;
}

export interface ColumnDetail {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
}

export interface TableDetail {
  schema_name: string;
  table_name: string;
  columns: ColumnDetail[];
}

export interface ForeignKeyDetail {
  constraint_name: string;
  from_schema: string;
  from_table: string;
  from_column: string;
  to_schema: string;
  to_table: string;
  to_column: string;
}

export interface SchemaInfoResponse {
  schemas: SchemaOverview[];
  tables: TableDetail[];
  foreignKeys: ForeignKeyDetail[];
}

// ─── Phase 6: Advanced Frontend ───────────────────────────────────────────────

export interface ScheduledQuery {
  id: number;
  name: string;
  sql?: string;           // optional in list endpoint
  schedule_cron: string;
  connection_id?: number;
  is_active: boolean;
  last_run_at?: string;
  last_run_status?: string;
  created_at: string;
}

export interface Alert {
  id: number;
  name: string;
  query_sql: string;
  threshold_value: number;
  condition: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne';
  connection_id?: number;
  is_active: boolean;
  last_checked_at?: string;
  last_triggered_at?: string;
  notify_email: boolean;
  created_at: string;
}

export interface AlertWebhook {
  id: number;
  alert_id: number;
  webhook_url: string;
  is_enabled: boolean;
  created_at: string;
}

export interface ShareTarget {
  user_id: number;
  username: string;
  permission: 'view' | 'edit';
}
