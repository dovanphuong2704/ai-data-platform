'use client';

import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'ai-provider';
const DEFAULT_PROVIDER = 'openai';

const VALID_PROVIDERS = ['openai', 'grok', 'gemini', 'claude'] as const;
export type AIProvider = typeof VALID_PROVIDERS[number];

export function useAiProvider() {
  const [provider, setProviderState] = useState<AIProvider>(DEFAULT_PROVIDER);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_PROVIDERS.includes(stored as AIProvider)) {
      setProviderState(stored as AIProvider);
    }
  }, []);

  const setProvider = useCallback((p: AIProvider) => {
    setProviderState(p);
    localStorage.setItem(STORAGE_KEY, p);
  }, []);

  return { provider, setProvider };
}
