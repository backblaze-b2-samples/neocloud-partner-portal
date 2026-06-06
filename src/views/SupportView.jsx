import React, { useEffect, useState, useMemo } from 'react';
import { Eye, Search, AlertTriangle, Loader2 } from 'lucide-react';
import {
  PageHeader, Card, SourceBadge, LoadingState, ErrorState,
  Table, THead, TBody, TR, TH, TD,
} from '../components/ui.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { useApp } from '../lib/AppContext.jsx';
import { cx, shortDate, relativeTime } from '../lib/format.js';
import { CUSTOMERS } from '../data/customers.js';

const ROLE_LABEL = {
  customer_admin: 'Customer Admin',
  customer_readonly: 'Customer Read-only',
};

export default function SupportView() {
  const { isAdmin, isSupport, isLive } = useApp();
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/impersonate/targets')
      .then((d) => { if (!cancelled) setTargets(d.targets || []); })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError && e.status === 403
          ? 'You need admin or support access to use this tool.'
          : (e?.message || 'Could not load customer accounts.'));
      });
    return () => { cancelled = true; };
  }, []);

  if (!isAdmin && !isSupport) {
    return <ErrorState title="Forbidden" message="Admin or support role required." />;
  }

  const viewAs = async (u) => {
    if (!confirm(`Start a READ-ONLY impersonation as ${u.email}?\n\nAll write operations will be blocked until you exit impersonation.`)) return;
    setBusyId(u.id); setError('');
    try {
      await api.post('/api/impersonate/start', { targetUserId: u.id });
      // Reload so the customer shell mounts with the new effective role.
      window.location.assign('/');
    } catch (e) {
      setError((e instanceof ApiError && e.body?.error) || 'Could not start impersonation.');
      setBusyId(null);
    }
  };

  // "Usable" depends on the mode:
  //   live → user's accountId must have stored B2 credentials and not be ejected
  //   demo → user's accountId must match a customer in the demo dataset
  // The server already enriches each row with hasCredentials + ejected;
  // demo-customer membership is a client-only check because CUSTOMERS lives
  // in the bundle.
  const demoAccountIds = useMemo(
    () => new Set(CUSTOMERS.map((c) => c.accountId).filter(Boolean)),
    []
  );
  const isUsable = (u) => isLive
    ? (u.hasCredentials && !u.ejected)
    : demoAccountIds.has(u.accountId);

  const filtered = useMemo(() => {
    if (!targets) return null;
    const q = query.trim().toLowerCase();
    let list = targets;
    if (!showAll) list = list.filter(isUsable);
    if (q) {
      list = list.filter((u) =>
        (u.email || '').toLowerCase().includes(q) ||
        (u.accountId || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [targets, query, showAll, isLive]);

  const hiddenCount = useMemo(() => {
    if (!targets) return 0;
    return targets.filter((u) => !isUsable(u)).length;
  }, [targets, isLive]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Support"
        title="View as customer"
        subtitle="Start a read-only impersonation session to see exactly what a customer sees. All write operations are blocked until you exit. Each start/stop and any blocked write attempts are recorded in the audit log."
        actions={<SourceBadge source="api" />}
      />

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <Card padding="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[260px] flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by email or account id"
              className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 pl-8 pr-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show all targets {isLive ? '(including phantom + ejected accounts)' : '(including non-demo accounts)'}
            {hiddenCount > 0 && !showAll && (
              <span className="ml-1 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 ring-1 ring-ink-600">
                {hiddenCount} hidden
              </span>
            )}
          </label>
        </div>
      </Card>

      <Card padding="p-0">
        {filtered === null ? (
          <div className="p-8"><LoadingState label="Loading customer accounts" /></div>
        ) : filtered.length === 0 ? (
          <div className="space-y-3 p-8 text-center text-xs text-ink-400">
            {targets?.length === 0 ? (
              <p>No customer portal users exist yet.</p>
            ) : query ? (
              <p>No customers match &ldquo;{query}&rdquo;.</p>
            ) : hiddenCount > 0 && !showAll ? (
              isLive ? (
                <>
                  <p>
                    All {hiddenCount} existing customer user{hiddenCount === 1 ? ' is' : 's are'} tied to
                    accounts without stored B2 credentials (or ejected accounts), so impersonating them
                    in live mode would produce nothing useful.
                  </p>
                  <p className="text-ink-300">
                    To get a usable target, SSH to the API host and run:
                  </p>
                  <pre className="mx-auto inline-block rounded bg-ink-900 px-3 py-2 text-left font-mono text-[10.5px] text-ink-200 ring-1 ring-ink-700">
node server/seed-customer-logins.mjs --list{'\n'}
node server/seed-customer-logins.mjs &lt;accountId&gt;
                  </pre>
                  <p>
                    Or toggle &ldquo;Show all targets&rdquo; above to see them anyway.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {hiddenCount} existing customer user{hiddenCount === 1 ? ' is' : 's are'} tied to
                    accounts not in the demo dataset, so they won&apos;t show useful data in demo mode.
                  </p>
                  <p>
                    Switch to Live mode in the top bar to see customers tied to real B2 sub-accounts,
                    or toggle &ldquo;Show all targets&rdquo; to view them anyway.
                  </p>
                </>
              )
            ) : (
              <p>No customer accounts to impersonate.</p>
            )}
          </div>
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Account ID</TH>
                <TH>Created</TH>
                <TH>Last sign-in</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((u) => (
                <TR key={u.id} hover={false}>
                  <TD className="font-medium text-ink-100">
                    {u.email}
                    {u.ejected && (
                      <span className="ml-2 rounded bg-bb-red/10 px-1.5 py-0.5 text-[10px] text-bb-red ring-1 ring-bb-red/30">
                        account ejected
                      </span>
                    )}
                    {!u.hasCredentials && !u.ejected && (
                      <span className="ml-2 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 ring-1 ring-ink-600">
                        no credentials
                      </span>
                    )}
                  </TD>
                  <TD className="text-ink-300">{ROLE_LABEL[u.role] || u.role}</TD>
                  <TD className="font-mono text-[11px] text-ink-400">{u.accountId || '—'}</TD>
                  <TD className="text-ink-300">{shortDate(u.createdAt)}</TD>
                  <TD title={u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : ''} className="text-ink-300">
                    {u.lastLoginAt ? relativeTime(u.lastLoginAt) : '—'}
                  </TD>
                  <TD className="text-right">
                    <button
                      disabled={busyId === u.id}
                      onClick={() => viewAs(u)}
                      className={cx(
                        'inline-flex h-7 items-center gap-1 rounded-md border border-accent-amber/30 bg-accent-amber/10 px-2.5 text-[11px] font-medium text-accent-amber hover:bg-accent-amber/20',
                        busyId === u.id && 'opacity-60'
                      )}
                    >
                      {busyId === u.id
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Eye size={11} />}
                      View as
                    </button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
