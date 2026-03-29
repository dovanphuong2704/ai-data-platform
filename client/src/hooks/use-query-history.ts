'use client';

import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/api';
import type { SqlHistoryEntry } from '@/types';

export function useQueryHistory() {
  const [history, setHistory] = useState<SqlHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiClient.get<{ history: SqlHistoryEntry[] }>('/history');
      setHistory(data.history);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const rerunQuery = useCallback(async (id: number): Promise<{ sql: string; connectionId?: number } | null> => {
    try {
      const entry = history.find(h => h.id === id);
      return entry ? { sql: entry.sql, connectionId: entry.connection_id } : null;
    } catch {
      return null;
    }
  }, [history]);

  return { history, loading, fetchHistory, rerunQuery };
}
