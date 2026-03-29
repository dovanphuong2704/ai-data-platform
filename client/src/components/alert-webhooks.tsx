'use client';

import { useState, useCallback } from 'react';
import { Plus, Trash2, Bell, BellOff, TestTube, Loader2, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AlertWebhook } from '@/types';

interface AlertWebhooksProps {
  alertId: number;
  webhooks: AlertWebhook[];
  onRefresh: () => void;
}

export default function AlertWebhooks({ alertId, webhooks, onRefresh }: AlertWebhooksProps) {
  const t = useTranslations('alerts');
  const tCommon = useTranslations('common');
  const [adding, setAdding] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
  const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());

  const handleAdd = useCallback(async () => {
    if (!urlInput.trim()) return;
    setSaving(true);
    try {
      await apiClient.post(`/alerts/${alertId}/webhooks`, { webhookUrl: urlInput.trim() });
      setUrlInput('');
      setAdding(false);
      onRefresh();
    } catch {
      alert(tCommon('error'));
    } finally {
      setSaving(false);
    }
  }, [alertId, urlInput, onRefresh, tCommon]);

  const handleToggle = useCallback(async (wh: AlertWebhook) => {
    setTogglingIds(prev => new Set(prev).add(wh.id));
    try {
      await apiClient.put(`/alerts/${alertId}/webhooks/${wh.id}`, { isEnabled: !wh.is_enabled });
      onRefresh();
    } catch {
      alert(tCommon('error'));
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev);
        next.delete(wh.id);
        return next;
      });
    }
  }, [alertId, onRefresh, tCommon]);

  const handleDelete = useCallback(async (whId: number) => {
    if (!confirm(tCommon('confirm'))) return;
    try {
      await apiClient.delete(`/alerts/${alertId}/webhooks/${whId}`);
      onRefresh();
    } catch {
      alert(tCommon('error'));
    }
  }, [alertId, onRefresh, tCommon]);

  const handleTest = useCallback(async (wh: AlertWebhook) => {
    setTestingIds(prev => new Set(prev).add(wh.id));
    try {
      const { data } = await apiClient.post<{ success: boolean; status: string }>(
        `/alerts/${alertId}/webhooks/${wh.id}/test`
      );
      alert(data.success
        ? `${tCommon('success')}! Status: ${data.status}`
        : `${tCommon('error')}: ${data.status}`
      );
    } catch (err) {
      alert(`${tCommon('error')}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTestingIds(prev => {
        const next = new Set(prev);
        next.delete(wh.id);
        return next;
      });
    }
  }, [alertId, tCommon]);

  return (
    <div className="mt-3 pt-3 border-t border-[#30363d] space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-[#8b949e]">{t('webhooks')}</span>
        {webhooks.length > 0 && (
          <span className="text-xs text-[#30363d]">{webhooks.length}</span>
        )}
      </div>

      {/* Webhook list */}
      {webhooks.length === 0 && !adding && (
        <p className="text-xs text-[#30363d]">{t('empty')}</p>
      )}

      <div className="space-y-2">
        {webhooks.map(wh => (
          <div key={wh.id} className="flex items-center gap-2 bg-[#0d1117] rounded-lg px-3 py-2">
            {/* Enable toggle */}
            <button
              onClick={() => handleToggle(wh)}
              disabled={togglingIds.has(wh.id)}
              title={wh.is_enabled ? t('disabled') : t('enabled')}
              className={cn(
                'flex-shrink-0 transition-colors',
                wh.is_enabled ? 'text-[#3fb950]' : 'text-[#30363d]'
              )}
            >
              {togglingIds.has(wh.id) ? (
                <Loader2 size={12} className="animate-spin" />
              ) : wh.is_enabled ? (
                <Bell size={12} />
              ) : (
                <BellOff size={12} />
              )}
            </button>

            {/* URL */}
            <span
              className={cn(
                'flex-1 text-xs truncate font-mono',
                wh.is_enabled ? 'text-[#8b949e]' : 'text-[#30363d]'
              )}
              title={wh.webhook_url}
            >
              {wh.webhook_url}
            </span>

            {/* Test */}
            <button
              onClick={() => handleTest(wh)}
              disabled={testingIds.has(wh.id) || !wh.is_enabled}
              title={t('testWebhook')}
              className="flex-shrink-0 text-[#8b949e] hover:text-[#58a6ff] disabled:opacity-30 transition-colors"
            >
              {testingIds.has(wh.id) ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <TestTube size={11} />
              )}
            </button>

            {/* Open URL */}
            <a
              href={wh.webhook_url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('openUrl')}
              className="flex-shrink-0 text-[#30363d] hover:text-[#8b949e] transition-colors"
            >
              <ExternalLink size={11} />
            </a>

            {/* Delete */}
            <button
              onClick={() => handleDelete(wh.id)}
              title={tCommon('delete')}
              className="flex-shrink-0 text-[#30363d] hover:text-[#f85149] transition-colors"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Add webhook form */}
      {adding ? (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setAdding(false); setUrlInput(''); } }}
            placeholder="https://your-webhook-endpoint.com/alert"
            autoFocus
            className="flex-1 bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-xs focus:border-[#58a6ff] focus:outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={saving || !urlInput.trim()}
            className="flex-shrink-0 gradient-btn px-3 py-2 text-xs disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : t('addWebhook')}
          </button>
          <button
            onClick={() => { setAdding(false); setUrlInput(''); }}
            className="flex-shrink-0 text-[#8b949e] hover:text-[#e6edf3] px-2 py-2 text-xs"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-xs text-[#58a6ff] hover:text-[#79c0ff] transition-colors"
        >
          <Plus size={12} /> {t('addWebhook')}
        </button>
      )}
    </div>
  );
}
