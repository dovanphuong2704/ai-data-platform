'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
          <button
            onClick={async () => {
              try {
                const { apiClient } = await import('@/lib/api');
                await apiClient.post('/auth/logout');
                window.location.href = '/login';
              } catch {
                window.location.href = '/login';
              }
            }}
            className="flex items-center gap-2 text-sm text-[#8b949e] hover:text-[#f85149] transition-colors"
          >
            <LogOut size={16} />
            {t('logout')}
          </button>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
