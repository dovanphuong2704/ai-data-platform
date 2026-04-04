import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const apiClient = axios.create({
  baseURL: `${API_BASE}/api`,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Response interceptor for error handling
apiClient.interceptors.response.use(
  response => response,
  error => {
    const message = error.response?.data?.error || error.message || 'An error occurred';
    return Promise.reject(new Error(message));
  }
);

// ─── Training API ─────────────────────────────────────────────────────────────

export interface TrainingConnectionStatus {
  id: number;
  profile_name: string;
  db_host: string;
  db_port: string;
  db_name: string;
  db_user: string;
  is_default: boolean;
  created_at: string;
  total_tables: number | null;
  menu_generated_at: string | null;
  summary_count: string | null;
  fk_count: string | null;
  soft_fk_count: string | null;
  example_count: string | null;
  table_count: number | null;
  column_count: number | null;
  version_hash: string | null;
  snapshot_updated_at: string | null;
}

export interface TrainingMenu {
  id: number;
  connection_id: number;
  menu_json: unknown[];
  total_tables: number;
  generated_at: string;
}

export interface TrainingSummary {
  table_schema: string;
  table_name: string;
  summary_text: string;
  column_list: string;
  fk_hint: string;
}

export interface TrainingFK {
  id: number;
  source_schema: string;
  source_table: string;
  source_column: string;
  target_schema: string;
  target_table: string;
  target_column: string;
  direction: string;
  hint_text: string;
  keywords: string;
  created_at: string;
}

export interface TrainingExample {
  id: number;
  connection_id: number;
  question_vi: string;
  sql: string;
  source: string;
  created_at: string;
}

export interface PaginatedResponse<T> {
  entries: T[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export const trainingApi = {
  listConnections: () =>
    apiClient.get('/training/connections'),

  getMenu: (connectionId: number) =>
    apiClient.get('/training/menus', { params: { connectionId } }),

  deleteMenu: (connectionId: number) =>
    apiClient.delete(`/training/menus/${connectionId}`),

  getSummaries: (connectionId: number, page = 1, limit = 50) =>
    apiClient.get('/training/summaries', { params: { connectionId, page, limit } }),

  getForeignKeys: (connectionId: number, page = 1, limit = 100) =>
    apiClient.get('/training/foreign-keys', { params: { connectionId, page, limit } }),

  getExamples: (connectionId: number, page = 1, limit = 20) =>
    apiClient.get('/training/examples', { params: { connectionId, page, limit } }),

  addExample: (data: { connectionId: number; question: string; sql: string }) =>
    apiClient.post('/training/examples', data),

  deleteExample: (id: number) =>
    apiClient.delete(`/training/examples/${id}`),

  getSnapshot: (connectionId: number) =>
    apiClient.get('/training/snapshots', { params: { connId: connectionId } }),

  refreshSnapshot: (connectionId: number) =>
    apiClient.post(`/training/snapshots/refresh/${connectionId}`),

  deleteSnapshot: (connectionId: number) =>
    apiClient.delete(`/training/snapshots/${connectionId}`),

  seed: (data: { connectionId: number; sections?: string[] }) =>
    apiClient.post('/training/seed', data),
};
