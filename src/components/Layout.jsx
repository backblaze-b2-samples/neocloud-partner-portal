import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  LayoutDashboard, Users, Database, Globe, Receipt,
  KeyRound, Terminal, Search, Bell, ChevronDown,
  Settings as SettingsIcon, FolderTree, Zap, FlaskConical,
  LogOut, ShieldCheck, UserCog, BadgeDollarSign,
} from 'lucide-react';
import { cx } from '../lib/format.js';
import { useApp } from '../lib/AppContext.jsx';
import { useNav } from '../lib/nav.js';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';

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
        <GlobalSearch />

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
// Global search — filters customers / buckets / app keys
// =============================================================================
function GlobalSearch() {
  const { navigate } = useNav();
  const [query, setQuery] = useState('');
  const [open, setOpen]   = useState(false);
  const [hover, setHover] = useState(0);
  const [data, setData]   = useState({ customers: [], buckets: [], keys: [] });
  const [loaded, setLoaded] = useState(false);
  const boxRef = useRef(null);

  // Lazy-load the searchable set the first time the input is focused.
  // Cached for the lifetime of the page — re-mount on demo/live switch handles refresh.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    Promise.all([
      partner.getCustomers().catch(() => ({ customers: [] })),
      b2.listBuckets().catch(() => ({ buckets: [] })),
      b2.listApplicationKeys().catch(() => ({ keys: [] })),
    ]).then(([c, bk, k]) => {
      if (cancelled) return;
      setData({
        customers: c.customers || [],
        buckets:   bk.buckets   || [],
        keys:      k.keys       || [],
      });
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [open, loaded]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const out = [];
    for (const c of data.customers) {
      const hay = `${c.name||''} ${c.contactEmail||''} ${c.accountId||''} ${c.industry||''}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({ type: 'customer', label: c.name || c.accountId, sub: c.contactEmail || c.accountId, params: { customerId: c.id } });
      }
    }
    for (const b of data.buckets) {
      const hay = `${b.bucketName||''} ${b.bucketId||''}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({ type: 'bucket', label: b.bucketName, sub: b.bucketId, params: { bucketId: b.bucketId, accountId: b.accountId } });
      }
    }
    for (const k of data.keys) {
      const hay = `${k.keyName||''} ${k.applicationKeyId||''}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({ type: 'key', label: k.keyName, sub: k.applicationKeyId, params: { keyId: k.applicationKeyId } });
      }
    }
    return out.slice(0, 12);
  }, [query, data]);

  // Reset hover when the match list changes.
  useEffect(() => { setHover(0); }, [matches]);

  const pick = (m) => {
    setOpen(false);
    setQuery('');
    if (m.type === 'customer') navigate('customer-detail', m.params);
    else if (m.type === 'bucket') navigate('bucket-detail', m.params);
    else if (m.type === 'key') navigate('key-detail', m.params);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHover((h) => (h + 1) % matches.length); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHover((h) => (h - 1 + matches.length) % matches.length); }
    if (e.key === 'Enter')     { e.preventDefault(); pick(matches[hover]); }
  };

  const TYPE_COLOR = {
    customer: 'text-accent-violet',
    bucket:   'text-accent-teal',
    key:      'text-accent-amber',
  };

  return (
    <div ref={boxRef} className="relative">
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <input
        type="text"
        placeholder="Search buckets, customers, keys…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-8 w-72 rounded-md border border-ink-700 bg-ink-850 pl-8 pr-3 text-xs text-ink-100 placeholder:text-ink-400 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
      />
      {open && query.trim() && (
        <div className="absolute right-0 top-9 z-30 w-96 overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-xl">
          {!loaded && (
            <div className="p-3 text-[11px] text-ink-400">Loading index…</div>
          )}
          {loaded && matches.length === 0 && (
            <div className="p-3 text-[11px] text-ink-400">No matches for “{query}”.</div>
          )}
          <div className="max-h-96 overflow-y-auto">
            {matches.map((m, i) => (
              <button
                key={`${m.type}-${m.sub}-${i}`}
                onMouseDown={(e) => { e.preventDefault(); pick(m); }}
                onMouseEnter={() => setHover(i)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 border-b border-ink-800 px-3 py-2 text-left text-xs last:border-b-0',
                  i === hover ? 'bg-ink-850' : 'hover:bg-ink-850/60'
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink-100">{m.label}</div>
                  <div className="truncate font-mono text-[10.5px] text-ink-400">{m.sub}</div>
                </div>
                <span className={cx('text-[10px] uppercase tracking-wider', TYPE_COLOR[m.type])}>{m.type}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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
