'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

interface QuotaBadgeProps {
  remaining: number;
  limit: number;
  className?: string;
}

function timeUntilReset(resetAt: string): string {
  const diff = new Date(resetAt).getTime() - Date.now();
  if (diff <= 0) return 'Resets soon';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `Resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `Resets in ${hrs}h`;
}

export default function QuotaBadge({ remaining, limit, className }: QuotaBadgeProps) {
  const t = useTranslations('quota');
  const pct = limit > 0 ? (remaining / limit) * 100 : 0;
  const color = pct > 50 ? 'text-[#3fb950]' : pct > 20 ? 'text-[#d29922]' : 'text-[#f85149]';
  const bg = pct > 50 ? 'bg-[#3fb950]/10' : pct > 20 ? 'bg-[#d29922]/10' : 'bg-[#f85149]/10';

  return (
    <div className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium', bg, color, className)}>
      <span>{remaining}/{limit}</span>
      <span className="text-[#8b949e]">{t('queries')}</span>
    </div>
  );
}

export { timeUntilReset };
