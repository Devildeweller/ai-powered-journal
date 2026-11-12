import { BookOpen, Brain, ChartNoAxesColumn, LogOut, MessageCircle, Monitor, Moon, PenLine, Settings, Sun } from 'lucide-react';
import { Suspense } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../lib/theme.js';
import { Spinner, cx } from './ui.jsx';

const NAV = [
  { to: '/journal', label: 'Journal', Icon: BookOpen },
  { to: '/chat', label: 'Ask', Icon: MessageCircle },
  { to: '/memories', label: 'Memory', Icon: Brain },
  { to: '/insights', label: 'Insights', Icon: ChartNoAxesColumn },
];

export function Logo({ className }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path d="M16 6c-3.6 4.6-6 7.9-6 11.2a6 6 0 0 0 12 0C22 13.9 19.6 10.6 16 6Z" className="fill-on-accent" />
        <path d="M10 25h12" className="stroke-on-accent" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="font-serif text-[22px] font-medium tracking-tight text-ink">Inkwell</span>
    </span>
  );
}

const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_META = {
  system: { label: 'System theme', Icon: Monitor },
  light: { label: 'Light theme', Icon: Sun },
  dark: { label: 'Dark theme', Icon: Moon },
};

function ThemeButton() {
  const { theme, setTheme } = useTheme();
  const { label, Icon } = THEME_META[theme];
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`${label}. Switch to ${THEME_META[next].label.toLowerCase()}.`}
      aria-label={`${label}. Switch to ${THEME_META[next].label.toLowerCase()}.`}
      className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken hover:text-ink"
    >
      <Icon className="size-[18px]" />
    </button>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  // The chat page manages its own full-height layout.
  const fullBleed = location.pathname.startsWith('/chat');

  return (
    <div className="min-h-dvh md:pl-60">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface md:flex">
        <Link to="/journal" className="px-5 pb-5 pt-6">
          <Logo />
        </Link>

        <div className="px-3">
          <Link
            to="/journal/new"
            className="flex h-10 items-center justify-center gap-2 rounded-xl bg-accent text-sm font-medium text-on-accent shadow-sm transition-colors hover:bg-accent-hover"
          >
            <PenLine className="size-4" aria-hidden />
            New entry
          </Link>
        </div>

        <nav className="mt-5 flex flex-1 flex-col gap-0.5 px-3" aria-label="Main">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cx(
                  'flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors',
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                )
              }
            >
              <Icon className="size-[18px]" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-1">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cx(
                  'flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-sm transition-colors',
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                )
              }
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-xs font-semibold uppercase text-ink-2">
                {user?.name?.[0] ?? '?'}
              </span>
              <span className="truncate font-medium">{user?.name}</span>
            </NavLink>
            <ThemeButton />
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken hover:text-ink"
            >
              <LogOut className="size-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur md:hidden">
        <Link to="/journal">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          <ThemeButton />
          <NavLink to="/settings" aria-label="Settings" className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-sunken">
            <Settings className="size-[18px]" />
          </NavLink>
        </div>
      </header>

      <main className={fullBleed ? '' : 'mx-auto w-full max-w-4xl px-4 pb-28 pt-6 md:px-10 md:pb-16 md:pt-10'}>
        <Suspense
          fallback={
            <div className="grid h-[50dvh] place-items-center text-ink-3" role="status" aria-label="Loading">
              <Spinner className="size-5" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      {/* Mobile tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Main"
      >
        {NAV.slice(0, 2).map((item) => (
          <TabLink key={item.to} {...item} />
        ))}
        <Link to="/journal/new" className="grid place-items-center" aria-label="New entry">
          <span className="grid size-11 place-items-center rounded-full bg-accent text-on-accent shadow-sm">
            <PenLine className="size-5" />
          </span>
        </Link>
        {NAV.slice(2).map((item) => (
          <TabLink key={item.to} {...item} />
        ))}
      </nav>
    </div>
  );
}

function TabLink({ to, label, Icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx('flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', isActive ? 'text-accent' : 'text-ink-3')
      }
    >
      <Icon className="size-5" aria-hidden />
      {label}
    </NavLink>
  );
}
