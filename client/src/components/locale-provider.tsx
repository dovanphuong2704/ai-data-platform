'use client';

import { useState, useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter, usePathname } from '@/i18n/routing';
import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

const LOCALES = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
];

export default function LocaleProvider() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const switchLocale = (newLocale: string) => {
    setOpen(false);
    // Replace locale segment: /en/chat -> /vi/chat
    const segments = pathname.split('/');
    if (segments[1] && LOCALES.some(l => l.code === segments[1])) {
      segments[1] = newLocale;
    } else {
      segments.splice(1, 0, newLocale);
    }
    router.push(segments.join('/') || '/');
  };

  const currentLocale = LOCALES.find(l => l.code === locale) ?? LOCALES[0];

  if (!mounted) return null;

  return (
    <div className="fixed top-4 right-4 z-50">
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border border-[#30363d] rounded-xl text-sm text-[#e6edf3] hover:bg-[#21262d] hover:border-[#58a6ff] transition-all"
        >
          <Globe size={14} className="text-[#58a6ff]" />
          <span>{currentLocale.flag} {currentLocale.label}</span>
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-[-1]" onClick={() => setOpen(false)} />
            <div className="absolute right-0 mt-2 w-44 bg-[#161b22] border border-[#30363d] rounded-xl shadow-xl overflow-hidden animate-fade-in">
              {LOCALES.map(loc => (
                <button
                  key={loc.code}
                  onClick={() => switchLocale(loc.code)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors',
                    loc.code === locale
                      ? 'bg-[#58a6ff]/10 text-[#58a6ff]'
                      : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]'
                  )}
                >
                  <span>{loc.flag}</span>
                  <span>{loc.label}</span>
                  {loc.code === locale && <span className="ml-auto text-[10px] font-medium">✓</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
