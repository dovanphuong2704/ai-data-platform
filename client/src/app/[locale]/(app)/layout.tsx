'use client';

import { useState } from 'react';
import { Link, usePathname, useRouter } from '@/i18n/routing';
import { useLocale } from 'next-intl';
import { useTranslations } from 'next-intl';
import {
  MessageSquare,
  LayoutDashboard,
  Database,
  Settings,
  LogOut,
  ChevronRight,
  Brain,
  Bookmark,
  Bell,
  Clock,
  User,
  Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/auth-provider';
import { AuthGuard } from '@/components/auth-guard';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('nav');
  const { user, logout } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [localeMenuOpen, setLocaleMenuOpen] = useState(false);

  const LOCALES = [
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  ];

  const currentLocale = LOCALES.find(l => l.code === locale) ?? LOCALES[0];

  // eslint-disable-next-line no-console
  console.log('[Locale Debug]', { pathname, locale, currentLocale: currentLocale.code });
  const switchLocale = (newLocale: string) => {
    setLocaleMenuOpen(false);

    // next-intl useRouter bản thân nó đã hiểu việc thay đổi locale
    // Bạn chỉ cần truyền pathname hiện tại và locale mới vào options
    router.replace(pathname, { locale: newLocale });
  };

  const navItems = [
    { href: '/chat', labelKey: 'chat', icon: MessageSquare },
    { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
    { href: '/saved-queries', labelKey: 'savedQueries', icon: Bookmark },
    { href: '/alerts', labelKey: 'alerts', icon: Bell },
    { href: '/scheduled-queries', labelKey: 'scheduledQueries', icon: Clock },
    { href: '/explorer', labelKey: 'explorer', icon: Database },
    { href: '/settings', labelKey: 'settings', icon: Settings },
  ];

  const getPageTitle = () => {
    const item = navItems.find(n => pathname === n.href || pathname.startsWith(n.href + '/'));
    return item ? t(item.labelKey) : 'AI Data Platform';
  };

  return (
    <div className="flex h-screen bg-[#0d1117] overflow-hidden">
      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col bg-[#161b22] border-r border-[#30363d] transition-all duration-200',
          sidebarCollapsed ? 'w-16' : 'w-56'
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-[#30363d]">
          <div className="w-8 h-8 rounded-lg gradient-btn flex items-center justify-center flex-shrink-0">
            <Brain size={18} className="text-white" />
          </div>
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#e6edf3] truncate">AI Platform</p>
              <p className="text-xs text-[#8b949e] truncate">Data Intelligence</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5">
          {navItems.map(({ href, labelKey, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-[#58a6ff]/10 text-[#58a6ff]'
                    : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]'
                )}
              >
                <Icon size={18} className="flex-shrink-0" />
                {!sidebarCollapsed && <span className="truncate">{t(labelKey)}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="flex items-center justify-center gap-2 px-4 py-3 border-t border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"
        >
          <ChevronRight
            size={16}
            className={cn('transition-transform', !sidebarCollapsed && 'rotate-180')}
          />
          {!sidebarCollapsed && <span className="text-xs">{t('collapse')}</span>}
        </button>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#161b22]">
          <div>
            <h2 className="text-base font-semibold text-[#e6edf3]">
              {getPageTitle()}
            </h2>
          </div>
          <div className="flex items-center gap-4">
            {/* Language switcher */}
            <div className="relative">
              <button
                onClick={() => setLocaleMenuOpen(!localeMenuOpen)}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-[#8b949e] hover:border-[#58a6ff] hover:text-[#e6edf3] transition-all"
              >
                <Globe size={12} className="text-[#58a6ff]" />
                <span>{currentLocale.flag} {currentLocale.code.toUpperCase()}</span>
              </button>
              {localeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-[-1]" onClick={() => setLocaleMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-36 bg-[#161b22] border border-[#30363d] rounded-xl shadow-xl z-50 overflow-hidden">
                    {LOCALES.map(loc => (
                      <button
                        key={loc.code}
                        onClick={() => switchLocale(loc.code)}
                        className={cn(
                          'w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left transition-colors',
                          loc.code === currentLocale.code
                            ? 'bg-[#58a6ff]/10 text-[#58a6ff]'
                            : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]'
                        )}
                      >
                        <span>{loc.flag}</span>
                        <span>{loc.label}</span>
                        {loc.code === currentLocale.code && <span className="ml-auto text-[10px]">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* User info */}
            {user ? (
              <div className="flex items-center gap-2 text-sm text-[#8b949e]">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-[#58a6ff]/20 text-[#58a6ff]">
                  <User size={14} />
                </div>
                <div className="hidden sm:block">
                  <p className="text-xs font-medium text-[#e6edf3]">{user.username}</p>
                  <p className="text-[10px] text-[#8b949e]">{user.email}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-[#8b949e]">
                <div className="w-8 h-8 rounded-full bg-[#30363d] animate-pulse" />
                <div className="hidden sm:block">
                  <div className="h-3 w-20 bg-[#30363d] rounded animate-pulse mb-1" />
                  <div className="h-2 w-28 bg-[#30363d] rounded animate-pulse" />
                </div>
              </div>
            )}
            <button
              onClick={logout}
              title={t('logout')}
              className="flex items-center gap-2 text-sm text-[#8b949e] hover:text-[#f85149] transition-colors"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto">
          <AuthGuard>
            {children}
          </AuthGuard>
        </div>
      </main>
    </div>
  );
}
