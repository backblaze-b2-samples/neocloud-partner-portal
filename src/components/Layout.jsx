import React from 'react';
import {
  LayoutDashboard, Users, Database, Globe, Receipt,
  KeyRound, Terminal, Search, Bell, ChevronDown,
  Settings as SettingsIcon, FolderTree, Zap, FlaskConical,
  LogOut, ShieldCheck, UserCog, BadgeDollarSign,
} from 'lucide-react';
import { cx } from '../lib/format.js';
import { useApp } from '../lib/AppContext.jsx';

const ALL_NAV = [
  { id: 'overview',  label: 'Executive overview',  icon: LayoutDashboard, group: 'Insights' },
  { id: 'groups',    label: 'Groups',               icon: FolderTree,      group: 'Insights' },
  { id: 'partner',   label: 'Customers',                 icon: Users,        group: 'Insights' },
  { id: 'storage',   label: 'Storage & buckets',    icon: Database,         group: 'Operations' },
  { id: 'regions',   label: 'Regions & placement',  icon: Globe,            group: 'Operations' },
  { id: 'usage',     label: 'Usage & billing',      icon: Receipt,          group: 'Operations' },
  { id: 'keys',      label: 'Application keys & security', icon: KeyRound,  group: 'Security' },
  { id: 'users',     label: 'User management',      icon: ShieldCheck,      group: 'Administration', requireRole: 'admin' },
  { id: 'console',   label: 'API console',          icon: Terminal,         group: 'Developer' },
  { id: 'plans',     label: 'Reseller plans',        icon: BadgeDollarSign,  group: 'System' },
  { id: 'account',   label: 'My account',           icon: UserCog,          group: 'System' },
  { id: 'settings',  label: 'Settings & credentials', icon: SettingsIcon,  group: 'System' },
];

// Filter NAV per the user's role. Admin-only entries are *omitted* (not just
// disabled) so they don't appear in the rendered HTML for non-admins.
function navFor(user) {
  if (!user) return [];
  let items = ALL_NAV.filter((n) => {
    if (!n.requireRole) return true;
    return n.requireRole === user.role;
  });
  if (user.role === 'support') {
    items = items.filter((n) => n.id !== 'users' && n.id !== 'settings');
  }
  return items;
}

