'use client';

import { useState } from 'react';
import { Bell, BellOff, Trash2, Edit2, AlertCircle, Webhook } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn, formatDate } from '@/lib/utils';
import type { Alert } from '@/types';

const CONDITION_LABELS: Record<Alert['condition'], string> = {
  gt: '> ', lt: '< ', gte: '≥ ', lte: '≤ ', eq: '= ', ne: '≠ ',
};

interface AlertCardProps {
  alert: Alert;
  onEdit: (alert: Alert) => void;
  onDelete: (id: number) => void;
  onToggle: (id: number, active: boolean) => void;
  onWebhooks: (alert: Alert) => void;
  webhookCount?: number;
}

export default function AlertCard({ alert, onEdit, onDelete, onToggle, onWebhooks, webhookCount }: AlertCardProps) {
  const t = useTranslations('alerts');
  const tCommon = useTranslations('common');
  const [deleting, setDeleting] = useState(false);

  const recentlyTriggered = alert.last_triggered_at
    ? (Date.now() - new Date(alert.last_triggered_at).getTime()) < 3600000
    : false;

  return (
    <div className={cn('glass-card p-4 animate-fade-in', recentlyTriggered && 'border-[#f85149]/40')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {recentlyTriggered && <AlertCircle size={12} className="text-[#f85149] flex-shrink-0" />}
            <h3 className="text-sm font-medium text-[#e6edf3] truncate">{alert.name}</h3>
            <span className={cn(
              'text-xs px-2 py-0.5 rounded-full flex-shrink-0',
              alert.is_active
                ? recentlyTriggered ? 'bg-[#f85149]/15 text-[#f85149]' : 'bg-[#3fb950]/15 text-[#3fb950]'
                : 'bg-[#21262d] text-[#8b949e]'
            )}>
              {alert.is_active
                ? recentlyTriggered ? t('triggered') : t('active')
                : t('inactive')}
            </span>
          </div>

          {/* Condition */}
          <p className="text-xs text-[#8b949e] mb-2">
            <span className="font-mono text-[#58a6ff]">{CONDITION_LABELS[alert.condition]}{alert.threshold_value}</span>
            {alert.notify_email && <span className="ml-2 text-[#8b949e]">· {t('emailNotify')}</span>}
          </p>

          {/* SQL preview */}
          <code className="block text-xs font-mono text-[#8b949e] bg-[#0d1117] rounded px-2 py-1.5 truncate mb-2">
            {alert.query_sql}
          </code>

          {/* Meta */}
          <div className="flex items-center gap-3 text-xs text-[#8b949e]">
            {alert.last_checked_at && <span>{t('lastChecked')} {formatDate(alert.last_checked_at)}</span>}
            {alert.last_triggered_at && <span className="text-[#f85149]">{t('lastTriggered')} {formatDate(alert.last_triggered_at)}</span>}
            {webhookCount !== undefined && webhookCount > 0 && (
              <span className="flex items-center gap-1 text-[#58a6ff]">
                <Webhook size={10} /> {webhookCount} {webhookCount !== 1 ? t('webhooks') : t('webhook')}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1 flex-shrink-0">
          <button
            onClick={() => onWebhooks(alert)}
            title={t('webhooks')}
            className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors"
          >
            <Webhook size={14} />
          </button>
          <button
            onClick={() => onToggle(alert.id, !alert.is_active)}
            title={alert.is_active ? t('disabled') : t('enabled')}
            className={cn('p-1.5 transition-colors', alert.is_active ? 'text-[#3fb950] hover:text-[#2ea043]' : 'text-[#8b949e] hover:text-[#e6edf3]')}
          >
            {alert.is_active ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
          <button onClick={() => onEdit(alert)} title={tCommon('edit')} className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors">
            <Edit2 size={14} />
          </button>
          <button
            onClick={() => { setDeleting(true); onDelete(alert.id); setDeleting(false); }}
            disabled={deleting}
            title={tCommon('delete')}
            className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
