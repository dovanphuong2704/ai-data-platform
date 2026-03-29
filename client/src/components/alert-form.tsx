'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Alert, DbConnection } from '@/types';

interface AlertFormProps {
  alert?: Alert; // if provided, editing
  connections: DbConnection[];
  onClose: () => void;
  onSaved: () => void;
}

const CONDITIONS = [
  { value: 'gt', labelKey: 'conditions.gt' },
  { value: 'lt', labelKey: 'conditions.lt' },
  { value: 'gte', labelKey: 'conditions.gte' },
  { value: 'lte', labelKey: 'conditions.lte' },
  { value: 'eq', labelKey: 'conditions.eq' },
  { value: 'ne', labelKey: 'conditions.ne' },
];

export default function AlertForm({ alert, connections, onClose, onSaved }: AlertFormProps) {
  const t = useTranslations('alerts');
  const tCommon = useTranslations('common');
  const [form, setForm] = useState({
    name: alert?.name ?? '',
    query_sql: alert?.query_sql ?? '',
    condition: alert?.condition ?? 'gt',
    threshold_value: alert?.threshold_value ?? 0,
    connection_id: alert?.connection_id ?? ('' as number | ''),
    notify_email: alert?.notify_email ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!alert;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.query_sql.trim()) return;
    if (form.query_sql.length > 5000) {
      setError(t('sqlTooLong'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        query_sql: form.query_sql.trim(),
        condition: form.condition,
        threshold_value: Number(form.threshold_value),
        connection_id: form.connection_id === '' ? undefined : Number(form.connection_id),
        notify_email: form.notify_email,
      };
      if (isEdit) {
        await apiClient.put(`/alerts/${alert.id}`, payload);
      } else {
        await apiClient.post('/alerts', payload);
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
          <h2 className="text-sm font-semibold text-[#e6edf3]">{isEdit ? t('editAlert') : t('createAlert')}</h2>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3]">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('name')} <span className="text-[#f85149]">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              placeholder={t('namePlaceholder')}
              required
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('querySql')} <span className="text-[#f85149]">*</span></label>
            <textarea
              value={form.query_sql}
              onChange={e => setForm(p => ({ ...p, query_sql: e.target.value }))}
              placeholder="SELECT COUNT(*) FROM logs WHERE level = 'error'"
              required
              rows={4}
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm font-mono focus:border-[#58a6ff] focus:outline-none resize-y"
            />
            {form.query_sql.length > 5000 && (
              <p className="text-xs text-[#d29922] mt-1">⚠ {t('sqlTooLong')}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('condition')}</label>
              <select
                value={form.condition}
                onChange={e => setForm(p => ({ ...p, condition: e.target.value as Alert['condition'] }))}
                className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
              >
                {CONDITIONS.map(c => <option key={c.value} value={c.value}>{t(c.labelKey as any)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('thresholdValue')}</label>
              <input
                type="number"
                value={form.threshold_value}
                onChange={e => setForm(p => ({ ...p, threshold_value: Number(e.target.value) }))}
                className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">{t('connection')}</label>
            <select
              value={form.connection_id}
              onChange={e => setForm(p => ({ ...p, connection_id: e.target.value === '' ? '' : Number(e.target.value) }))}
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
            >
              <option value="">{t('defaultConnection')}</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>{c.profile_name || `${c.db_host}/${c.db_name}`}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-[#8b949e]">
            <input
              type="checkbox"
              checked={form.notify_email}
              onChange={e => setForm(p => ({ ...p, notify_email: e.target.checked }))}
              className="accent-[#58a6ff]"
            />
            {t('emailNotify')}
          </label>

          {error && <p className="text-xs text-[#f85149]">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3]">{tCommon('cancel')}</button>
            <button type="submit" disabled={saving} className="gradient-btn px-5 py-2 text-sm disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin inline" /> : null}
              {saving ? tCommon('loading') : isEdit ? t('updateAlert') : t('createAlert')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
