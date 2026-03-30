'use client';

import { useState, useEffect } from 'react';
import { useRouter } from '@/i18n/routing';
import { useLocale } from 'next-intl';
import { Plus, Trash2, CheckCircle2, Database, Key, Loader2, X, Lock, User } from 'lucide-react';
import ConnectionTestButton from '@/components/connection-test-button';
import { apiClient } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import type { DbConnection, ApiKey } from '@/types';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/components/auth-provider';

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const locale = useLocale();

  const PROVIDERS = [
    { value: 'openai', label: t('apiKeys.providers.openai') },
    { value: 'grok', label: t('apiKeys.providers.grok') },
    { value: 'gemini', label: t('apiKeys.providers.gemini') },
    { value: 'claude', label: t('apiKeys.providers.claude') },
  ];

  const [tab, setTab] = useState<'connections' | 'apikeys' | 'password' | 'profile'>('connections');

  // Connections state
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [connLoading, setConnLoading] = useState(true);
  const [showConnForm, setShowConnForm] = useState(false);
  const [connForm, setConnForm] = useState({
    profile_name: '', db_host: 'localhost', db_port: '5432', db_name: '', db_user: 'postgres', db_password: '', is_default: false,
  });
  const [connSaving, setConnSaving] = useState(false);

  // Keys state
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyForm, setKeyForm] = useState({ profile_name: '', provider: 'openai' as const, api_key: '', is_default: false });
  const [keySaving, setKeySaving] = useState(false);

  useEffect(() => {
    loadConnections();
    loadKeys();
  }, []);

  const loadConnections = async () => {
    try {
      const { data } = await apiClient.get('/connections');
      setConnections(data.connections);
    } catch {} finally { setConnLoading(false); }
  };

  const loadKeys = async () => {
    try {
      const { data } = await apiClient.get('/keys');
      setKeys(data.keys);
    } catch {} finally { setKeysLoading(false); }
  };

  const saveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnSaving(true);
    try {
      await apiClient.post('/connections', connForm);
      await loadConnections();
      setShowConnForm(false);
      setConnForm({ profile_name: '', db_host: 'localhost', db_port: '5432', db_name: '', db_user: 'postgres', db_password: '', is_default: false });
      window.location.href = `/${locale}/chat`;
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : tc('error'));
    } finally { setConnSaving(false); }
  };

  const deleteConnection = async (id: number) => {
    if (!confirm(tc('confirm'))) return;
    try {
      await apiClient.delete(`/connections/${id}`);
      setConnections(prev => prev.filter(c => c.id !== id));
    } catch { alert(tc('error')); }
  };

  const saveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeySaving(true);
    try {
      await apiClient.post('/keys', keyForm);
      await loadKeys();
      setShowKeyForm(false);
      setKeyForm({ profile_name: '', provider: 'openai', api_key: '', is_default: false });
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : tc('error'));
    } finally { setKeySaving(false); }
  };

  const deleteKey = async (id: number) => {
    if (!confirm(tc('confirm'))) return;
    try {
      await apiClient.delete(`/keys/${id}`);
      setKeys(prev => prev.filter(k => k.id !== id));
    } catch { alert(tc('error')); }
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#30363d]">
        {([
          { id: 'connections' as const, label: t('tabs.connections'), icon: Database },
          { id: 'apikeys' as const, label: t('tabs.apiKeys'), icon: Key },
          { id: 'password' as const, label: t('tabs.password'), icon: Lock },
          { id: 'profile' as const, label: t('tabs.profile'), icon: User },
        ] as const).map(tabItem => (
          <button
            key={tabItem.id}
            onClick={() => setTab(tabItem.id)}
            className={cn('flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px', tab === tabItem.id ? 'border-[#58a6ff] text-[#58a6ff]' : 'border-transparent text-[#8b949e] hover:text-[#e6edf3]')}
          >
            <tabItem.icon size={15} />
            {tabItem.label}
          </button>
        ))}
      </div>

      {/* Connections tab */}
      {tab === 'connections' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowConnForm(!showConnForm)} className="flex items-center gap-2 gradient-btn px-4 py-2 text-sm">
              {showConnForm ? <><X size={14} /> {tc('cancel')}</> : <><Plus size={14} /> {t('connections.add')}</>}
            </button>
          </div>

          {showConnForm && (
            <form onSubmit={saveConnection} className="glass-card p-5 space-y-4 animate-fade-in">
              <h3 className="text-sm font-semibold text-[#e6edf3]">{t('connections.title')}</h3>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: t('connections.profileName'), key: 'profile_name', type: 'text', placeholder: t('connections.profileNamePlaceholder') },
                  { label: t('connections.host'), key: 'db_host', type: 'text', placeholder: 'localhost' },
                  { label: t('connections.port'), key: 'db_port', type: 'text', placeholder: '5432' },
                  { label: t('connections.database'), key: 'db_name', type: 'text', placeholder: 'mydb' },
                  { label: t('connections.username'), key: 'db_user', type: 'text', placeholder: 'postgres' },
                  { label: t('connections.password'), key: 'db_password', type: 'password', placeholder: '••••••••' },
                ].map(field => (
                  <div key={field.key}>
                    <label className="block text-xs text-[#8b949e] mb-1">{field.label}</label>
                    <input
                      type={field.type}
                      value={(connForm as unknown as Record<string, string>)[field.key]}
                      onChange={e => setConnForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      required={field.key !== 'profile_name'}
                      className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
                    />
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-[#8b949e]">
                <input type="checkbox" checked={connForm.is_default} onChange={e => setConnForm(prev => ({ ...prev, is_default: e.target.checked }))} className="accent-[#58a6ff]" />
                {t('connections.makeDefault')}
              </label>
              <div className="flex items-center gap-3">
                <button type="submit" disabled={connSaving} className="gradient-btn px-6 py-2 text-sm disabled:opacity-50">
                  {connSaving ? <Loader2 size={14} className="animate-spin inline" /> : <Plus size={14} className="inline" />} {tc('save')}
                </button>
                <ConnectionTestButton
                  db_host={connForm.db_host}
                  db_port={connForm.db_port}
                  db_name={connForm.db_name}
                  db_user={connForm.db_user}
                  db_password={connForm.db_password}
                />
              </div>
            </form>
          )}

          {connLoading ? (
            <div className="text-sm text-[#8b949e]"><Loader2 size={14} className="animate-spin inline" /> {tc('loading')}</div>
          ) : connections.length === 0 ? (
            <div className="text-center py-12 text-[#8b949e]">
              <Database size={40} className="mx-auto mb-3 text-[#30363d]" />
              <p className="text-sm">{t('connections.noConnections')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map(conn => (
                <div key={conn.id} className="glass-card p-4 flex items-start gap-3">
                  <Database size={16} className="text-[#58a6ff] mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[#e6edf3]">{conn.profile_name || `${conn.db_host}/${conn.db_name}`}</p>
                      {conn.is_default && <CheckCircle2 size={12} className="text-[#3fb950]" />}
                    </div>
                    <p className="text-xs text-[#8b949e] mt-0.5">{conn.db_user}@{conn.db_host}:{conn.db_port}/{conn.db_name}</p>
                    <p className="text-xs text-[#8b949e] mt-0.5">Added {formatDate(conn.created_at)}</p>
                  </div>
                  <button onClick={() => deleteConnection(conn.id)} className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* API Keys tab */}
      {tab === 'apikeys' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowKeyForm(!showKeyForm)} className="flex items-center gap-2 gradient-btn px-4 py-2 text-sm">
              {showKeyForm ? <><X size={14} /> {tc('cancel')}</> : <><Plus size={14} /> {t('apiKeys.add')}</>}
            </button>
          </div>

          {showKeyForm && (
            <form onSubmit={saveKey} className="glass-card p-5 space-y-4 animate-fade-in">
              <h3 className="text-sm font-semibold text-[#e6edf3]">{t('apiKeys.title')}</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-[#8b949e] mb-1">{t('apiKeys.profileName')}</label>
                  <input type="text" value={keyForm.profile_name} onChange={e => setKeyForm(prev => ({ ...prev, profile_name: e.target.value }))} placeholder={t('apiKeys.profileNamePlaceholder')} className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#8b949e] mb-1">{t('apiKeys.provider')}</label>
                  <select value={keyForm.provider} onChange={e => setKeyForm(prev => ({ ...prev, provider: e.target.value as typeof keyForm.provider }))} className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none">
                    {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#8b949e] mb-1">{t('apiKeys.key')}</label>
                  <input type="password" value={keyForm.api_key} onChange={e => setKeyForm(prev => ({ ...prev, api_key: e.target.value }))} placeholder={t('apiKeys.keyPlaceholder')} required className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none font-mono" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-[#8b949e]">
                <input type="checkbox" checked={keyForm.is_default} onChange={e => setKeyForm(prev => ({ ...prev, is_default: e.target.checked }))} className="accent-[#58a6ff]" />
                {t('apiKeys.makeDefault')}
              </label>
              <button type="submit" disabled={keySaving} className="gradient-btn px-6 py-2 text-sm disabled:opacity-50">
                {keySaving ? <Loader2 size={14} className="animate-spin inline" /> : <Plus size={14} className="inline" />} {tc('save')}
              </button>
            </form>
          )}

          {keysLoading ? (
            <div className="text-sm text-[#8b949e]"><Loader2 size={14} className="animate-spin inline" /> {tc('loading')}</div>
          ) : keys.length === 0 ? (
            <div className="text-center py-12 text-[#8b949e]">
              <Key size={40} className="mx-auto mb-3 text-[#30363d]" />
              <p className="text-sm">{t('apiKeys.noKeys')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map(k => (
                <div key={k.id} className="glass-card p-4 flex items-start gap-3">
                  <Key size={16} className="text-[#d29922] mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[#e6edf3]">{k.profile_name || PROVIDERS.find(p => p.value === k.provider)?.label}</p>
                      {k.is_default && <CheckCircle2 size={12} className="text-[#3fb950]" />}
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#21262d] text-[#8b949e]">{k.provider}</span>
                    </div>
                    <p className="text-xs text-[#8b949e] mt-0.5">Added {formatDate(k.created_at)}</p>
                  </div>
                  <button onClick={() => deleteKey(k.id)} className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Password tab */}
      {tab === 'password' && (
        <div className="glass-card p-5 max-w-md">
          <h3 className="text-sm font-semibold text-[#e6edf3] mb-4">{t('password.title')}</h3>
          <form onSubmit={async (e) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const currentPassword = (form.elements.namedItem('currentPassword') as HTMLInputElement).value;
            const newPassword = (form.elements.namedItem('newPassword') as HTMLInputElement).value;
            const confirmPassword = (form.elements.namedItem('confirmPassword') as HTMLInputElement).value;

            if (newPassword !== confirmPassword) {
              alert(t('password.mismatch'));
              return;
            }

            try {
              await apiClient.put('/auth/password', {
                currentPassword,
                newPassword,
              });
              alert(t('password.success'));
              form.reset();
            } catch (err) {
              alert(err instanceof Error ? err.message : tc('error'));
            }
          }} className="space-y-4">
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('password.current')}</label>
              <input type="password" name="currentPassword" required className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('password.new')}</label>
              <input type="password" name="newPassword" required minLength={6} className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#8b949e] mb-1">{t('password.confirm')}</label>
              <input type="password" name="confirmPassword" required minLength={6} className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none" />
            </div>
            <button type="submit" className="gradient-btn px-6 py-2 text-sm">
              {t('password.change')}
            </button>
          </form>
        </div>
      )}

      {/* Profile tab */}
      {tab === 'profile' && (
        <div className="glass-card p-5 max-w-md">
          <ProfileTab />
        </div>
      )}
    </div>
  );
}

// Profile Tab Component
function ProfileTab() {
  const t = useTranslations('settings.profile');
  const tc = useTranslations('common');
  const { user, refreshUser } = useAuth();

  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccess(false);
    try {
      await apiClient.put('/auth/profile', { username, email });
      await refreshUser();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : tc('error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h3 className="text-sm font-semibold text-[#e6edf3]">{t('title')}</h3>
      {success && (
        <div className="bg-[#3fb950]/10 border border-[#3fb950]/30 text-[#3fb950] text-sm px-4 py-3 rounded-lg">
          {t('success')}
        </div>
      )}
      <div>
        <label className="block text-xs text-[#8b949e] mb-1">{t('username')}</label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          required
          minLength={2}
          maxLength={50}
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-[#8b949e] mb-1">{t('email')}</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-sm focus:border-[#58a6ff] focus:outline-none"
        />
      </div>
      <div>
        <p className="text-xs text-[#8b949e]">{t('joined')}: {user?.created_at ? formatDate(user.created_at) : '-'}</p>
      </div>
      <button type="submit" disabled={saving} className="gradient-btn px-6 py-2 text-sm disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin inline" /> : null} {tc('save')}
      </button>
    </form>
  );
}
