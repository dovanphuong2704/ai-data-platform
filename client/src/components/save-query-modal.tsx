'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SaveQueryModalProps {
  sql: string;
  connectionId?: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function SaveQueryModal({ sql, connectionId, onClose, onSaved }: SaveQueryModalProps) {
  const t = useTranslations('savedQueries');
  const tCommon = useTranslations('common');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/saved-queries', {
        name: name.trim(),
        sql,
        description: description.trim() || undefined,
        connectionId,
      });
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
          <h2 className="text-sm font-semibold text-[#e6edf3]">{t('name')}</h2>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* SQL preview */}
        <code className="block text-xs font-mono text-[#8b949e] bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 mb-4 whitespace-pre-wrap break-all">
          {sql.length > 200 ? sql.slice(0, 200) + '...' : sql}
        </code>

        <form onSubmit={handleSubmit} className="space-y-3">
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
              disabled={saving || !name.trim()}
              className="gradient-btn px-5 py-2 text-sm disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin inline" /> : null}
              {saving ? tCommon('loading') : tCommon('save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
