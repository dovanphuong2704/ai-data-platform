'use client';

import { useTranslations } from 'next-intl';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations();

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117]">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold gradient-text mb-2">{t('common.title')}</h1>
          <p className="text-[#8b949e] text-sm">Natural language SQL powered by AI</p>
        </div>
        <div className="glass-card p-8">{children}</div>
      </div>
    </div>
  );
}
