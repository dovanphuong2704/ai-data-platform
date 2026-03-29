// ─── Core Domain Types ───────────────────────────────────────────────────────

export interface User {
  id: number;
  username: string;
  email: string;
  created_at: Date;
}

export interface DBConnection {
  id: number;
  user_id: number;
  profile_name: string;
  db_host: string;
  db_port: string;
  db_name: string;
  db_user: string;
  db_password: string;
  is_default: boolean;
  created_at: Date;
}

export interface APIKey {
  id: number;
  user_id: number;
  profile_name: string;
  provider: string;
  api_key: string;
  is_default: boolean;
  created_at: Date;
}

export interface DashboardItem {
  id: number;
  user_id: number;
  data: Record<string, unknown>;
  created_at: Date;
}

// ─── Query Types ─────────────────────────────────────────────────────────────

export interface QueryResult {
  columns: string[];
  rows: object[];
  rowCount?: number;
  duration_ms: number;
  limited: boolean;
}

// ─── Chat / AI Types ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sql?: string;
  chartType?: string;
  chartData?: unknown[];
  tableData?: Record<string, unknown>[];
}

export interface AIServiceConfig {
  provider: string;
  apiKey: string;
  model?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
}

// ─── Schema Types ────────────────────────────────────────────────────────────

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

export interface TableInfo {
  table_name: string;
  table_schema: string;
  columns: ColumnInfo[];
}

export interface DBSchema {
  tables: TableInfo[];
}
