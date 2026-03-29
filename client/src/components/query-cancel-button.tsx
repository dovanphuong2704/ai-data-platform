'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QueryCancelButtonProps {
  queryId: string | null;
  isCancelling: boolean;
  onCancel: (queryId: string) => void;
  className?: string;
}

export default function QueryCancelButton({ queryId, isCancelling, onCancel, className }: QueryCancelButtonProps) {
  if (!queryId) return null;

  return (
    <button
      onClick={() => onCancel(queryId)}
      disabled={isCancelling}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
        isCancelling
          ? 'border-[#d29922] text-[#d29922] cursor-not-allowed'
          : 'border-[#f85149] text-[#f85149] hover:bg-[#f85149]/10',
        className
      )}
    >
      {isCancelling ? (
        <><Loader2 size={12} className="animate-spin" /> Cancelling...</>
      ) : (
        'Cancel'
      )}
    </button>
  );
}
