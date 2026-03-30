'use client';

import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Plus, Trash2, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

interface ChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatSessionsPanelProps {
  currentSessionId: number | null;
  onSelectSession: (sessionId: number) => void;
  onNewChat: () => void;
}

function formatRelativeDate(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return t('today');
  if (diffDays === 1) return t('yesterday');
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export default function ChatSessionsPanel({ currentSessionId, onSelectSession, onNewChat }: ChatSessionsPanelProps) {
  const t = useTranslations('chatSessions');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get<{ sessions: ChatSession[] }>('/chat-sessions');
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const deleteSession = useCallback(async (sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiClient.delete(`/chat-sessions/${sessionId}`);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (currentSessionId === sessionId) onNewChat();
    } catch {
      // silent
    }
  }, [currentSessionId, onNewChat]);

  return (
    <div className="w-60 flex-shrink-0 border-r border-[#30363d] bg-[#0d1117] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#30363d]">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[#58a6ff] hover:bg-[#4493e6] text-white text-xs font-semibold transition-colors"
        >
          <Plus size={14} />
          {t('newChat')}
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading && sessions.length === 0 ? (
          <div className="flex justify-center py-4">
            <Loader2 size={16} className="animate-spin text-[#8b949e]" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <MessageSquare size={24} className="mx-auto text-[#30363d] mb-2" />
            <p className="text-xs text-[#8b949e]">{t('empty')}</p>
          </div>
        ) : (
          <div className="space-y-0.5 px-2">
            {sessions.map(session => (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session.id)}
                onKeyDown={(e) => e.key === 'Enter' && onSelectSession(session.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors group',
                  currentSessionId === session.id
                    ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                    : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]'
                )}
              >
                <MessageSquare size={14} className="flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{session.title}</p>
                  <p className="text-[10px] opacity-60 mt-0.5">
                    {formatRelativeDate(session.updated_at, t)}
                  </p>
                </div>
                <button
                  onClick={(e) => deleteSession(session.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-[#8b949e] hover:text-[#f85149] transition-all flex-shrink-0 p-1"
                  title={t('delete')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
