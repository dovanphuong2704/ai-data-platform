'use client';

import { useState, useCallback, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import type { QuotaResponse } from '@/types';

export function useQuota() {
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchQuota = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get<QuotaResponse>('/quota');
      setQuota(data);
    } catch {
      // silent — quota is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuota();
  }, [fetchQuota]);

  return { quota, loading, fetchQuota };
}
