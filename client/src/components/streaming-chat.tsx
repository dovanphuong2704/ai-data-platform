'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Info, X } from 'lucide-react';
import { cn, exportToCSV, exportToJSON } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { AIProvider } from '@/hooks/use-ai-provider';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area
} from 'recharts';

const MAX_RETRIES = 3;
const CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39d353'];
const VALID_CHART_TYPES = ['bar', 'line', 'pie', 'area', 'scatter'];

interface StreamingChatProps {
  connectionId?: number;
  aiProvider: AIProvider;
  apiKeyId?: number;
  model?: string;
  sessionId?: number;
  onBack?: () => void;
  onSessionId?: (sessionId: number) => void;
}

interface StreamMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  chartType?: string;
  columns?: string[];
  tableData?: Record<string, unknown>[];
  duration_ms?: number;
  rowCount?: number;
  error?: string;
  truncated?: boolean;
  totalRows?: number;
  fromCache?: boolean;
  maskedColumns?: string[];
}

type StreamPhase = 'idle' | 'status' | 'thinking' | 'token' | 'sql' | 'result' | 'analysis' | 'done';

export default function StreamingChat({ connectionId, aiProvider, apiKeyId, model, sessionId, onBack, onSessionId }: StreamingChatProps) {
  const t = useTranslations('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [currentSql, setCurrentSql] = useState('');
  const [currentTokens, setCurrentTokens] = useState('');
  const [currentAnalysis, setCurrentAnalysis] = useState('');
  const [currentResult, setCurrentResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; duration_ms: number; truncated?: boolean; totalRows?: number; fromCache?: boolean; maskedColumns?: string[] } | null>(null);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const finalResultRef = useRef<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; duration_ms: number; truncated?: boolean; totalRows?: number; fromCache?: boolean; maskedColumns?: string[] } | null>(null);
  const finalSqlRef = useRef('');
  const finalTokensRef = useRef('');
  const finalAnalysisRef = useRef('');
  const finalErrorRef = useRef('');
  const finalStatusRef = useRef('');
  const finalChartTypeRef = useRef<string | undefined>(undefined);

  const parseChartTypeFromTokens = useCallback((tokens: string): string | undefined => {
    const match = tokens.match(/"chartType"\s*:\s*"([^"]+)"/);
    if (match && VALID_CHART_TYPES.includes(match[1])) return match[1];
    return undefined;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentAnalysis, currentSql, currentResult, phase]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setPhase('idle');
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    finalResultRef.current = null;
    finalSqlRef.current = '';
    finalTokensRef.current = '';
    finalAnalysisRef.current = '';
    finalErrorRef.current = '';
    finalStatusRef.current = '';
    finalChartTypeRef.current = undefined;

    const userMsg: StreamMessage = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setCurrentSql('');
    setCurrentTokens('');
    setCurrentAnalysis('');
    setCurrentResult(null);
    setError('');
    setStatusMsg('');
    setPhase('status');
    setStreaming(true);

    const params = new URLSearchParams({
      message: text,
      ...(connectionId ? { connectionId: String(connectionId) } : {}),
      ...(apiKeyId ? { apiKeyId: String(apiKeyId) } : {}),
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId: String(sessionId) } : {}),
      aiProvider,
    });

    const controller = new AbortController();
    abortRef.current = controller;
    let retries = retryCount;

    const doFetch = async (): Promise<void> => {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${API_BASE}/api/chat/stream?${params}`, {
        credentials: 'include',
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let eventType = '';
      let dataBuffer = '';

      const processEvent = () => {
        if (!eventType || !dataBuffer.trim()) return;
        const raw = dataBuffer.trim();
        if (raw === '[DONE]') return;
        try {
          const chunk = JSON.parse(raw);
          switch (eventType) {
            case 'status':
              setPhase('status');
              setStatusMsg(chunk.message ?? '');
              finalStatusRef.current = chunk.message ?? '';
              break;
            case 'thinking':
              setPhase('thinking');
              setStatusMsg(chunk.message ?? '');
              finalStatusRef.current = chunk.message ?? '';
              break;
            case 'token':
              setPhase('thinking');
              finalTokensRef.current += chunk.text ?? '';
              setCurrentTokens(finalTokensRef.current);
              if (!finalChartTypeRef.current) {
                const parsedChartType = parseChartTypeFromTokens(finalTokensRef.current);
                if (parsedChartType) finalChartTypeRef.current = parsedChartType;
              }
              break;
            case 'sql':
              setPhase('sql');
              setCurrentSql(chunk.sql ?? '');
              finalSqlRef.current = chunk.sql ?? '';
              break;
            case 'result':
              setPhase('result');
              const result = {
                columns: chunk.columns ?? [],
                rows: chunk.rows ?? [],
                rowCount: chunk.rowCount ?? 0,
                duration_ms: chunk.duration_ms ?? 0,
                truncated: chunk.truncated ?? false,
                totalRows: chunk.totalRows ?? chunk.rowCount ?? 0,
                fromCache: chunk.fromCache ?? false,
                maskedColumns: chunk.maskedColumns ?? [],
              };
              setCurrentResult(result);
              finalResultRef.current = result;
              break;
            case 'analysis':
              setPhase('analysis');
              setCurrentAnalysis(prev => prev + (chunk.text ?? ''));
              finalAnalysisRef.current += chunk.text ?? '';
              break;
            case 'done':
              setPhase('done');
              break;
            case 'error':
              setError(chunk.error ?? 'Unknown error');
              finalErrorRef.current = chunk.error ?? 'Unknown error';
              break;
            case 'session':
              if (chunk.sessionId && onSessionId) {
                onSessionId(chunk.sessionId);
              }
              break;
          }
        } catch { /* skip malformed */ }
        dataBuffer = '';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processEvent();
          break;
        }
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            processEvent();
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataBuffer += line.slice(6) + '\n';
          } else if (line === '') {
            processEvent();
          }
        }
      }
    };

    try {
      await doFetch();
      setRetryCount(0);
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        setError('[stopped]');
        finalErrorRef.current = '[stopped]';
      } else if (retries < MAX_RETRIES) {
        retries++;
        setRetryCount(retries);
        setError(`Retrying... (${retries}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 1000 * retries));
        await doFetch();
      } else {
        const msg = err instanceof Error ? err.message : 'Stream failed';
        setError(msg);
        finalErrorRef.current = msg;
      }
    } finally {
      setStreaming(false);

      const finalContent =
        finalAnalysisRef.current ||
        finalTokensRef.current ||
        finalStatusRef.current ||
        (finalResultRef.current ? `Query returned ${(finalResultRef.current as { rowCount: number; duration_ms: number }).rowCount} row(s) in ${(finalResultRef.current as { rowCount: number; duration_ms: number }).duration_ms}ms` : '');

      const assistantMsg: StreamMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: finalContent,
        sql: finalSqlRef.current || undefined,
        chartType: finalChartTypeRef.current,
        columns: (finalResultRef.current as { columns: string[] } | null)?.columns,
        tableData: (finalResultRef.current as { rows: Record<string, unknown>[] } | null)?.rows,
        duration_ms: (finalResultRef.current as { duration_ms: number } | null)?.duration_ms,
        rowCount: (finalResultRef.current as { rowCount: number } | null)?.rowCount,
        error: finalErrorRef.current || undefined,
        truncated: (finalResultRef.current as { truncated?: boolean } | null)?.truncated,
        totalRows: (finalResultRef.current as { totalRows?: number } | null)?.totalRows,
        fromCache: (finalResultRef.current as { fromCache?: boolean } | null)?.fromCache,
        maskedColumns: (finalResultRef.current as { maskedColumns?: string[] } | null)?.maskedColumns,
      };
      setMessages(prev => [...prev, assistantMsg]);
      setPhase('idle');
    }
  }, [streaming, connectionId, aiProvider, apiKeyId, model, sessionId, onSessionId, retryCount, parseChartTypeFromTokens]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#30363d] bg-[#0d1117]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="text-sm text-[#8b949e] hover:text-[#e6edf3]">
              ← Back
            </button>
          )}
          <span className="text-sm font-medium text-[#58a6ff]">{t('streaming')}</span>
          {streaming && (
            <span className="text-xs text-[#8b949e] capitalize">· {phase}</span>
          )}
        </div>
        {streaming && (
          <button onClick={stopStream} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[#f85149] text-[#f85149] rounded-lg hover:bg-[#f85149]/10 transition-colors">
            <Square size={12} /> {t('stop')}
          </button>
        )}
      </div>

      {/* Streaming info banner */}
      <div className="flex items-start gap-2.5 px-6 py-3 bg-[#1c3a5e]/30 border-b border-[#30363d]">
        <Info size={14} className="text-[#58a6ff] mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-xs text-[#e6edf3]">{t('streamingModeInfo')}</p>
          <p className="text-xs text-[#8b949e] mt-0.5">{t('streamingModeNote')}</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} connectionId={connectionId} />
        ))}

        {/* Live streaming preview */}
        {streaming && phase !== 'idle' && phase !== 'done' && (
          <div className="flex gap-3">
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl px-4 py-3 text-sm text-[#e6edf3] max-w-[75%]">
              {(phase === 'status' || phase === 'thinking' || phase === 'token') && (
                <div className="flex flex-col gap-2">
                  {statusMsg && (
                    <div className="flex items-center gap-2 text-[#8b949e]">
                      <span className="animate-pulse">●</span>
                      <span>{statusMsg}</span>
                    </div>
                  )}
                  {currentTokens && (
                    <div className="text-xs font-mono text-[#58a6ff] whitespace-pre-wrap bg-[#0d1117] px-3 py-2 rounded border border-[#30363d] max-h-20 overflow-y-auto">
                      {currentTokens}<span className="animate-pulse">▌</span>
                    </div>
                  )}
                </div>
              )}

              {phase === 'sql' && currentSql && (
                <code className="block text-xs font-mono text-[#58a6ff] bg-[#0d1117] px-2 py-1 rounded">
                  {currentSql}
                </code>
              )}

              {phase === 'result' && currentResult && (
                <div>
                  <p className="text-xs text-[#3fb950] mb-1">
                    ✓ {currentResult.rowCount} row(s) in {currentResult.duration_ms}ms
                    {currentResult.truncated && (
                      <span className="ml-2 text-[#d29922]">
                        (truncated from {currentResult.totalRows} total)
                      </span>
                    )}
                    {currentResult.fromCache && (
                      <span className="ml-2 text-[#a371f7]">· from cache ⚡</span>
                    )}
                    {currentResult.maskedColumns && currentResult.maskedColumns.length > 0 && (
                      <span className="ml-2 text-[#f85149]">· 🔒 masked: {currentResult.maskedColumns.join(', ')}</span>
                    )}
                  </p>
                  <div className="overflow-x-auto max-h-40">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#21262d]">
                          {currentResult.columns.map(col => (
                            <th key={col} className="px-3 py-1.5 text-left font-medium text-[#8b949e]">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {currentResult.rows.slice(0, 5).map((row, i) => (
                          <tr key={i} className="border-t border-[#30363d] bg-[#0d1117]">
                            {currentResult.columns.map(col => (
                              <td key={col} className="px-3 py-1.5 text-[#e6edf3]">{String(row[col] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {phase === 'analysis' && (
                <p className="whitespace-pre-wrap">
                  {currentAnalysis}<span className="animate-pulse text-[#58a6ff]">▌</span>
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-[#d29922] px-2">{error}</p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-[#30363d] bg-[#161b22]">
        <form onSubmit={e => { e.preventDefault(); sendMessage(input); }} className="flex gap-3">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask in streaming mode..."
            disabled={streaming}
            className="flex-1 bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-xl px-4 py-3 text-sm focus:border-[#58a6ff] focus:outline-none disabled:opacity-50"
          />
          <button type="submit" disabled={streaming || !input.trim()} className="gradient-btn px-5 py-3 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <Send size={16} /> Send
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function MessageBubble({ msg, connectionId }: { msg: StreamMessage; connectionId?: number }) {
  const [sqlExpanded, setSqlExpanded] = useState(false);
  const [tablePage, setTablePage] = useState(0);
  const [tableExpanded, setTableExpanded] = useState(false);
  const [tableFullscreen, setTableFullscreen] = useState(false);
  const [explainPlan, setExplainPlan] = useState<{ sql?: string; plan?: string } | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const TABLE_PAGE_SIZE = 20;
  const showSqlToggle = process.env.NEXT_PUBLIC_SHOW_SQL_TOGGLE !== 'false';

  // Reset to page 0 when message changes (new result)
  useEffect(() => { setSqlExpanded(false); setTablePage(0); setTableExpanded(false); setTableFullscreen(false); setExplainPlan(null); }, [msg.id]);

  const totalRows = msg.rowCount ?? msg.tableData?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / TABLE_PAGE_SIZE));
  const clampedPage = Math.min(tablePage, totalPages - 1);
  const displayRows = tableExpanded ? (msg.tableData ?? []) : (msg.tableData?.slice(clampedPage * TABLE_PAGE_SIZE, (clampedPage + 1) * TABLE_PAGE_SIZE) ?? []);

  return (
    <div className={cn('flex gap-3', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
      <div className={cn('max-w-[75%] rounded-2xl px-4 py-3 text-sm', msg.role === 'user' ? 'bg-[#1c3a5e]' : 'bg-[#161b22] border border-[#30363d]')}>
        <p className="whitespace-pre-wrap">{msg.content}</p>

        {msg.sql && showSqlToggle && (
          <div className="mt-2 rounded-lg border border-[#30363d] overflow-hidden">
            {/* Header bar */}
            <div className="flex items-center justify-between bg-[#1c2128] px-3 py-1.5 border-b border-[#30363d]">
              <span className="text-xs font-medium text-[#8b949e]">SQL</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSqlExpanded(v => !v)}
                  className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#58a6ff] transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cn('transition-transform', sqlExpanded ? 'rotate-90' : '')}>
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                  {sqlExpanded ? '▲ Ẩn SQL' : '▼ Xem SQL'}
                </button>
                {msg.sql && (
                  <button
                    onClick={async () => {
                      if (explainPlan?.sql === msg.sql) { setExplainPlan(null); return; }
                      if (!connectionId) return;
                      setExplainLoading(true);
                      try {
                        const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
                        const res = await fetch(`${API_BASE}/api/chat/explain-plan`, {
                          method: 'POST',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ sql: msg.sql, connectionId }),
                        });
                        const data = await res.json();
                        setExplainPlan({ sql: msg.sql, plan: data.plan ?? data.error });
                      } catch { setExplainPlan({ sql: msg.sql, plan: 'Failed to load plan' }); }
                      finally { setExplainLoading(false); }
                    }}
                    className="text-xs text-[#8b949e] hover:text-[#a371f7] transition-colors"
                  >
                    {explainLoading ? '⏳...' : '📊 Explain'}
                  </button>
                )}
              </div>
            </div>
            {/* Code body — hidden by default */}
            <div className={cn('bg-[#0d1117] overflow-x-auto', !sqlExpanded ? 'hidden' : '')}>
              <pre className="text-xs font-mono text-[#58a6ff] px-3 py-2 whitespace-pre-wrap break-all">
                {msg.sql}
              </pre>
            </div>
          </div>
        )}

        {msg.tableData && msg.columns && (
          <div className="mt-3 space-y-2">
            {msg.chartType && (
              <StreamingChart chartType={msg.chartType} columns={msg.columns} rows={msg.tableData} />
            )}
            {msg.truncated && (
              <div className="text-xs text-[#d29922] bg-[#d29922]/10 px-3 py-2 rounded border border-[#d29922]/30">
                ⚠️ Kết quả bị cắt ngắn. {msg.totalRows ?? msg.rowCount} dòng tổng cộng.
                Thử thêm bộ lọc để thu hẹp kết quả.
              </div>
            )}
            {msg.maskedColumns && msg.maskedColumns.length > 0 && (
              <div className="text-xs text-[#f85149] bg-[#f85149]/10 px-3 py-2 rounded border border-[#f85149]/30">
                🔒 Đã ẩn {msg.maskedColumns.length} cột nhạy cảm: {msg.maskedColumns.join(', ')}
              </div>
            )}

            {explainPlan?.sql === msg.sql && (
              <div className="mt-2 rounded-lg border border-[#a371f7]/30 bg-[#a371f7]/5 overflow-hidden">
                <div className="flex items-center justify-between bg-[#1c2128] px-3 py-1.5 border-b border-[#a371f7]/30">
                  <span className="text-xs font-medium text-[#a371f7]">📊 Explain Plan</span>
                  <button onClick={() => setExplainPlan(null)} className="text-xs text-[#8b949e] hover:text-[#e6edf3]">✕ Đóng</button>
                </div>
                <pre className="text-xs font-mono text-[#a371f7] px-3 py-2 whitespace-pre-wrap overflow-x-auto max-h-48">
                  {explainPlan?.plan ?? '...'}
                </pre>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#21262d]">
                    {msg.columns.map(col => (
                      <th key={col} className="px-3 py-2 text-left font-medium text-[#8b949e] whitespace-nowrap">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => (
                    <tr key={i} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#161b22]' : 'bg-[#0d1117]')}>
                      {msg.columns!.map(col => (
                        <td key={col} className="px-3 py-2 text-[#e6edf3] whitespace-nowrap">{String(row[col] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between px-3 py-1.5 bg-[#21262d]">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[#8b949e]">
                    {totalRows} row(s) · {msg.duration_ms}ms
                    {tableExpanded ? ' · Tất cả' : totalPages > 1 ? ` · Trang ${clampedPage + 1}/${totalPages}` : ''}
                  </span>
                  {!tableExpanded && totalPages > 1 && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => setTablePage(p => Math.max(0, p - 1))}
                        disabled={clampedPage === 0}
                        className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >‹ Prev</button>
                      <button
                        onClick={() => setTablePage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={clampedPage >= totalPages - 1}
                        className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >Next ›</button>
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  {totalPages > 1 && (
                    <button
                      onClick={() => setTableExpanded(v => !v)}
                      className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#58a6ff] hover:border-[#58a6ff] transition-colors"
                    >
                      {tableExpanded ? '‹ Thu gọn' : 'Xem đầy đủ ›'}
                    </button>
                  )}
                  {totalRows > 0 && (
                    <button
                      onClick={() => setTableFullscreen(true)}
                      className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#a371f7] hover:border-[#a371f7] transition-colors"
                    >⛶ Fullscreen</button>
                  )}
                  <button
                    onClick={() => exportToCSV(msg.columns ?? [], msg.tableData ?? [])}
                    className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#3fb950] hover:border-[#3fb950] transition-colors"
                  >CSV</button>
                  <button
                    onClick={() => exportToJSON(msg.tableData ?? [])}
                    className="px-2 py-0.5 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#3fb950] hover:border-[#3fb950] transition-colors"
                  >JSON</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {msg.error && (
          <p className="mt-2 text-xs text-[#f85149] bg-[#f85149]/10 px-2 py-1 rounded inline-block">{msg.error}</p>
        )}

        {/* Fullscreen table view */}
        {tableFullscreen && msg.tableData && msg.columns && (
          <div
            className="fixed inset-0 z-50 flex flex-col bg-[#0d1117]/95 backdrop-blur-sm"
            onKeyDown={e => e.key === 'Escape' && setTableFullscreen(false)}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-[#161b22] border-b border-[#30363d]">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-[#e6edf3]">Data Explorer</span>
                <span className="text-xs text-[#8b949e]">{totalRows} rows · {msg.columns.length} columns</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => exportToCSV(msg.columns ?? [], msg.tableData ?? [])} className="px-3 py-1 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#3fb950] hover:border-[#3fb950] transition-colors">Export CSV</button>
                <button onClick={() => exportToJSON(msg.tableData ?? [])} className="px-3 py-1 text-xs rounded border border-[#30363d] text-[#8b949e] hover:text-[#3fb950] hover:border-[#3fb950] transition-colors">Export JSON</button>
                <button onClick={() => setTableFullscreen(false)} className="p-1 rounded hover:bg-[#30363d] transition-colors"><X size={16} className="text-[#8b949e]" /></button>
              </div>
            </div>
            {/* Table */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#21262d] sticky top-0 z-10">
                  <tr>
                    <td className="px-3 py-2 text-[#8b949e] border-b border-[#30363d] sticky left-0 bg-[#21262d]">#</td>
                    {msg.columns.map(col => (
                      <th key={col} className="px-3 py-2 text-left text-[#8b949e] font-medium whitespace-nowrap border-b border-[#30363d]">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {msg.tableData.map((row, i) => (
                    <tr key={i} className={cn('border-b border-[#21262d]', i % 2 === 0 ? 'bg-[#0d1117]' : 'bg-[#161b22]')}>
                      <td className="px-3 py-1.5 text-[#58a6ff] whitespace-nowrap sticky left-0 bg-[inherit]">{i + 1}</td>
                      {msg.columns!.map(col => (
                        <td key={col} className="px-3 py-1.5 text-[#e6edf3] whitespace-nowrap">{String(row[col] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Footer */}
            <div className="px-4 py-2 bg-[#161b22] border-t border-[#30363d]">
              <p className="text-xs text-[#8b949e]">Esc để đóng · {totalRows} rows · {msg.duration_ms}ms</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StreamingChart({ chartType, columns, rows }: { chartType: string; columns: string[]; rows: Record<string, unknown>[] }) {
  const data = rows.slice(0, 100);
  const xKey = columns[0];
  const yKey = columns[1];
  const chartData = data.map(row => ({ [xKey]: String(row[xKey]), [yKey]: Number(row[yKey]) || 0 }));
  const commonProps = { data: chartData, margin: { top: 5, right: 5, left: -10, bottom: 5 } };
  const tooltipStyle = { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 };

  if (chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={250}>
        <LineChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} />
          <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Line type="monotone" dataKey={yKey} stroke="#58a6ff" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'pie') {
    const pieData = data.slice(0, 8).map(row => ({
      name: String(row[xKey]),
      value: Number(row[yKey]) || 0,
    }));
    return (
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={90}
            label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
            labelLine={false}
          >
            {pieData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} />
          <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Area type="monotone" dataKey={yKey} stroke="#58a6ff" fill="#58a6ff33" />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // Default: bar
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart {...commonProps}>
        <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
        <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} />
        <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey={yKey} fill="#58a6ff" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
