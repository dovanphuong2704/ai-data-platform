'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ShareModalProps {
  dashboardItemId: number;
  onClose: () => void;
  onShared?: () => void;
}

export default function ShareModal({ dashboardItemId, onClose, onShared }: ShareModalProps) {
  const [target, setTarget] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target.trim()) return;
    setSaving(true);
    setError('');
    try {
      await apiClient.post(`/dashboard/${dashboardItemId}/share`, {
        usernameOrEmail: target.trim(),
        permission,
      });
      onShared?.();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Share failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm glass-card p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3]">Share Dashboard Item</h2>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-[#8b949e] mb-1">Username or Email</label>
            <input
              type="text"
              value={target}
              onChange={e => setTarget(e.target.value)}
              placeholder="e.g. johndoe or john@example.com"
              required
              autoFocus
              className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-[#8b949e] mb-1">Permission</label>
            <div className="flex gap-2">
              {(['view', 'edit'] as const).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPermission(p)}
                  className={cn(
                    'flex-1 py-2 text-xs font-medium rounded-lg border transition-colors capitalize',
                    permission === p
                      ? 'border-[#58a6ff] text-[#58a6ff] bg-[#58a6ff]/10'
                      : 'border-[#30363d] text-[#8b949e] hover:text-[#e6edf3]'
                  )}
                >
                  {p}
                  {p === 'edit' && (
                    <span className="block text-[10px] mt-0.5 opacity-60">can modify</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-[#f85149]">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3]">
              Cancel
            </button>
            <button type="submit" disabled={saving || !target.trim()} className="gradient-btn px-5 py-2 text-sm disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin inline" /> : null}
              {saving ? 'Sharing...' : 'Share'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
