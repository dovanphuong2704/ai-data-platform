'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, Plus, Loader2, Search, X } from 'lucide-react';
import { apiClient } from '@/lib/api';
import type { Alert, AlertWebhook } from '@/types';
import AlertCard from '@/components/alert-card';
import AlertForm from '@/components/alert-form';
import AlertWebhooks from '@/components/alert-webhooks';
import { useTranslations } from 'next-intl';

export default function AlertsPage() {
  const t = useTranslations('alerts');
  const tc = useTranslations('common');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connections, setConnections] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingAlert, setEditingAlert] = useState<Alert | undefined>();

  // Webhook drawer state
  const [webhookAlert, setWebhookAlert] = useState<Alert | null>(null);
  const [webhooks, setWebhooks] = useState<AlertWebhook[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(false);

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const [alertsRes, connRes] = await Promise.all([
        apiClient.get<{ alerts: Alert[] }>('/alerts'),
        apiClient.get<{ connections: unknown[] }>('/connections'),
      ]);
      setAlerts(alertsRes.data.alerts);
      setConnections(connRes.data.connections);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  const handleDelete = async (id: number) => {
    if (!confirm(tc('confirm'))) return;
    try {
      await apiClient.delete(`/alerts/${id}`);
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch { alert(tc('error')); }
  };

  const handleToggle = async (id: number, active: boolean) => {
    try {
      await apiClient.put(`/alerts/${id}`, { is_active: active });
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, is_active: active } : a));
    } catch { alert(tc('error')); }
  };

  const loadWebhooks = useCallback(async (alertId: number) => {
    setWebhooksLoading(true);
    try {
      const { data } = await apiClient.get<{ webhooks: AlertWebhook[] }>(`/alerts/${alertId}/webhooks`);
      setWebhooks(data.webhooks);
    } catch { /* silent */ }
    finally { setWebhooksLoading(false); }
  }, []);

  const handleWebhooks = useCallback((alert: Alert) => {
    setWebhookAlert(alert);
    loadWebhooks(alert.id);
  }, [loadWebhooks]);

  const filtered = alerts.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.query_sql.toLowerCase().includes(search.toLowerCase())
  );

  // Compute webhook counts per alert
  const webhookCounts = Object.fromEntries(
    Object.entries(
      alerts.reduce<Record<number, number>>((acc, a) => {
        acc[a.id] = (acc[a.id] ?? 0);
        return acc;
      }, {})
    ).map(([id]) => [parseInt(id), 0])
  );

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell size={20} className="text-[#58a6ff]" />
          <h1 className="text-lg font-semibold text-[#e6edf3]">{t('title')}</h1>
          <span className="text-xs text-[#8b949e]">{filtered.length} {filtered.length !== 1 ? 'alerts' : 'alert'}</span>
        </div>
        <button onClick={() => { setEditingAlert(undefined); setShowForm(true); }}
          className="flex items-center gap-2 gradient-btn px-4 py-2 text-sm">
          <Plus size={14} /> {t('createAlert')}
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
          <Bell size={40} className="text-[#30363d] mx-auto mb-3" />
          <p className="text-sm">{search ? t('empty') : t('empty')}</p>
          {!search && <p className="text-xs mt-1">{t('empty')}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(a => (
            <AlertCard
              key={a.id}
              alert={a}
              onEdit={alert => { setEditingAlert(alert); setShowForm(true); }}
              onDelete={handleDelete}
              onToggle={handleToggle}
              onWebhooks={handleWebhooks}
              webhookCount={webhookCounts[a.id] ?? 0}
            />
          ))}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <AlertForm
          alert={editingAlert}
          connections={connections as Parameters<typeof AlertForm>[0]['connections']}
          onClose={() => setShowForm(false)}
          onSaved={loadAlerts}
        />
      )}

      {/* Webhook drawer */}
      {webhookAlert && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/50" onClick={() => setWebhookAlert(null)} />

          {/* Drawer */}
          <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#161b22] border-l border-[#30363d] flex flex-col z-10 animate-slide-in-right">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d]">
              <div>
                <h2 className="text-sm font-semibold text-[#e6edf3]">{t('webhooks')}</h2>
                <p className="text-xs text-[#8b949e] mt-0.5">{webhookAlert.name}</p>
              </div>
              <button
                onClick={() => setWebhookAlert(null)}
                className="p-1.5 text-[#8b949e] hover:text-[#e6edf3] transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {webhooksLoading ? (
                <div className="text-center py-8 text-[#8b949e]">
                  <Loader2 size={16} className="animate-spin inline" /> {tc('loading')}
                </div>
              ) : (
                <AlertWebhooks
                  alertId={webhookAlert.id}
                  webhooks={webhooks}
                  onRefresh={() => loadWebhooks(webhookAlert.id)}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
