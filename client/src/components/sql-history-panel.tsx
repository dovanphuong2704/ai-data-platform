'use client';

import { useEffect } from 'react';
import { Clock, CheckCircle2, XCircle, X, Play, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { SqlHistoryEntry } from '@/types';

interface SqlHistoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  history: SqlHistoryEntry[];
  loading: boolean;
  onFetch: () => void;
  onRerun: (entry: SqlHistoryEntry) => void;
  rerunningId?: number;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function SqlHistoryPanel({
  isOpen,
  onClose,
  history,
  loading,
  onFetch,
  onRerun,
  rerunningId,
}: SqlHistoryPanelProps) {
  const t = useTranslations('chat');
  useEffect(() => {
    if (isOpen) onFetch();
  }, [isOpen, onFetch]);

  if (!isOpen) return null;

  return (
    <div className="w-72 border-l border-[#30363d] bg-[#161b22] flex flex-col animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-[#8b949e]" />
          <span className="text-sm font-medium text-[#e6edf3]">{t('history')}</span>
        </div>
        <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-[#8b949e]" />
          </div>
        ) : history.length === 0 ? (
          <div className="text-center py-12 px-4">
            <Clock size={28} className="text-[#30363d] mx-auto mb-2" />
            <p className="text-xs text-[#8b949e]">{t('noHistory')}</p>
          </div>
        ) : (
          history.map(entry => (
            <div key={entry.id} className="mx-2 mb-2 p-3 rounded-lg bg-[#0d1117] border border-[#30363d] hover:border-[#58a6ff]/30 transition-colors">
              {/* Status + meta */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  {entry.status === 'success' && <CheckCircle2 size={11} className="text-[#3fb950]" />}
                  {entry.status === 'error' && <XCircle size={11} className="text-[#f85149]" />}
                  {entry.status === 'cancelled' && <XCircle size={11} className="text-[#d29922]" />}
                  <span className={cn(
                    'text-xs font-medium',
                    entry.status === 'success' ? 'text-[#3fb950]' :
                    entry.status === 'error' ? 'text-[#f85149]' : 'text-[#d29922]'
                  )}>
                    {t(`status.${entry.status}`)}
                  </span>
                </div>
                <span className="text-xs text-[#8b949e]">{timeAgo(entry.created_at)}</span>
              </div>

              {/* SQL preview */}
              <code className="block text-xs text-[#8b949e] font-mono leading-relaxed mb-2 whitespace-pre-wrap break-all">
                {entry.sql.length > 80 ? entry.sql.slice(0, 80) + '...' : entry.sql}
              </code>

              {/* Stats + action */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#8b949e]">
                  {entry.duration_ms}ms · {entry.rows_returned} rows
                </span>
                <button
                  onClick={() => onRerun(entry)}
                  disabled={rerunningId === entry.id}
                  className="flex items-center gap-1 text-xs text-[#58a6ff] hover:text-[#79c0ff] disabled:opacity-50 transition-colors"
                >
                  {rerunningId === entry.id
                    ? <Loader2 size={10} className="animate-spin" />
                    : <Play size={10} />
                  }
                  {t('rerun')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
