'use client';

import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/api';
import type { QueryCancelResponse } from '@/types';

export function useQueryCancel() {
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancelQuery = useCallback(async (queryId: string): Promise<boolean> => {
    setIsCancelling(true);
    setCancelError(null);
    try {
      const { data } = await apiClient.post<QueryCancelResponse>('/query/cancel', { queryId });
      return data.cancelled;
    } catch (err: unknown) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed');
      return false;
    } finally {
      setIsCancelling(false);
    }
  }, []);

  return { cancelQuery, isCancelling, cancelError };
}
