'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { Link } from '@/i18n/routing';
import { apiClient } from '@/lib/api';
import { useTranslations } from 'next-intl';

export default function RegisterPage() {
  const t = useTranslations('auth.register');
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await apiClient.post('/auth/register', { username, email, password });
      // Auto-login after registration
      await apiClient.post('/auth/login', { email, password });
      router.push('/chat');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-2xl font-semibold text-[#e6edf3] mb-6">{t('title')}</h2>

      {error && (
        <div className="bg-[#f85149]/10 border border-[#f85149]/30 text-[#f85149] text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm text-[#8b949e] mb-1.5" htmlFor="username">{t('username')}</label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          required
          minLength={2}
          maxLength={50}
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2.5 text-sm focus:border-[#58a6ff] focus:outline-none transition-colors"
          placeholder="yourname"
        />
      </div>

      <div>
        <label className="block text-sm text-[#8b949e] mb-1.5" htmlFor="email">{t('email')}</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2.5 text-sm focus:border-[#58a6ff] focus:outline-none transition-colors"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label className="block text-sm text-[#8b949e] mb-1.5" htmlFor="password">{t('password')}</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          minLength={6}
          className="w-full bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2.5 text-sm focus:border-[#58a6ff] focus:outline-none transition-colors"
          placeholder="Min. 6 characters"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full gradient-btn py-2.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Creating account...' : t('submit')}
      </button>

      <p className="text-center text-sm text-[#8b949e]">
        {t('hasAccount')}{' '}
        <Link href="/login" className="text-[#58a6ff] hover:underline">{t('signIn')}</Link>
      </p>
    </form>
  );
}
