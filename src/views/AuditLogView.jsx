import React, { useEffect, useState } from 'react';
import { Activity, Download, Filter, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  PageHeader, Card, SourceBadge, LoadingState, ErrorState,
  Table, THead, TBody, TR, TH, TD, MobileCardRow,
} from '../components/ui.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { useApp } from '../lib/AppContext.jsx';
import { useNav } from '../lib/nav.js';
import { relativeTime, cx } from '../lib/format.js';

const PAGE_SIZES = [25, 50, 100, 200];

export default function AuditLogView() {
  const { isAdmin } = useApp();
  const { navigate } = useNav();
  const [entries, setEntries] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const load = () => {
    setError('');
    setEntries(null);
    const qs = new URLSearchParams();
    if (actionFilter) qs.set('action', actionFilter);
    if (fromDate)     qs.set('fromDate', new Date(fromDate).toISOString());
    if (toDate) {
      // Treat the user's `toDate` as inclusive — bump to end of day.
      const d = new Date(toDate);
      d.setHours(23, 59, 59, 999);
      qs.set('toDate', d.toISOString());
    }
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));

    api.get(`/api/admin/audit?${qs.toString()}`)
      .then((d) => { setEntries(d.entries || []); setTotal(d.total || 0); })
      .catch((e) => {
        setError(e instanceof ApiError && e.status === 403
          ? 'Admin access required to view the audit log.'
          : (e?.message || 'Could not load audit log.'));
      });
  };

  useEffect(load, [actionFilter, fromDate, toDate, limit, offset]);

  // Reset pagination when filters change.
  useEffect(() => { setOffset(0); }, [actionFilter, fromDate, toDate, limit]);

  if (!isAdmin) {
    return <ErrorState title="Forbidden" message="Admin role required to view the audit log." />;
  }

  const downloadCsv = () => {
    const qs = new URLSearchParams();
    if (actionFilter) qs.set('action', actionFilter);
    if (fromDate)     qs.set('fromDate', new Date(fromDate).toISOString());
    if (toDate) {
      const d = new Date(toDate);
      d.setHours(23, 59, 59, 999);
      qs.set('toDate', d.toISOString());
    }
    window.location.href = `/api/admin/audit.csv?${qs.toString()}`;
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Audit log"
        subtitle="Every state-changing action — sign-ins, user updates, credential reveals, customer ejections, B2 mutations, authorization denials. Retention defaults to 365 days (configurable via AUDIT_RETENTION_DAYS)."
        actions={
          <div className="flex items-center gap-2">
            <SourceBadge source="api" />
            <button
              onClick={downloadCsv}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"
              title="Download filtered audit log as CSV (max 50k rows)"
            >
              <Download size={12} /> Export CSV
            </button>
          </div>
        }
      />

      {/* Filters */}
      <Card padding="p-4">
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <div>
            <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-ink-400">Action</label>
            <input
              type="text"
              placeholder="auth., user., customer_b2…"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="h-8 w-56 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-ink-400">From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-ink-400">To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-ink-400">Page size</label>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {(actionFilter || fromDate || toDate) && (
            <button
              onClick={() => { setActionFilter(''); setFromDate(''); setToDate(''); }}
              className="h-8 rounded-md border border-ink-700 bg-ink-850 px-3 text-[11px] text-ink-300 hover:text-ink-100"
            >
              Reset
            </button>
          )}
          <div className="ml-auto text-[11.5px] text-ink-400">
            {total.toLocaleString()} entries{actionFilter || fromDate || toDate ? ' (filtered)' : ''}
          </div>
        </div>
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <Card padding="p-0">
        {entries === null ? (
          <div className="p-8"><LoadingState label="Loading audit entries" /></div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-400">
            No audit entries match your filters.
          </div>
        ) : (
          <>
            {/* Desktop: full table */}
            <Table className="hidden lg:block">
              <THead>
                <TR hover={false}>
                  <TH>When</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Target</TH>
                  <TH>IP</TH>
                  <TH>Details</TH>
                </TR>
              </THead>
              <TBody>
                {entries.map((e) => (
                  <TR key={e.id} hover={false}>
                    <TD title={new Date(e.created_at).toLocaleString()} className="whitespace-nowrap text-ink-200">
                      {relativeTime(e.created_at)}
                    </TD>
                    <TD>{actorNode(e, navigate)}</TD>
                    <TD><ActionTag action={e.action} /></TD>
                    <TD className="text-ink-300">{targetNode(e, navigate)}</TD>
                    <TD className="font-mono text-[11px] text-ink-400">{e.ip || '—'}</TD>
                    <TD className="max-w-md">
                      <DetailsCell raw={e.details} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            {/* Mobile: stacked cards */}
            <div className="space-y-3 p-3 lg:hidden">
              {entries.map((e) => (
                <div key={e.id} className="rounded-lg border border-ink-800 bg-ink-900/40 p-3 text-xs">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <ActionTag action={e.action} />
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-400" title={new Date(e.created_at).toLocaleString()}>
                      {relativeTime(e.created_at)}
                    </span>
                  </div>
                  <MobileCardRow label="Actor">{actorNode(e, navigate)}</MobileCardRow>
                  <MobileCardRow label="Target">{targetNode(e, navigate)}</MobileCardRow>
                  <MobileCardRow label="IP"><span className="font-mono text-[11px] text-ink-400">{e.ip || '—'}</span></MobileCardRow>
                  {e.details && (
                    <div className="mt-2 break-words border-t border-ink-800 pt-2">
                      <DetailsCell raw={e.details} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {entries !== null && entries.length > 0 && (
          <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">
            <span>Page {currentPage} of {totalPages}</span>
            <div className="flex items-center gap-1">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className="inline-flex h-7 items-center rounded border border-ink-700 bg-ink-850 px-2 text-ink-300 hover:text-ink-100 disabled:opacity-40"
              >
                <ChevronLeft size={12} /> Prev
              </button>
              <button
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                className="inline-flex h-7 items-center rounded border border-ink-700 bg-ink-850 px-2 text-ink-300 hover:text-ink-100 disabled:opacity-40"
              >
                Next <ChevronRight size={12} />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// Actor / target cells — shared between the desktop table and mobile cards.
function actorNode(e, navigate) {
  if (!e.actor_email) return <span className="text-ink-500 italic">system</span>;
  return (
    <button
      onClick={() => navigate('user-detail', { userId: e.actor_id })}
      className="text-ink-100 hover:text-bb-red focus:outline-none"
    >
      {e.actor_email}
    </button>
  );
}
function targetNode(e, navigate) {
  if (e.target_email) {
    return (
      <button
        onClick={() => navigate('user-detail', { userId: e.target_user_id })}
        className="hover:text-bb-red focus:outline-none"
      >
        {e.target_email}
      </button>
    );
  }
  return <>{e.target_user_id ? `user #${e.target_user_id}` : '—'}</>;
}

function ActionTag({ action }) {
  // Color action prefixes so categories are visually distinct.
  const family = action.split('.')[0];
  const colors = {
    auth:           'text-accent-violet ring-accent-violet/30 bg-accent-violet/10',
    user:           'text-accent-teal   ring-accent-teal/30   bg-accent-teal/10',
    customer_user:  'text-accent-teal   ring-accent-teal/30   bg-accent-teal/10',
    credential:     'text-accent-amber  ring-accent-amber/30  bg-accent-amber/10',
    metadata:       'text-ink-200       ring-ink-600          bg-ink-700',
    customer_b2:    'text-accent-green  ring-accent-green/30  bg-accent-green/10',
    reseller_plan:  'text-ink-200       ring-ink-600          bg-ink-700',
    authz:          'text-bb-red        ring-bb-red/30        bg-bb-red/10',
    admin:          'text-accent-violet ring-accent-violet/30 bg-accent-violet/10',
    impersonation:  'text-accent-amber  ring-accent-amber/30  bg-accent-amber/10',
  };
  const cls = colors[family] || 'text-ink-300 ring-ink-700 bg-ink-800';
  return (
    <span className={cx('inline-flex rounded px-1.5 py-0.5 font-mono text-[10.5px] ring-1 ring-inset', cls)}>
      {action}
    </span>
  );
}

function DetailsCell({ raw }) {
  if (!raw) return <span className="text-ink-500">—</span>;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return <span className="font-mono text-[11px] text-ink-300">{raw}</span>; }
  // Render as a compact key=value list. Keeps the row height manageable.
  const pairs = Object.entries(parsed).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}=${val.length > 60 ? val.slice(0, 57) + '…' : val}`;
  });
  return (
    <span className="font-mono text-[11px] text-ink-300" title={JSON.stringify(parsed, null, 2)}>
      {pairs.join('  ')}
    </span>
  );
}
