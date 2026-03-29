'use client';

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, Cpu, RefreshCw } from 'lucide-react';
import { apiClient } from '@/lib/api';

interface ModelStatusBadgeProps {
  provider: string;
  apiKeyId: number | undefined;
  model: string;
}

type Status = 'idle' | 'checking' | 'ok' | 'error';

interface TestResult {
  success: boolean;
  latency_ms?: number;
  error?: string;
  model?: string;
}

const PROVIDER_SHORT: Record<string, string> = {
  openai: 'GPT',
  grok: 'Grok',
  gemini: 'Gemini',
  claude: 'Claude',
};

export default function ModelStatusBadge({ provider, apiKeyId, model }: ModelStatusBadgeProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (!apiKeyId) { setStatus('idle'); setResult(null); return; }
    setTesting(true);
    setStatus('checking');
    try {
      const { data } = await apiClient.post<TestResult>('/chat/test-model', {
        provider,
        apiKeyId,
        model: model || undefined,
      });
      setResult(data);
      setStatus(data.success ? 'ok' : 'error');
    } catch (err: unknown) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Test failed' });
      setStatus('error');
    } finally {
      setTesting(false);
    }
  };

  // Auto-test when key or model changes
  useEffect(() => {
    if (apiKeyId) {
      runTest();
    } else {
      setStatus('idle');
      setResult(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyId, model]);

  const label = PROVIDER_SHORT[provider] ?? provider;

  if (!apiKeyId) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e]">
        <Cpu size={12} />
        No Key
      </div>
    );
  }

  if (status === 'idle' || testing) {
    return (
      <button
        onClick={runTest}
        disabled={testing}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors disabled:cursor-not-allowed"
        title="Test AI model connection"
      >
        {testing ? <Loader2 size={11} className="animate-spin" /> : <Cpu size={12} />}
        <span>{label}</span>
        <Loader2 size={10} className="animate-spin opacity-50" />
      </button>
    );
  }

  if (status === 'ok') {
    return (
      <button
        onClick={runTest}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#58a6ff]/10 text-xs text-[#58a6ff] hover:text-[#79c0ff] transition-colors"
        title={`Model connected — ${result?.latency_ms}ms`}
      >
        <CheckCircle2 size={12} />
        <span>{label}</span>
        {model && <span className="opacity-60">{model}</span>}
        <RefreshCw size={10} className="opacity-30" />
      </button>
    );
  }

  return (
    <button
      onClick={runTest}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f85149]/10 text-xs text-[#f85149] hover:text-[#ff7b72] transition-colors max-w-[200px]"
      title={`AI error — ${result?.error}`}
    >
      <XCircle size={12} />
      <span>{label}</span>
      <span className="truncate opacity-80">{result?.error}</span>
    </button>
  );
}