export const NAV = ALL_NAV;

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-bb-red shadow-glow">
          <span className="font-semibold text-white">B2</span>
        </div>
        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent-green ring-2 ring-ink-900 live-dot" />
      </div>
      <div>
        <div className="text-sm font-semibold leading-tight text-ink-100">
          Backblaze<span className="text-bb-red">·</span>Neocloud
        </div>
        <div className="text-[10.5px] font-medium uppercase tracking-widest text-ink-400">
          Partner Portal
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ active, onSelect }) {
  const { user } = useApp();
  // Treat detail views as part of their parent tab visually.
  const visualActive = ({
    'customer-detail': 'partner',
    'bucket-detail':   'storage',
    'key-detail':      'keys',
  })[active] || active;
  const visible = navFor(user);
  const groups = visible.reduce((acc, n) => {
    if (!acc[n.group]) acc[n.group] = [];
    acc[n.group].push(n);
    return acc;
  }, {});
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/50 backdrop-blur-sm">
      <div className="border-b border-ink-800 px-5 py-4">
        <Logo />
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
              {group}
            </div>
            <ul className="space-y-0.5">
              {items.map((n) => {
                const Icon = n.icon;
                const isActive = visualActive === n.id;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => onSelect(n.id)}
                      className={cx(
                        'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-bb-red/10 text-ink-100 ring-1 ring-inset ring-bb-red/30'
                          : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                      )}
                    >
                      <Icon size={16} className={isActive ? 'text-bb-red' : 'text-ink-400 group-hover:text-ink-200'} />
                      <span className="truncate">{n.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <SidebarFooter />
    </aside>
  );
}

function initialsFor(email) {
  if (!email) return '··';
  const local = String(email).split('@')[0] || '';
  const parts = local.split(/[._\-+]/).filter(Boolean);
  const a = (parts[0] || local || 'u')[0] || 'u';
  const b = (parts[1] || '')[0] || '';
  return (a + b).toUpperCase().slice(0, 2);
}

function SidebarFooter() {
  const { isLive, hasCreds, user, logout } = useApp();
  const initials = initialsFor(user?.email);
  const subtitle = user?.role
    ? user.role[0].toUpperCase() + user.role.slice(1)
    : '';
  return (
    <div className="border-t border-ink-800 p-4">
      <div className="rounded-lg bg-ink-850 p-3 ring-1 ring-ink-700">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-bb-red to-accent-violet text-[11px] font-semibold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-ink-100" title={user?.email}>
              {user?.email || 'Signed out'}
            </div>
            <div className="truncate text-[10.5px] text-ink-400">{subtitle}</div>
          </div>
          {user && (
            <button
              onClick={() => { logout(); }}
              className="grid h-6 w-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={12} />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10.5px]">
          <ModePill isLive={isLive} />
          {!hasCreds && isLive && (
            <span className="text-bb-red" title="Live mode is on but no credentials are configured">
              ⚠ no creds
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ModePill({ isLive }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
        isLive
          ? 'bg-accent-green/15 text-accent-green ring-accent-green/30'
          : 'bg-accent-violet/15 text-accent-violet ring-accent-violet/30'
      )}
    >
      {isLive ? <Zap size={10} /> : <FlaskConical size={10} />}
      {isLive ? 'Live' : 'Demo'}
    </span>
  );
}

export function TopBar({ active, onOpenSettings }) {
  const { isLive, hasCreds, setMode, canGoLive } = useApp();
  const current = NAV.find((n) => n.id === active);
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-ink-800 bg-ink-900/70 px-6 backdrop-blur">
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5 text-ink-400">
          <span>Partner Portal</span>
          <ChevronDown size={12} />
        </div>
        <span className="text-ink-600">/</span>
        <span className="font-medium text-ink-100">{current?.label || 'Dashboard'}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            type="text"
            placeholder="Search buckets, customers, keys…"
            className="h-8 w-72 rounded-md border border-ink-700 bg-ink-850 pl-8 pr-3 text-xs text-ink-100 placeholder:text-ink-400 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
          />
        </div>

        {/* Mode toggle */}
        <div className="flex h-8 items-center overflow-hidden rounded-md ring-1 ring-ink-700">
          <button
            onClick={() => setMode('demo')}
            className={cx(
              'inline-flex h-full items-center gap-1 px-2 text-[11px] font-medium transition',
              !isLive ? 'bg-accent-violet/15 text-accent-violet' : 'bg-ink-850 text-ink-300 hover:text-ink-100'
            )}
            title="Use mock data"
          >
            <FlaskConical size={11} /> Demo
          </button>
          <button
            onClick={() => canGoLive ? setMode('live') : onOpenSettings()}
            className={cx(
              'inline-flex h-full items-center gap-1 px-2 text-[11px] font-medium transition',
              isLive
                ? 'bg-accent-green/15 text-accent-green'
                : canGoLive
                  ? 'bg-ink-850 text-ink-300 hover:text-ink-100'
                  : 'bg-ink-850 text-ink-400 hover:text-ink-200'
            )}
            title={canGoLive ? 'Use real Backblaze API' : 'Add credentials in Settings to enable live mode'}
          >
            <Zap size={11} /> Live
            {!canGoLive && <span className="text-[9px] uppercase">no creds</span>}
          </button>
        </div>

        <button
          onClick={onOpenSettings}
          className="grid h-8 w-8 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          title="Settings & credentials"
        >
          <SettingsIcon size={14} />
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
          <Bell size={14} />
        </button>
        <div className="hidden h-8 items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 text-[11px] text-ink-300 md:inline-flex">
          <span className={cx('h-1.5 w-1.5 rounded-full live-dot', isLive ? 'bg-accent-green' : 'bg-accent-violet')} />
          <span>{isLive ? (hasCreds ? 'Live · 4 regions' : 'Live · no creds') : 'Demo · 4 regions'}</span>
        </div>
      </div>
    </header>
  );
}

// =============================================================================
// Customer Portal Sidebar & TopBar
// =============================================================================

const CUSTOMER_NAV = [
  { id: 'my-overview',     label: 'My overview', icon: LayoutDashboard, group: 'My account' },
  { id: 'storage',         label: 'My storage',  icon: Database,        group: 'My account' },
  { id: 'usage',           label: 'My usage',    icon: Receipt,         group: 'My account' },
  { id: 'keys',            label: 'My keys',     icon: KeyRound,        group: 'My account' },
  { id: 'customer-users',  label: 'My team',     icon: Users,           group: 'My account', adminOnly: true },
  { id: 'account',         label: 'My account',  icon: UserCog,         group: 'System' },
];

export function CustomerSidebar({ active, onSelect, isCustomerAdmin }) {
  const visualActive = ({
    'bucket-detail': 'storage',
    'key-detail':    'keys',
  })[active] || active;

  const visible = CUSTOMER_NAV.filter((n) => !n.adminOnly || isCustomerAdmin);
  const groups = visible.reduce((acc, n) => {
    if (!acc[n.group]) acc[n.group] = [];
    acc[n.group].push(n);
    return acc;
  }, {});

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/50 backdrop-blur-sm">
      <div className="border-b border-ink-800 px-5 py-4">
        <Logo />
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
              {group}
            </div>
            <ul className="space-y-0.5">
              {items.map((n) => {
                const Icon = n.icon;
                const isActive = visualActive === n.id;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => onSelect(n.id)}
                      className={cx(
                        'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                        isActive
                          ? 'bg-bb-red/10 text-ink-100 ring-1 ring-inset ring-bb-red/30'
                          : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                      )}
                    >
                      <Icon size={16} className={isActive ? 'text-bb-red' : 'text-ink-400 group-hover:text-ink-200'} />
                      <span className="truncate">{n.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <SidebarFooter />
    </aside>
  );
}

export function CustomerTopBar({ active }) {
  const { logout } = useApp();
  const current = CUSTOMER_NAV.find((n) => n.id === active);
  const label = current?.label || 'My Portal';
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-ink-800 bg-ink-900/70 px-6 backdrop-blur">
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5 text-ink-400">
          <span>My Portal</span>
          <ChevronDown size={12} />
        </div>
        <span className="text-ink-600">/</span>
        <span className="font-medium text-ink-100">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <button className="grid h-8 w-8 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
          <Bell size={14} />
        </button>
        <button
          onClick={() => { logout(); }}
          className="grid h-8 w-8 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={14} />
        </button>
      </div>
    </header>
  );
}
