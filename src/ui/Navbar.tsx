import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { getAllLanguagePacks, getLanguagePack } from '../packs/registry';
import { PWAInstallButton } from './PWAInstallButton';
import { useOnlineStatus } from './useOnlineStatus';
import {
  BookOpen,
  FolderOpen,
  History,
  Package,
  Settings,
  Sun,
  Moon,
  Sparkles,
  Wifi,
  WifiOff,
  Layers,
  GraduationCap,
  BarChart3,
} from 'lucide-react';

export const Navbar: React.FC = () => {
  const location = useLocation();
  const { activeLanguageId, setActiveLanguage, theme, setTheme } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);
  const allPacks = getAllLanguagePacks();
  const isOnline = useOnlineStatus();

  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const toggleTheme = () => {
    setTheme(isDark ? 'light' : 'dark');
  };

  const navItems = [
    { to: '/library', label: 'Library', icon: FolderOpen },
    { to: '/reader', label: 'Reader', icon: BookOpen },
    { to: '/cards', label: 'Cards', icon: Layers },
    { to: '/review', label: 'Review', icon: GraduationCap },
    { to: '/stats', label: 'Stats', icon: BarChart3 },
    { to: '/history', label: 'History', icon: History },
    { to: '/packs', label: 'Packs', icon: Package },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <>
      {/* Desktop / Tablet Top Navigation Header */}
      <header className="sticky top-0 z-40 bg-[var(--surface)]/90 backdrop-blur-md border-b border-[var(--border)]">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          {/* Logo & Brand */}
          <div className="flex items-center gap-6">
            <NavLink to="/library" className="flex items-center gap-2.5 group">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-indigo-500 p-0.5 shadow-md shadow-indigo-500/20 group-hover:scale-105 transition-transform">
                <div className="w-full h-full bg-[var(--surface)] rounded-[10px] flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                </div>
              </div>
              <div>
                <span className="font-black text-lg tracking-tight bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                  LinguaForge
                </span>
                <span className="hidden sm:inline-block text-[10px] uppercase font-bold tracking-widest text-[var(--text-muted)] ml-1.5 px-1.5 py-0.5 rounded bg-[var(--surface-muted)]">
                  PWA
                </span>
              </div>
            </NavLink>

            {/* Desktop Nav Links */}
            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                      isActive
                        ? 'bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </nav>
          </div>

          {/* Right Action Items */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Language Pack Selector */}
            <div className="relative">
              <select
                value={activeLanguageId}
                onChange={(e) => setActiveLanguage(e.target.value)}
                className="appearance-none pl-3 pr-8 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-bold text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
              >
                {allPacks.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[var(--surface)] text-[var(--text)]">
                    {p.flagEmoji} {p.name}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)]">
                ▼
              </div>
            </div>

            {/* Online / Offline status badge */}
            <div
              className={`hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                isOnline
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50'
                  : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
              }`}
            >
              {isOnline ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Online</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-amber-500" />
                  <span>Offline</span>
                </>
              )}
            </div>

            {/* PWA Install Button */}
            <PWAInstallButton />

            {/* Theme Toggle Button */}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition"
              title={
                theme === 'system'
                  ? `Theme: System (${isDark ? 'Dark' : 'Light'}) - Click to toggle`
                  : `Theme: ${theme === 'dark' ? 'Dark' : 'Light'} - Click to toggle`
              }
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--surface)]/95 backdrop-blur-md border-t border-[var(--border)] px-0.5 py-1 grid grid-cols-8 items-center">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex flex-col items-center justify-center min-h-[44px] py-1 px-0 rounded-xl transition text-[9.5px] sm:text-[10px] font-bold whitespace-nowrap ${
                isActive
                  ? 'text-[var(--accent-text)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </>
  );
};
