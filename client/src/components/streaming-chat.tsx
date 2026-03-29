'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AIProvider } from '@/hooks/use-ai-provider';

const MAX_RETRIES = 3;

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
  columns?: string[];
  tableData?: Record<string, unknown>[];
  duration_ms?: number;
  rowCount?: number;
  error?: string;
}

type StreamPhase = 'idle' | 'status' | 'thinking' | 'sql' | 'result' | 'analysis' | 'done';

export default function StreamingChat({ connectionId, aiProvider, apiKeyId, model, sessionId, onBack, onSessionId }: StreamingChatProps) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [currentSql, setCurrentSql] = useState('');
  const [currentTokens, setCurrentTokens] = useState(''); // accumulates AI response in real-time
  const [currentAnalysis, setCurrentAnalysis] = useState('');
  const [currentResult, setCurrentResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; duration_ms: number } | null>(null);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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

      // EventSource-like parser: accumulate lines until blank line
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
              break;
            case 'thinking':
              setPhase('thinking');
              setStatusMsg(chunk.message ?? '');
              break;
            case 'token':
              setPhase('thinking');
              // Real-time token display: accumulate AI response as it streams
              setCurrentTokens(prev => prev + (chunk.text ?? ''));
              break;
            case 'sql':
              setPhase('sql');
              setCurrentSql(chunk.sql ?? '');
              break;
            case 'result':
              setPhase('result');
              setCurrentResult({
                columns: chunk.columns ?? [],
                rows: chunk.rows ?? [],
                rowCount: chunk.rowCount ?? 0,
                duration_ms: chunk.duration_ms ?? 0,
              });
              break;
            case 'analysis':
              setPhase('analysis');
              // Each event sends one character for typewriter effect
              setCurrentAnalysis(prev => prev + (chunk.text ?? ''));
              break;
            case 'done':
              setPhase('done');
              break;
            case 'error':
              setError(chunk.error ?? 'Unknown error');
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
            // New event started — flush previous
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
      } else if (retries < MAX_RETRIES) {
        retries++;
        setRetryCount(retries);
        setError(`Retrying... (${retries}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 1000 * retries));
        await doFetch();
      } else {
        setError(err instanceof Error ? err.message : 'Stream failed');
      }
    } finally {
      setStreaming(false);

      // Commit the assistant message
      if (phase !== 'idle') {
        const assistantMsg: StreamMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: currentAnalysis || currentTokens || statusMsg || (currentResult ? `[Query returned ${currentResult.rowCount} row(s) in ${currentResult.duration_ms}ms]` : ''),
          sql: currentSql || undefined,
          columns: currentResult?.columns,
          tableData: currentResult?.rows,
          duration_ms: currentResult?.duration_ms,
          rowCount: currentResult?.rowCount,
          error: error || undefined,
        };
        setMessages(prev => [...prev.filter(m => m.role !== 'assistant' || m.content !== currentAnalysis), assistantMsg]);
      }

      setPhase('idle');
    }
  }, [streaming, connectionId, aiProvider, apiKeyId, model, sessionId, onSessionId, retryCount, currentTokens, currentAnalysis, currentSql, currentResult, phase, statusMsg, error]);

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
          <span className="text-sm font-medium text-[#58a6ff]">Streaming Mode</span>
          {streaming && (
            <span className="text-xs text-[#8b949e] capitalize">· {phase}</span>
          )}
        </div>
        {streaming && (
          <button onClick={stopStream} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[#f85149] text-[#f85149] rounded-lg hover:bg-[#f85149]/10 transition-colors">
            <Square size={12} /> Stop
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {messages.map(msg => (
          <div key={msg.id} className={cn('flex gap-3', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
            <div className={cn('max-w-[75%] rounded-2xl px-4 py-3 text-sm', msg.role === 'user' ? 'bg-[#1c3a5e]' : 'bg-[#161b22] border border-[#30363d]')}>
              <p className="whitespace-pre-wrap">{msg.content}</p>

              {msg.sql && (
                <code className="block mt-2 text-xs font-mono text-[#58a6ff] bg-[#0d1117] px-2 py-1 rounded">
                  {msg.sql}
                </code>
              )}

              {msg.tableData && msg.columns && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[#21262d]">
                        {msg.columns.map(col => (
                          <th key={col} className="px-3 py-2 text-left font-medium text-[#8b949e] whitespace-nowrap">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {msg.tableData.slice(0, 20).map((row, i) => (
                        <tr key={i} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#161b22]' : 'bg-[#0d1117]')}>
                          {msg.columns!.map(col => (
                            <td key={col} className="px-3 py-2 text-[#e6edf3] whitespace-nowrap">{String(row[col] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {msg.rowCount !== undefined && (
                    <p className="text-xs text-[#8b949e] px-3 py-2 bg-[#21262d]">
                      {msg.rowCount} row(s) · {msg.duration_ms}ms
                    </p>
                  )}
                </div>
              )}

              {msg.error && (
                <p className="mt-2 text-xs text-[#f85149] bg-[#f85149]/10 px-2 py-1 rounded inline-block">{msg.error}</p>
              )}
            </div>
          </div>
        ))}

        {/* Live streaming preview */}
        {streaming && phase !== 'idle' && phase !== 'done' && (
          <div className="flex gap-3">
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl px-4 py-3 text-sm text-[#e6edf3] max-w-[75%]">
              {phase === 'status' || phase === 'thinking' ? (
                <div className="flex flex-col gap-2">
                  {statusMsg && (
                    <div className="flex items-center gap-2 text-[#8b949e]">
                      <span className="animate-pulse">●</span>
                      <span>{statusMsg}</span>
                    </div>
                  )}
                  {/* Real-time AI token display during generation */}
                  {currentTokens && (
                    <div className="text-xs font-mono text-[#58a6ff] whitespace-pre-wrap bg-[#0d1117] px-3 py-2 rounded border border-[#30363d] max-h-20 overflow-y-auto">
                      {currentTokens}<span className="animate-pulse">▌</span>
                    </div>
                  )}
                </div>
              ) : null}

              {phase === 'sql' && currentSql && (
                <code className="block text-xs font-mono text-[#58a6ff] bg-[#0d1117] px-2 py-1 rounded">
                  {currentSql}
                </code>
              )}

              {phase === 'result' && currentResult && (
                <div>
                  <p className="text-xs text-[#3fb950] mb-1">
                    ✓ {currentResult.rowCount} row(s) in {currentResult.duration_ms}ms
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
