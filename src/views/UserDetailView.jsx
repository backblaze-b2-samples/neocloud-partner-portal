import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, ShieldCheck, Lock, Mail, Hash, Clock, Activity, AlertTriangle, ChevronRight,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge, LoadingState, ErrorState, Tag, Tabs,
  Table, THead, TBody, TR, TH, TD, EmptyState,
} from '../components/ui.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { useNav } from '../lib/nav.js';
import { useApp } from '../lib/AppContext.jsx';
import { cx, relativeTime, shortDate } from '../lib/format.js';

const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  user: 'User',
  support: 'Support',
  customer_admin: 'Customer Admin',
  customer_readonly: 'Customer Read-only',
};

const TABS = [
  { id: 'history',    label: 'Activity by this user' },
  { id: 'targeted',   label: 'Changes affecting this user' },
];

export default function UserDetailView({ userId }) {
  const { navigate } = useNav();
  const { isAdmin } = useApp();
  const [user, setUser] = useState(null);
  const [actorEntries, setActorEntries] = useState(null);
  const [targetEntries, setTargetEntries] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('history');

  const load = () => {
    setError('');
    setUser(null);
    setActorEntries(null);
    setTargetEntries(null);
    Promise.all([
      api.get(`/api/admin/users/${userId}`),
      api.get(`/api/admin/audit?actorId=${userId}&limit=200`),
      api.get(`/api/admin/audit?targetUserId=${userId}&limit=200`),
    ])
      .then(([u, asActor, asTarget]) => {
        setUser(u.user);
        setActorEntries(asActor.entries || []);
        setTargetEntries(asTarget.entries || []);
      })
      .catch((e) => {
        setError(e instanceof ApiError && e.status === 404
          ? 'User not found.'
          : e instanceof ApiError && e.status === 403
            ? 'Admin access required.'
            : (e?.message || 'Could not load user.'));
      });
  };

  useEffect(load, [userId]);

  if (!isAdmin) return <ErrorState title="Forbidden" message="Admin role required to view user details." />;
  if (error)    return <ErrorState title="Could not load user" message={error} onRetry={load} />;
  if (!user)    return <LoadingState label="Loading user" />;

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('users')}
        className="inline-flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100"
      >
        <ArrowLeft size={12} /> Back to User management
      </button>

      <PageHeader
        eyebrow="User"
        title={user.email}
        subtitle={`id ${user.id} · ${ROLE_LABELS[user.role] || user.role}${user.accountId ? ` · account ${user.accountId}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            {user.protected && (
              <Tag variant="warn"><Lock size={11} className="mr-0.5" /> protected</Tag>
            )}
            <Tag variant={user.active ? 'info' : undefined}>
              {user.active ? 'Active' : 'Inactive'}
            </Tag>
            {user.mustChangePassword && <Tag variant="warn">must reset</Tag>}
            <SourceBadge source="api" />
          </div>
        }
      />

      {/* Profile card */}
      <Card padding="p-5">
        <CardHeader title="Profile" icon={<ShieldCheck size={16} />} />
        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <KV icon={<Mail size={12} />} label="Email" value={user.email} />
          <KV icon={<ShieldCheck size={12} />} label="Role" value={ROLE_LABELS[user.role] || user.role} />
          <KV icon={<Hash size={12} />} label="Account ID" value={user.accountId || '—'} mono />
          <KV icon={<Clock size={12} />} label="Created"
              value={user.createdAt ? `${shortDate(user.createdAt)} (${relativeTime(user.createdAt)})` : '—'} />
          <KV icon={<Clock size={12} />} label="Updated"
              value={user.updatedAt ? relativeTime(user.updatedAt) : '—'} />
          <KV icon={<Clock size={12} />} label="Last sign-in"
              value={user.lastLoginAt ? relativeTime(user.lastLoginAt) : 'Never'} />
        </dl>
      </Card>

      {/* Activity tabs */}
      <Tabs
        tabs={[
          { ...TABS[0], count: actorEntries?.length ?? 0 },
          { ...TABS[1], count: targetEntries?.length ?? 0 },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'history'  && <ActivityTable entries={actorEntries}
                                            emptyLabel="This user has no recorded activity." />}
      {tab === 'targeted' && <ActivityTable entries={targetEntries}
                                            emptyLabel="No actions have been taken on this user." />}
    </div>
  );
}

function ActivityTable({ entries, emptyLabel }) {
  if (entries === null) return <LoadingState label="Loading audit entries" />;
  if (entries.length === 0) {
    return <EmptyState title="No activity" message={emptyLabel} icon={<Activity size={20} />} />;
  }
  return (
    <Card padding="p-0">
      <Table>
        <THead>
          <TR hover={false}>
            <TH>When</TH>
            <TH>Action</TH>
            <TH>Actor</TH>
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
              <TD>
                <span className="font-mono text-[10.5px] text-ink-200">{e.action}</span>
              </TD>
              <TD className="text-ink-300">{e.actor_email || (e.actor_id ? `#${e.actor_id}` : <em className="text-ink-500">system</em>)}</TD>
              <TD className="text-ink-300">{e.target_email || (e.target_user_id ? `#${e.target_user_id}` : '—')}</TD>
              <TD className="font-mono text-[11px] text-ink-400">{e.ip || '—'}</TD>
              <TD className="max-w-md text-[11px] text-ink-300">
                <DetailsCell raw={e.details} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function DetailsCell({ raw }) {
  if (!raw) return <span className="text-ink-500">—</span>;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return <span className="font-mono">{raw}</span>; }
  const pairs = Object.entries(parsed).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}=${val.length > 60 ? val.slice(0, 57) + '…' : val}`;
  });
  return <span className="font-mono" title={JSON.stringify(parsed, null, 2)}>{pairs.join('  ')}</span>;
}

function KV({ icon, label, value, mono }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-ink-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
        <div className={cx('text-ink-100', mono && 'font-mono text-[11.5px]')}>{value}</div>
      </div>
    </div>
  );
}
