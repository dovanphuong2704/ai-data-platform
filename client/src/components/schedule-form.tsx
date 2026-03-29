'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';
import type { ScheduledQuery, DbConnection } from '@/types';

interface ScheduleFormProps {
  schedule?: ScheduledQuery; // if provided, editing
  connections: DbConnection[];
  onClose: () => void;
  onSaved: () => void;
}

const CRON_HELP = [
  { labelKey: 'everyHour', value: '0 * * * *' },
  { labelKey: 'everyDay', value: '0 0 * * *' },
  { labelKey: 'everyMonday', value: '0 0 * * 1' },
  { labelKey: 'every15min', value: '*/15 * * * *' },
];

export default function ScheduleForm({ schedule, connections, onClose, onSaved }: ScheduleFormProps) {
  const t = useTranslations('scheduledQueries');
  const tCommon = useTranslations('common');
  const [form, setForm] = useState({
    name: schedule?.name ?? '',
    sql: schedule?.sql ?? '',
    schedule_cron: schedule?.schedule_cron ?? '0 0 * * *',
    connection_id: schedule?.connection_id ?? ('' as number | ''),
    is_active: schedule?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!schedule;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.sql.trim() || !form.schedule_cron.trim()) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        sql: form.sql.trim(),
        schedule_cron: form.schedule_cron.trim(),
        connection_id: form.connection_id === '' ? undefined : Number(form.connection_id),
        is_active: form.is_active,
      };
      if (isEdit) {
        await apiClient.put(`/scheduled-queries/${schedule.id}`, payload);
      } else {
        await apiClient.post('/scheduled-queries', payload);
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : tCommon('error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg glass-card p-6 animate-fade-in max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3]">{isEdit ? t('editSchedule') : t('createSchedule')}</h2>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3]"><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('name')} <span className="text-[#f85149]">*</span></label>
            <input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              placeholder={t('namePlaceholder')} required
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('sql')} <span className="text-[#f85149]">*</span></label>
            <textarea value={form.sql} onChange={e => setForm(p => ({ ...p, sql: e.target.value }))}
              placeholder="SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) FROM orders GROUP BY 1 ORDER BY 1"
              required rows={4}
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm font-mono focus:border-[#58a6ff] focus:outline-none resize-y" />
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">
              {t('cronExpression')} <span className="text-[#f85149]">*</span>
            </label>
            <input type="text" value={form.schedule_cron}
              onChange={e => setForm(p => ({ ...p, schedule_cron: e.target.value }))}
              placeholder="0 0 * * *"
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm font-mono focus:border-[#58a6ff] focus:outline-none" />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {CRON_HELP.map(h => (
                <button key={h.value} type="button" onClick={() => setForm(p => ({ ...p, schedule_cron: h.value }))}
                  className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:border-[#58a6ff] hover:text-[#58a6ff] transition-colors">
                  {t(h.labelKey as any)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('connection')}</label>
            <select value={form.connection_id}
              onChange={e => setForm(p => ({ ...p, connection_id: e.target.value === '' ? '' : Number(e.target.value) }))}
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none">
              <option value="">{t('defaultConnection')}</option>
              {connections.map(c => <option key={c.id} value={c.id}>{c.profile_name || `${c.db_host}/${c.db_name}`}</option>)}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-[#8b949e]">
            <input type="checkbox" checked={form.is_active}
              onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))}
              className="accent-[#58a6ff]" />
            {t('enableSchedule')}
          </label>

          {error && <p className="text-xs text-[#f85149]">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3]">{tCommon('cancel')}</button>
            <button type="submit" disabled={saving} className="gradient-btn px-5 py-2 text-sm disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin inline" /> : null}
              {saving ? tCommon('loading') : isEdit ? t('updateSchedule') : t('createSchedule')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
