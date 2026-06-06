// ⌘K command palette — global quick-nav + entity search. Mounted once inside
// the partner Shell (has NavContext). Press Cmd/Ctrl-K anywhere to open.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft, ArrowRight } from 'lucide-react';
import { cx } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import { useApp } from '../lib/AppContext.jsx';
import { NAV } from './Layout.jsx';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';

const TYPE_COLOR = {
  nav: 'text-ink-400',
  customer: 'text-accent-violet',
  bucket: 'text-accent-teal',
  key: 'text-accent-amber',
};

export function CommandPalette() {
  const { navigate } = useNav();
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState(0);
  const [data, setData] = useState({ customers: [], buckets: [], keys: [] });
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef(null);

  // Global Cmd/Ctrl-K toggle.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) { setQuery(''); setHover(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  // Lazy-load searchable entities on first open.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    Promise.all([
      partner.getCustomers().catch(() => ({ customers: [] })),
      b2.listBuckets().catch(() => ({ buckets: [] })),
      b2.listApplicationKeys().catch(() => ({ keys: [] })),
    ]).then(([c, bk, k]) => {
      if (cancelled) return;
      setData({ customers: c.customers || [], buckets: bk.buckets || [], keys: k.keys || [] });
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [open, loaded]);

  const navItems = useMemo(() => {
    const role = user?.role;
    return NAV.filter((n) => {
      if (n.requireRole) return n.requireRole === role;
      if (n.requireAnyRole) return n.requireAnyRole.includes(role);
      return true;
    });
  }, [user]);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    const out = [];
    // Nav commands (always shown; filtered by query)
    for (const n of navItems) {
      if (!q || n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)) {
        out.push({ type: 'nav', id: n.id, label: n.label, sub: `Go to · ${n.group}`, icon: n.icon });
      }
    }
    if (q) {
      for (const c of data.customers) {
        if (`${c.name || ''} ${c.contactEmail || ''} ${c.accountId || ''}`.toLowerCase().includes(q))
          out.push({ type: 'customer', label: c.name || c.accountId, sub: c.contactEmail || c.accountId, params: { customerId: c.id } });
      }
      for (const b of data.buckets) {
        if (`${b.bucketName || ''} ${b.bucketId || ''}`.toLowerCase().includes(q))
          out.push({ type: 'bucket', label: b.bucketName, sub: b.bucketId, params: { bucketId: b.bucketId, accountId: b.accountId } });
      }
      for (const k of data.keys) {
        if (`${k.keyName || ''} ${k.applicationKeyId || ''}`.toLowerCase().includes(q))
          out.push({ type: 'key', label: k.keyName, sub: k.applicationKeyId, params: { keyId: k.applicationKeyId } });
      }
    }
    return out.slice(0, 40);
  }, [query, data, navItems]);

  useEffect(() => { setHover(0); }, [query]);

  const pick = (m) => {
    setOpen(false);
    if (m.type === 'nav') navigate(m.id);
    else if (m.type === 'customer') navigate('customer-detail', m.params);
    else if (m.type === 'bucket') navigate('bucket-detail', m.params);
    else if (m.type === 'key') navigate('key-detail', m.params);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHover((h) => (h + 1) % results.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHover((h) => (h - 1 + results.length) % results.length); }
    if (e.key === 'Enter') { e.preventDefault(); pick(results[hover]); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-800 px-3">
          <Search size={16} className="text-ink-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page, customer, bucket, or key…"
            className="h-12 w-full bg-transparent text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
          <kbd className="rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-[10px] text-ink-400">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-ink-400">No matches.</div>
          ) : results.map((m, i) => {
            const Icon = m.icon;
            return (
              <button
                key={`${m.type}-${m.id || m.sub}-${i}`}
                onMouseEnter={() => setHover(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(m); }}
                className={cx('flex w-full items-center gap-3 px-3 py-2 text-left', i === hover ? 'bg-ink-850' : 'hover:bg-ink-850/60')}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ink-800 text-ink-300">
                  {Icon ? <Icon size={14} /> : <ArrowRight size={13} className={TYPE_COLOR[m.type]} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-100">{m.label}</span>
                  <span className="block truncate text-[11px] text-ink-500">{m.sub}</span>
                </span>
                {m.type !== 'nav' && <span className={cx('text-[10px] uppercase tracking-wider', TYPE_COLOR[m.type])}>{m.type}</span>}
                {i === hover && <CornerDownLeft size={13} className="text-ink-500" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-ink-800 px-3 py-1.5 text-[10px] text-ink-500">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
