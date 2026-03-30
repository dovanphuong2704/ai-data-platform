'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bookmark, Play, Trash2, Loader2, Clock, Search, Edit2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import type { SavedQuery } from '@/types';
import SaveQueryModal from '@/components/save-query-modal';
import ResultModal from '@/components/result-modal';
import { useTranslations } from 'next-intl';

export default function SavedQueriesPage() {
  const t = useTranslations('savedQueries');
  const tc = useTranslations('common');
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [toast, setToast] = useState('');

  // Save/create modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveSql, setSaveSql] = useState('');
  const [saveConnId, setSaveConnId] = useState<number | undefined>();
  const [saveEditId, setSaveEditId] = useState<number | undefined>();

  // Run result modal
  const [runModal, setRunModal] = useState<{ sql: string; connId?: number; name: string } | null>(null);

  const loadQueries = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get<{ savedQueries: SavedQuery[] }>('/saved-queries');
      setQueries(Array.isArray(data.savedQueries) ? data.savedQueries : []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadQueries(); }, [loadQueries]);

  const deleteQuery = async (id: number) => {
    if (!confirm(tc('confirm'))) return;
    try {
      await apiClient.delete(`/saved-queries/${id}`);
      setQueries(prev => prev.filter(q => q.id !== id));
    } catch { alert(tc('error')); }
  };

  const handleSaved = () => {
    loadQueries();
    setShowSaveModal(false);
    setSaveEditId(undefined);
    setSaveSql('');
    showToast(tc('success'));
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const filtered = queries.filter(q =>
    q.name.toLowerCase().includes(search.toLowerCase()) ||
    (q.sql ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Bookmark size={20} className="text-[#58a6ff]" />
        <h1 className="text-lg font-semibold text-[#e6edf3]">{t('title')}</h1>
      </div>

      {/* Search + count */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b949e]" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg pl-9 pr-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
          />
        </div>
        <span className="text-xs text-[#8b949e] whitespace-nowrap">
          {filtered.length} {filtered.length === 1 ? 'query' : 'queries'}
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-sm text-[#8b949e] py-12 text-center">
          <Loader2 size={16} className="animate-spin inline" /> {tc('loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-[#8b949e]">
          <Bookmark size={40} className="text-[#30363d] mx-auto mb-3" />
          <p className="text-sm">{t('empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(q => (
            <div key={q.id} className="glass-card p-4 animate-fade-in">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-medium text-[#e6edf3] truncate">{q.name}</h3>
                    <span className="text-xs text-[#8b949e] flex items-center gap-1 shrink-0">
                      <Clock size={10} /> {formatDate(q.created_at)}
                    </span>
                  </div>
                  {q.description && (
                    <p className="text-xs text-[#8b949e] mb-2">{q.description}</p>
                  )}
                  <code className="block text-xs font-mono text-[#8b949e] bg-[#0d1117] rounded px-2 py-1.5 truncate">
                    {q.sql ?? '—'}
                  </code>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Run */}
                  <button
                    onClick={() => {
                      if (!q.sql) return;
                      setRunModal({ sql: q.sql, connId: q.connection_id, name: q.name });
                    }}
                    disabled={!q.sql}
                    title={t('run')}
                    className="p-1.5 text-[#8b949e] hover:text-[#3fb950] transition-colors disabled:opacity-30"
                  >
                    <Play size={14} />
                  </button>
                  {/* Edit */}
                  <button
                    onClick={() => {
                      setSaveSql(q.sql ?? '');
                      setSaveConnId(q.connection_id);
                      setSaveEditId(q.id);
                      setShowSaveModal(true);
                    }}
                    title={t('edit')}
                    className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors"
                  >
                    <Edit2 size={14} />
                  </button>
                  {/* Delete */}
                  <button
                    onClick={() => deleteQuery(q.id)}
                    disabled={deleteId === q.id}
                    className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Save/create modal */}
      {showSaveModal && (
        <SaveQueryModal
          queryId={saveEditId}
          sql={saveSql}
          connectionId={saveConnId}
          onClose={() => { setShowSaveModal(false); setSaveEditId(undefined); setSaveSql(''); }}
          onSaved={handleSaved}
        />
      )}

      {/* Run result modal */}
      {runModal && (
        <ResultModal
          sql={runModal.sql}
          connectionId={runModal.connId}
          queryName={runModal.name}
          onClose={() => setRunModal(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-[#3fb950] text-white text-sm px-4 py-2 rounded-lg shadow-lg animate-fade-in z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
