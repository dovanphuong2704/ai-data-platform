'use client';

import { cn } from '@/lib/utils';
import type { AIProvider } from '@/hooks/use-ai-provider';

const PROVIDERS: { value: AIProvider; label: string; shortLabel: string }[] = [
  { value: 'openai', label: 'OpenAI (GPT-4o)', shortLabel: 'GPT' },
  { value: 'grok', label: 'Grok (xAI)', shortLabel: 'Grok' },
  { value: 'gemini', label: 'Google Gemini', shortLabel: 'Gemini' },
  { value: 'claude', label: 'Anthropic Claude', shortLabel: 'Claude' },
];

interface ProviderToggleProps {
  provider: AIProvider;
  onChange: (p: AIProvider) => void;
}

export default function ProviderToggle({ provider, onChange }: ProviderToggleProps) {
  return (
    <div className="flex items-center gap-1 bg-[#0d1117] border border-[#30363d] rounded-lg p-0.5">
      {PROVIDERS.map(p => (
        <button
          key={p.value}
          onClick={() => onChange(p.value)}
          title={p.label}
          className={cn(
            'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
            provider === p.value
              ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
              : 'text-[#8b949e] hover:text-[#e6edf3]'
          )}
        >
          {p.shortLabel}
        </button>
      ))}
    </div>
  );
}
