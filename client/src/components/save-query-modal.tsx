'use client';

import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';

interface SaveQueryModalProps {
  queryId?: number;      // if set → edit mode
  sql?: string;
  connectionId?: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function SaveQueryModal({ queryId, sql: initialSql, connectionId: initialConnId, onClose, onSaved }: SaveQueryModalProps) {
  const t = useTranslations('savedQueries');
  const tCommon = useTranslations('common');
  const isEdit = Boolean(queryId);

  const [sql, setSql] = useState(initialSql ?? '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [connectionId, setConnectionId] = useState<number | undefined>(initialConnId);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // In edit mode, fetch full query data first
  useEffect(() => {
    if (!queryId) return;
    apiClient.get<{ savedQuery: { name: string; sql: string; description?: string; connection_id?: number } }>(
      `/saved-queries/${queryId}`
    ).then(({ data }) => {
      setName(data.savedQuery.name);
      setSql(data.savedQuery.sql);
      setDescription(data.savedQuery.description ?? '');
      setConnectionId(data.savedQuery.connection_id);
    }).catch(() => {
      setError(tCommon('error'));
    }).finally(() => {
      setLoading(false);
    });
  }, [queryId, tCommon]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!sql.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await apiClient.put(`/saved-queries/${queryId}`, {
          name: name.trim(),
          sql: sql.trim(),
          description: description.trim() || undefined,
          connectionId,
        });
      } else {
        await apiClient.post('/saved-queries', {
          name: name.trim(),
          sql: sql.trim(),
          description: description.trim() || undefined,
          connectionId,
        });
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
      <div className="w-full max-w-md glass-card p-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3]">
            {isEdit ? t('edit') : t('name')}
          </h2>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 size={20} className="animate-spin text-[#8b949e]" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* SQL */}
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('sql')} <span className="text-[#f85149]">*</span></label>
              <textarea
                value={sql}
                onChange={e => setSql(e.target.value)}
                rows={4}
                className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-xs font-mono focus:border-[#58a6ff] focus:outline-none resize-none"
              />
            </div>

            {/* Name */}
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('name')} <span className="text-[#f85149]">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                required
                autoFocus
                className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('description')}</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('descriptionPlaceholder')}
                className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
              />
            </div>

            {error && <p className="text-xs text-[#f85149]">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                {tCommon('cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !name.trim() || !sql.trim()}
                className="gradient-btn px-5 py-2 text-sm disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin inline" /> : null}
                {saving ? tCommon('loading') : tCommon('save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
