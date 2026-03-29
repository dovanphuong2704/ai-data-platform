'use client';

import { useState, useEffect, useCallback } from 'react';
import { Clock, Plus, Loader2, Trash2, Edit2, Play, Search } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import type { ScheduledQuery, DbConnection } from '@/types';
import ScheduleForm from '@/components/schedule-form';
import { useTranslations } from 'next-intl';

export default function ScheduledQueriesPage() {
  const t = useTranslations('scheduledQueries');
  const tc = useTranslations('common');
  const [schedules, setSchedules] = useState<ScheduledQuery[]>([]);
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledQuery | undefined>();

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    try {
      const [schedRes, connRes] = await Promise.all([
        apiClient.get<{ scheduledQueries: ScheduledQuery[] }>('/scheduled-queries'),
        apiClient.get<{ connections: DbConnection[] }>('/connections'),
      ]);
      setSchedules(Array.isArray(schedRes.data.scheduledQueries) ? schedRes.data.scheduledQueries : []);
      setConnections(Array.isArray(connRes.data.connections) ? connRes.data.connections : []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  const handleDelete = async (id: number) => {
    if (!confirm(tc('confirm'))) return;
    try {
      await apiClient.delete(`/scheduled-queries/${id}`);
      setSchedules(prev => prev.filter(s => s.id !== id));
    } catch { alert(tc('error')); }
  };

  const handleToggle = async (id: number, active: boolean) => {
    try {
      await apiClient.put(`/scheduled-queries/${id}`, { is_active: active });
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, is_active: active } : s));
    } catch { alert(tc('error')); }
  };

  const filtered = schedules.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.sql ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Clock size={20} className="text-[#58a6ff]" />
          <h1 className="text-lg font-semibold text-[#e6edf3]">{t('title')}</h1>
          <span className="text-xs text-[#8b949e]">{filtered.length}</span>
        </div>
        <button onClick={() => { setEditingSchedule(undefined); setShowForm(true); }}
          className="flex items-center gap-2 gradient-btn px-4 py-2 text-sm">
          <Plus size={14} /> {t('createSchedule')}
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b949e]" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg pl-9 pr-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-[#8b949e]">
          <Loader2 size={16} className="animate-spin inline" /> {tc('loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-[#8b949e]">
          <Clock size={40} className="text-[#30363d] mx-auto mb-3" />
          <p className="text-sm">{search ? t('empty') : t('empty')}</p>
          {!search && <p className="text-xs mt-1">{t('empty')}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(s => (
            <div key={s.id} className="glass-card p-4 animate-fade-in">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="text-sm font-medium text-[#e6edf3] truncate">{s.name}</h3>
                    <span className={cn(
                      'text-xs px-2 py-0.5 rounded-full',
                      s.is_active ? 'bg-[#3fb950]/15 text-[#3fb950]' : 'bg-[#21262d] text-[#8b949e]'
                    )}>
                      {s.is_active ? t('status.active') : t('status.paused')}
                    </span>
                    <code className="text-xs font-mono text-[#8b949e] bg-[#0d1117] px-2 py-0.5 rounded">{s.schedule_cron}</code>
                  </div>

                  {/* SQL */}
                  <code className="block text-xs font-mono text-[#8b949e] bg-[#0d1117] rounded px-2 py-1.5 truncate mb-2">
                    {s.sql ?? '—'}
                  </code>

                  {/* Meta */}
                  <div className="flex items-center gap-3 text-xs text-[#8b949e]">
                    {s.last_run_at && <span>{t('lastRun')}: {formatDate(s.last_run_at)}</span>}
                    {s.last_run_status && (
                      <span className={cn(
                        s.last_run_status === 'success' ? 'text-[#3fb950]' : 'text-[#f85149]'
                      )}>
                        {s.last_run_status === 'success' ? t('result.success') : t('result.error')}
                      </span>
                    )}
                    <span>{t('never')}: {formatDate(s.created_at)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => handleToggle(s.id, !s.is_active)}
                    title={s.is_active ? t('status.paused') : t('status.active')}
                    className={cn('p-1.5 transition-colors', s.is_active ? 'text-[#3fb950] hover:text-[#2ea043]' : 'text-[#8b949e] hover:text-[#e6edf3]')}>
                    <Play size={14} />
                  </button>
                  <button onClick={() => { setEditingSchedule(s); setShowForm(true); }}
                    className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors">
                    <Edit2 size={14} />
                  </button>
                  <button onClick={() => handleDelete(s.id)}
                    className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <ScheduleForm
          schedule={editingSchedule}
          connections={connections}
          onClose={() => setShowForm(false)}
          onSaved={loadSchedules}
        />
      )}
    </div>
  );
}
