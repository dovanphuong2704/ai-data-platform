'use client';

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, Database, RefreshCw } from 'lucide-react';
import { apiClient } from '@/lib/api';

interface DbStatusBadgeProps {
  connectionId: number | undefined;
  connectionLabel?: string;
}

type Status = 'idle' | 'checking' | 'ok' | 'error';

interface TestResult {
  success: boolean;
  latency_ms?: number;
  error?: string;
}

export default function DbStatusBadge({ connectionId, connectionLabel }: DbStatusBadgeProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (!connectionId) { setStatus('idle'); setResult(null); return; }
    setTesting(true);
    setStatus('checking');
    try {
      const { data } = await apiClient.get<TestResult>(`/connections/${connectionId}/test`);
      setResult(data);
      setStatus(data.success ? 'ok' : 'error');
    } catch (err: unknown) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Connection failed' });
      setStatus('error');
    } finally {
      setTesting(false);
    }
  };

  // Auto-test when connection changes
  useEffect(() => {
    if (connectionId) {
      runTest();
    } else {
      setStatus('idle');
      setResult(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const label = connectionLabel || (connectionId ? `DB #${connectionId}` : 'No DB');

  if (!connectionId) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
        <Database size={12} />
        No DB
      </div>
    );
  }

  if (status === 'idle' || testing) {
    return (
      <button
        onClick={runTest}
        disabled={testing}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors disabled:cursor-not-allowed"
        title="Test database connection"
      >
        {testing ? <Loader2 size={11} className="animate-spin" /> : <Database size={12} />}
        <span className="max-w-[120px] truncate">{label}</span>
        <Loader2 size={10} className="animate-spin opacity-50" />
      </button>
    );
  }

  if (status === 'ok') {
    return (
      <button
        onClick={runTest}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#3fb950]/10 text-xs text-[#3fb950] hover:text-[#56d364] transition-colors"
        title={`Connected — click to retest (${result?.latency_ms}ms)`}
      >
        <CheckCircle2 size={12} />
        <span className="max-w-[120px] truncate">{label}</span>
        <span className="opacity-60">{result?.latency_ms}ms</span>
        <RefreshCw size={10} className="opacity-40" />
      </button>
    );
  }

  return (
    <button
      onClick={runTest}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f85149]/10 text-xs text-[#f85149] hover:text-[#ff7b72] transition-colors"
      title={`Connection failed — ${result?.error}. Click to retry.`}
    >
      <XCircle size={12} />
      <span className="max-w-[120px] truncate">{label}</span>
      <RefreshCw size={10} className="opacity-60" />
    </button>
  );
}
