'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/routing';
import { Send, Pin, Table, BarChart2, Loader2, Plug, History, Bookmark, Zap, CheckCircle2, XCircle, Database, Cpu, MessageSquare } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { cn, exportToCSV, exportToJSON } from '@/lib/utils';
import type { ChatMessage, ChatResponse, DbConnection, ApiKey } from '@/types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, AreaChart, Area } from 'recharts';
import ProviderToggle from '@/components/provider-toggle';
import QueryCancelButton from '@/components/query-cancel-button';
import SqlHistoryPanel from '@/components/sql-history-panel';
import SaveQueryModal from '@/components/save-query-modal';
import QuotaBadge from '@/components/quota-badge';
import StreamingChat from '@/components/streaming-chat';
import ChatSessionsPanel from '@/components/chat-sessions-panel';
import { useAiProvider } from '@/hooks/use-ai-provider';
import { useQueryHistory } from '@/hooks/use-query-history';
import { useQueryCancel } from '@/hooks/use-query-cancel';
import { useQuota } from '@/hooks/use-quota';
import { useTranslations } from 'next-intl';

const SUGGESTIONS = [
  'Top 10 customers by revenue',
  'Monthly sales trends',
  'Product inventory status',
  'User signups this week',
];

const CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39d353'];

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paginatedRows = rows.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [rows]);

  if (!rows.length) return <p className="text-sm text-[#8b949e]">No results found.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-[#30363d]">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-[#21262d]">
            {columns.map(col => (
              <th key={col} className="px-3 py-2 text-left font-medium text-[#8b949e] whitespace-nowrap">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paginatedRows.map((row, i) => (
            <tr key={i} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#161b22]' : 'bg-[#0d1117]')}>
              {columns.map(col => (
                <td key={col} className="px-3 py-2 text-[#e6edf3] whitespace-nowrap">{String(row[col] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#21262d]">
        <span className="text-xs text-[#8b949e]">
          {rows.length} rows
          {totalPages > 1 && ` · Trang ${clampedPage + 1}/${totalPages}`}
        </span>
        {totalPages > 1 && (
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >‹ Prev</button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >Next ›</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChartRenderer({ chartType, columns, rows }: { chartType: string; columns: string[]; rows: Record<string, unknown>[] }) {
  const data = rows.slice(0, 100);
  if (!data.length || columns.length < 2) return null;
  const xKey = columns[0];
  const yKey = columns[1];
  const chartData = data.map(row => ({ [xKey]: String(row[xKey]), [yKey]: Number(row[yKey]) || 0 }));

  const commonProps = { data: chartData, margin: { top: 5, right: 10, left: -10, bottom: 5 } };

  switch (chartType) {
    case 'bar':
      return (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
            <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} />
            <Bar dataKey={yKey} fill="#58a6ff" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );
    case 'line':
      return (
        <ResponsiveContainer width="100%" height={250}>
          <LineChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
            <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} />
            <Line type="monotone" dataKey={yKey} stroke="#3fb950" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      );
    case 'pie':
      return (
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie data={chartData} dataKey={yKey} nameKey={xKey} cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`} labelLine={false}>
              {chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} />
          </PieChart>
        </ResponsiveContainer>
      );
    case 'area':
      return (
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
            <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} />
            <Area type="monotone" dataKey={yKey} stroke="#a371f7" fill="#a371f7" fillOpacity={0.2} />
          </AreaChart>
        </ResponsiveContainer>
      );
    default:
      return null;
  }
}

export default function ChatPage() {
  const t = useTranslations('chat');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | undefined>();
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<number | undefined>();
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rerunningId, setRerunningId] = useState<number | undefined>();
  const bottomRef = useRef<HTMLDivElement>(null);

  const { provider, setProvider } = useAiProvider();
  const { history, loading: historyLoading, fetchHistory, rerunQuery } = useQueryHistory();
  const { cancelQuery, isCancelling } = useQueryCancel();
  const { quota, fetchQuota } = useQuota();

  const [saveModalSql, setSaveModalSql] = useState<string | null>(null);
  const [sqlExpandedStates, setSqlExpandedStates] = useState<Record<string, boolean>>({});
  const [streamingMode, setStreamingMode] = useState(false);

  // ── Chat sessions ────────────────────────────────────────────────────────
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(() => {
    const s = searchParams.get('s');
    return s ? Number(s) : null;
  });

  // Load messages when session changes
  useEffect(() => {
    if (!currentSessionId) return;
    loadSessionMessages(currentSessionId);
  }, [currentSessionId]);

  const loadSessionMessages = async (sessionId: number) => {
    try {
      const { data } = await apiClient.get<{
        messages: Array<{ id: number; role: string; content: string; sql?: string; sql_result?: unknown; error?: string }>;
      }>(`/chat-sessions/${sessionId}/messages`);
      const msgs: ChatMessage[] = (data.messages ?? []).map((m, i) => ({
        id: String(m.id),
        role: m.role as 'user' | 'assistant',
        content: m.content,
        sql: m.sql,
        tableData: (m.sql_result as { rows?: Record<string, unknown>[] })?.rows,
        columns: (m.sql_result as { columns?: string[] })?.columns,
        sqlError: m.error,
        sessionId,
      }));
      setMessages(msgs);
    } catch {
      // silent
    }
  };

  const handleSelectSession = useCallback((sessionId: number) => {
    setCurrentSessionId(sessionId);
    router.replace(`?s=${sessionId}`, { scroll: false });
  }, [router]);

  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    setMessages([]);
    router.replace('/chat', { scroll: false });
  }, [router]);

  const handleCancel = useCallback(async (queryId: string) => {
    await cancelQuery(queryId);
    setActiveQueryId(null);
  }, [cancelQuery]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    loadConnections();
    loadApiKeys();
  }, []);

  useEffect(() => {
    // when provider or apiKeys changes, auto-select the first/default key for that provider
    const keysForProvider = apiKeys.filter(k => k.provider === provider);
    const defaultKey = keysForProvider.find(k => k.is_default) ?? keysForProvider[0];

    // If current key doesn't match new provider, switch to a matching key
    const currentKey = apiKeys.find(k => k.id === selectedApiKeyId);
    if (!currentKey || currentKey.provider !== provider) {
      if (defaultKey) {
        setSelectedApiKeyId(defaultKey.id);
        setSelectedModel(''); // clear model — loadModels will set the correct one
      } else {
        setSelectedApiKeyId(undefined);
        setSelectedModel('');
        setAvailableModels([]);
      }
    }
  }, [provider, apiKeys]);

  // Load models when a key is selected
  useEffect(() => {
    if (!selectedApiKeyId) return;
    loadModels(selectedApiKeyId);
  }, [selectedApiKeyId]);

  const loadConnections = async () => {
    try {
      const { data } = await apiClient.get<{ connections: DbConnection[] }>('/connections?withStatus=true');
      const conns = Array.isArray(data.connections) ? data.connections : [];
      setConnections(conns);
      const isDefault = (c: DbConnection) => c.is_default === true;
      const defaultConn = conns.find(isDefault);
      setSelectedConnectionId(defaultConn?.id ?? conns[0]?.id);
    } catch { /* silent */ }
  };

  const loadApiKeys = async () => {
    try {
      const { data } = await apiClient.get<{ keys: ApiKey[] }>('/keys?withStatus=true');
      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch { /* silent */ }
  };

  const loadModels = async (keyId: number) => {
    try {
      const { data } = await apiClient.get<{ models: string[] }>(`/chat/models?apiKeyId=${keyId}`);
      const models = Array.isArray(data.models) ? data.models : [];

      // Sort: newest versions first
      const sorted = [...models].sort((a, b) => {
        // Extract version number: gemini-2.5-flash → 2.5, gemini-2.0-flash-001 → 2.0
        const getVer = (name: string) => {
          const m = name.match(/(\d+)\.(\d+)/);
          return m ? parseFloat(m[1] + '.' + m[2]) : 0;
        };
        // Prefer newer major.minor version
        const va = getVer(a);
        const vb = getVer(b);
        if (va !== vb) return vb - va;
        // Within same version: prefer date-suffixed (gemini-2.0-flash-001 > gemini-2.0-flash)
        const hasDateA = /-\d{6}$/.test(a);
        const hasDateB = /-\d{6}$/.test(b);
        if (hasDateA !== hasDateB) return hasDateA ? -1 : 1;
        // Same version: longer name (more suffixes) first (e.g. gemini-2.0-flash-001 > gemini-2.0-flash-exp)
        return b.length - a.length;
      });

      setAvailableModels(sorted);
      if (sorted.length > 0 && !sorted.includes(selectedModel)) {
        setSelectedModel(sorted[0]);
      }
    } catch {
      setAvailableModels([]);
      setSelectedModel('');
    }
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setActiveQueryId(null);

    try {
      const { data } = await apiClient.post<ChatResponse>('/chat', {
        message: text,
        connectionId: selectedConnectionId,
        aiProvider: provider,
        apiKeyId: selectedApiKeyId,
        model: selectedModel || undefined,
        sessionId: currentSessionId ?? undefined,
      });

      setActiveQueryId(data.queryId ?? null);
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response ?? data.analysis ?? 'No response',
        sql: data.sql || undefined,
        chartType: data.chartType || undefined,
        columns: data.sqlResult?.columns,
        tableData: data.sqlResult?.rows,
        sqlError: data.sqlError || undefined,
        sessionId: data.sessionId,
      };
      setMessages(prev => [...prev, assistantMsg]);

      // If this was a new session, update URL and local state
      if (data.sessionId && !currentSessionId) {
        setCurrentSessionId(data.sessionId);
        router.replace(`?s=${data.sessionId}`, { scroll: false });
      }
    } catch (err: unknown) {
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      setActiveQueryId(null);
      fetchQuota();
    }
  };

  const handleRerun = useCallback(async (entry: { id: number; sql: string; connection_id?: number }) => {
    setRerunningId(entry.id);
    try {
      if (entry.connection_id) setSelectedConnectionId(entry.connection_id);
      setInput(entry.sql);
      // scroll to input
      document.querySelector<HTMLInputElement>('input[placeholder*="Ask"]')?.focus();
    } finally {
      setRerunningId(undefined);
    }
  }, []);

  const pinToDashboard = async (msg: ChatMessage) => {
    try {
      await apiClient.post('/dashboard', {
        title: msg.content.slice(0, 80),
        type: msg.chartType ? 'chart' : 'table',
        data: {
          sql: msg.sql,
          columns: msg.columns,
          rows: msg.tableData,
          chartType: msg.chartType,
        },
      });
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, pinned: true } : m));
    } catch {
      alert(tc('error'));
    }
  };

  if (streamingMode) {
    return (
      <StreamingChat
        connectionId={selectedConnectionId}
        aiProvider={provider}
        apiKeyId={selectedApiKeyId}
        model={selectedModel || undefined}
        sessionId={currentSessionId ?? undefined}
        onBack={() => setStreamingMode(false)}
        onSessionId={(sid) => {
          setCurrentSessionId(sid);
          router.replace(`?s=${sid}`, { scroll: false });
        }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: provider toggle + history + cancel */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-[#30363d] bg-[#0d1117]">
        <div className="flex items-center gap-2">
          {quota && <QuotaBadge remaining={quota.remaining} limit={quota.limit} />}
          {/* DB status */}
          {selectedConnectionId ? (() => {
            const conn = connections.find(c => c.id === selectedConnectionId);
            if (!conn) return null;
            const label = conn.profile_name || `${conn.db_host}/${conn.db_name}`;
            if (conn.status === 'ok') return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#3fb950]/10 text-xs text-[#3fb950]">
                <CheckCircle2 size={12} />
                <span className="max-w-[120px] truncate">{label}</span>
                <span className="opacity-60">{conn.latency_ms}ms</span>
              </div>
            );
            if (conn.status === 'error') return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f85149]/10 text-xs text-[#f85149] max-w-[200px]" title={conn.error}>
                <XCircle size={12} />
                <span className="max-w-[120px] truncate">{label}</span>
                <span className="truncate opacity-80">{conn.error}</span>
              </div>
            );
            return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
                <Database size={12} />
                <span className="max-w-[120px] truncate">{label}</span>
              </div>
            );
          })() : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
              <Database size={12} />
              No DB
            </div>
          )}
          {/* AI key status */}
          {selectedApiKeyId ? (() => {
            const key = apiKeys.find(k => k.id === selectedApiKeyId);
            if (!key) return null;
            const label = key.profile_name || `${key.provider}#${key.id}`;
            if (key.status === 'ok') return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#58a6ff]/10 text-xs text-[#58a6ff]">
                <CheckCircle2 size={12} />
                <span>{label}</span>
                <span className="opacity-60">{key.latency_ms}ms</span>
              </div>
            );
            if (key.status === 'error') return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f85149]/10 text-xs text-[#f85149] max-w-[200px]" title={key.error}>
                <XCircle size={12} />
                <span>{label}</span>
                <span className="truncate opacity-80">{key.error}</span>
              </div>
            );
            return (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
                <Cpu size={12} />
                <span>{label}</span>
              </div>
            );
          })() : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
              <Cpu size={12} />
              No Key
            </div>
          )}
          <ProviderToggle provider={provider} onChange={setProvider} />
          <select
            value={selectedApiKeyId ?? ''}
            onChange={e => setSelectedApiKeyId(e.target.value ? Number(e.target.value) : undefined)}
            className="bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-2 py-1 text-xs focus:border-[#58a6ff] focus:outline-none"
            title="API key profile"
          >
            <option value="">Auto key</option>
            {apiKeys.filter(k => k.provider === provider).map(k => (
              <option key={k.id} value={k.id}>
                {k.profile_name || `${k.provider}#${k.id}`}
              </option>
            ))}
          </select>
          <select
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            className="bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-2 py-1 text-xs focus:border-[#58a6ff] focus:outline-none"
            title="Model"
          >
            <option value="">Default model</option>
            {availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <QueryCancelButton
            queryId={activeQueryId}
            isCancelling={isCancelling}
            onCancel={handleCancel}
          />
          <button
            onClick={() => setHistoryOpen(v => !v)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors',
              historyOpen
                ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10'
                : 'border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#8b949e]'
            )}
          >
            <History size={12} />
            {t('history')}
          </button>
          <button
            onClick={() => setStreamingMode(true)}
            title={t('streamingModeInfo')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#8b949e] transition-colors"
          >
            <Zap size={12} />
            {t('streaming')}
          </button>
        </div>
      </div>

      {/* Main area: sessions panel + messages + history panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat Sessions Panel */}
        <ChatSessionsPanel
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
        />

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl gradient-btn flex items-center justify-center pulse-glow">
              <BarChart2 size={32} className="text-white" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[#e6edf3]">{t('welcome')}</h3>
              <p className="text-sm text-[#8b949e] mt-1">{t('welcomeSub')}</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-lg">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-xs px-3 py-1.5 rounded-full border border-[#30363d] text-[#8b949e] hover:border-[#58a6ff] hover:text-[#58a6ff] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={cn('flex gap-3 animate-fade-in', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
            <div className={cn('max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed', msg.role === 'user' ? 'bg-[#1c3a5e] text-[#e6edf3]' : 'bg-[#161b22] border border-[#30363d] text-[#e6edf3]')}>
              <p className="whitespace-pre-wrap">{msg.content}</p>

              {msg.sql && (
                <div className="mt-3 rounded-lg border border-[#30363d] overflow-hidden">
                  {/* Header bar */}
                  <div className="flex items-center justify-between bg-[#1c2128] px-3 py-1.5 border-b border-[#30363d]">
                    <div className="flex items-center gap-2">
                      {!msg.pinned && (
                        <button onClick={() => pinToDashboard(msg)} title={t('pinToDashboard')} className="text-[#8b949e] hover:text-[#58a6ff] transition-colors">
                          <Pin size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => { setSaveModalSql(msg.sql ?? null); }}
                        title={t('saveQuery')}
                        className="text-[#8b949e] hover:text-[#3fb950] transition-colors"
                      >
                        <Bookmark size={12} />
                      </button>
                    </div>
                    <button
                      onClick={() => setSqlExpandedStates(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                      className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#58a6ff] transition-colors"
                    >
                      {sqlExpandedStates[msg.id] ? '▲ Ẩn SQL' : '▼ Xem SQL'}
                    </button>
                  </div>
                  {/* SQL body — hidden by default */}
                  <div className={cn('bg-[#0d1117]', !sqlExpandedStates[msg.id] ? 'hidden' : '')}>
                    <pre className="text-xs font-mono text-[#58a6ff] px-3 py-2 whitespace-pre-wrap break-all overflow-x-auto">
                      {msg.sql}
                    </pre>
                  </div>
                </div>
              )}

              {msg.chartType && msg.tableData && (
                <div className="mt-3">
                  <ChartRenderer chartType={msg.chartType} columns={msg.columns || []} rows={msg.tableData} />
                  <div className="flex gap-2 mt-2">
                    {msg.tableData.length > 0 && (
                      <>
                        <button onClick={() => exportToCSV(msg.columns || [], msg.tableData || [])} className="text-xs flex items-center gap-1 text-[#8b949e] hover:text-[#58a6ff]">
                          <Table size={12} /> {t('exportCsv')}
                        </button>
                        <button onClick={() => exportToJSON(msg.tableData || [])} className="text-xs text-[#8b949e] hover:text-[#58a6ff]">
                          {t('exportJson')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {msg.tableData && !msg.chartType && (
                <div className="mt-3">
                  <ResultTable columns={msg.columns || []} rows={msg.tableData} />
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => exportToCSV(msg.columns || [], msg.tableData || [])} className="text-xs flex items-center gap-1 text-[#8b949e] hover:text-[#58a6ff]">
                      <Table size={12} /> {t('exportCsv')}
                    </button>
                    <button onClick={() => exportToJSON(msg.tableData || [])} className="text-xs text-[#8b949e] hover:text-[#58a6ff]">{t('exportJson')}</button>
                  </div>
                </div>
              )}

              {msg.sqlError && (
                <p className="mt-2 text-xs text-[#f85149] bg-[#f85149]/10 px-2 py-1 rounded inline-block">SQL Error: {msg.sqlError}</p>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3 animate-fade-in">
            <div className="w-8 h-8 rounded-full bg-[#21262d] flex items-center justify-center flex-shrink-0">
              <BarChart2 size={16} className="text-[#58a6ff]" />
            </div>
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-[#8b949e]">
                <Loader2 size={14} className="animate-spin" />
                {t('thinking')}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
        </div>

        {/* SQL History Panel */}
        <SqlHistoryPanel
          isOpen={historyOpen}
          onClose={() => setHistoryOpen(false)}
          history={history}
          loading={historyLoading}
          onFetch={fetchHistory}
          onRerun={handleRerun}
          rerunningId={rerunningId}
        />
      </div>

      {/* Connection selector bar */}
      <div className="px-6 py-2 border-t border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[#8b949e]">
            <Plug size={12} />
            Database
          </label>
          <select
            value={selectedConnectionId ?? ''}
            onChange={e => setSelectedConnectionId(e.target.value ? Number(e.target.value) : undefined)}
            className="bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-1.5 text-xs focus:border-[#58a6ff] focus:outline-none flex-1 max-w-xs"
          >
            <option value="">— Select a connection —</option>
            {connections.map(conn => (
              <option key={conn.id} value={conn.id}>
                {conn.profile_name || `${conn.db_host}/${conn.db_name}`}{conn.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {connections.length === 0 && (
            <a href="/settings" className="text-xs text-[#d29922] hover:underline">
              Add a connection in Settings
            </a>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-[#30363d] bg-[#161b22]">
        <form
          onSubmit={e => { e.preventDefault(); sendMessage(input); }}
          className="flex gap-3"
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={t('placeholder')}
            disabled={loading}
            className="flex-1 bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-xl px-4 py-3 text-sm focus:border-[#58a6ff] focus:outline-none disabled:opacity-50 transition-colors"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="gradient-btn px-5 py-3 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold"
          >
            <Send size={16} />
            Send
          </button>
        </form>
      </div>

      {/* Save Query Modal */}
      {saveModalSql !== null && (
        <SaveQueryModal
          sql={saveModalSql}
          connectionId={selectedConnectionId}
          onClose={() => setSaveModalSql(null)}
          onSaved={() => { setSaveModalSql(null); }}
        />
      )}
    </div>
  );
}
