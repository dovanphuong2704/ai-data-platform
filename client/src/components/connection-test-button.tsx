'use client';

import { useState } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api';
import type { ConnectionTestResult } from '@/types';

interface ConnectionTestButtonProps {
  db_host: string;
  db_port: string;
  db_name: string;
  db_user: string;
  db_password: string;
  className?: string;
}

type TestState = 'idle' | 'testing' | 'success' | 'error';

export default function ConnectionTestButton({
  db_host, db_port, db_name, db_user, db_password,
  className,
}: ConnectionTestButtonProps) {
  const [state, setState] = useState<TestState>('idle');
  const [result, setResult] = useState<ConnectionTestResult | null>(null);

  const test = async () => {
    setState('testing');
    setResult(null);
    try {
      const { data } = await apiClient.post<ConnectionTestResult>('/connections/test', {
        db_host, db_port, db_name, db_user, db_password,
      });
      setResult(data);
      setState(data.success ? 'success' : 'error');
    } catch (err: unknown) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Connection failed' });
      setState('error');
    }
  };

  if (state === 'idle') {
    return (
      <button type="button" onClick={test} className={cn('gradient-btn px-4 py-2 text-sm', className)}>
        Test Connection
      </button>
    );
  }

  if (state === 'testing') {
    return (
      <div className="flex items-center gap-2 text-sm text-[#8b949e]">
        <Loader2 size={14} className="animate-spin" />
        Testing connection...
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex items-center gap-2 text-sm text-[#3fb950]">
        <CheckCircle2 size={14} />
        Connected in {result?.latency_ms}ms
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-[#f85149]">
      <XCircle size={14} />
      {result?.error || 'Connection failed'}
    </div>
  );
}
