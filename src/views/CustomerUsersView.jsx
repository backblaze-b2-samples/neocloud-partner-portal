import React, { useEffect, useState, useCallback } from 'react';
import {
  Users, UserPlus, KeyRound, Power, RefreshCcw,
  AlertTriangle, CheckCircle2, Copy, Loader2,
} from 'lucide-react';
import { Card, CardHeader, LoadingState, MobileCardRow } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { cx, relativeTime } from '../lib/format.js';

const CUSTOMER_ROLES = ['customer_admin', 'customer_readonly'];
const ROLE_LABELS = {
  customer_admin: 'Admin',
  customer_readonly: 'Read-only',
};

export default function CustomerUsersView() {
  const { isCustomerAdmin, user: me } = useApp();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [tempCred, setTempCred] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    setError('');
    try {
      const data = await api.get('/api/customer-admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to manage users.'
        : 'Could not load users.');
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (!isCustomerAdmin) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <div className="flex items-start gap-2 text-sm text-ink-200">
            <AlertTriangle size={16} className="mt-0.5 text-bb-red" />
            <div>
              <div className="font-medium">Access restricted</div>
              <p className="mt-1 text-xs text-ink-400">Only account administrators can manage team members.</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const onUpdate = async (id, body) => {
    setBusyId(id); setError('');
    try {
      await api.patch(`/api/customer-admin/users/${id}`, body);
      await reload();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Update failed.');
    } finally {
      setBusyId(null);
    }
  };

  const onResetPassword = async (u) => {
    if (!confirm(`Reset password for ${u.email}?`)) return;
    setBusyId(u.id); setError('');
    try {
      const res = await api.post(`/api/customer-admin/users/${u.id}/reset-password`);
      setTempCred({ email: u.email, tempPassword: res.tempPassword });
      await reload();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Reset failed.');
    } finally {
      setBusyId(null);
    }
  };

  // Cell renderers shared between the desktop table and the mobile card list.
  const emailCell = (u) => {
    const isMe = u.id === me?.id;
    return (
      <>
        <span className="font-medium text-ink-100">{u.email}</span>
        {isMe && <span className="ml-2 rounded bg-accent-violet/15 px-1.5 py-0.5 text-[10px] text-accent-violet">you</span>}
        {u.mustChangePassword && <span className="ml-2 rounded bg-accent-amber/15 px-1.5 py-0.5 text-[10px] text-accent-amber">must reset</span>}
      </>
    );
  };
  const roleSelect = (u) => (
    <select
      disabled={busyId === u.id || u.id === me?.id}
      value={u.role}
      onChange={(e) => onUpdate(u.id, { role: e.target.value })}
      className="h-8 rounded border border-ink-700 bg-ink-900 px-1.5 text-xs text-ink-100 focus:outline-none disabled:opacity-50 lg:h-7"
    >
      {CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  );
  const statusBadge = (u) => (
    <span className={cx(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
      u.active
        ? 'bg-accent-green/10 text-accent-green ring-accent-green/30'
        : 'bg-ink-700 text-ink-300 ring-ink-600'
    )}>{u.active ? 'Active' : 'Inactive'}</span>
  );
  const actionButtons = (u) => (
    <>
      <ActionBtn onClick={() => onResetPassword(u)} icon={<KeyRound size={11} />}>Reset password</ActionBtn>
      <ActionBtn
        danger={u.active}
        onClick={() => onUpdate(u.id, { active: !u.active })}
        icon={<Power size={11} />}
      >
        {u.active ? 'Deactivate' : 'Reactivate'}
      </ActionBtn>
    </>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-100">My team</h1>
          <p className="mt-1 text-xs text-ink-300">
            Manage portal access for your account. You can add team members with admin or read-only access.
          </p>
        </div>
        <button
          onClick={reload}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"
        >
          <RefreshCcw size={12} /> Refresh
        </button>
      </div>

      <CreateTeamMemberCard onCreated={reload} />

      {tempCred && (
        <Card className="border-accent-amber/40 bg-accent-amber/5">
          <CardHeader
            title="Temporary password"
            subtitle="Share this securely. The user will be required to change it on first sign-in."
            icon={<KeyRound size={16} />}
            action={
              <button onClick={() => setTempCred(null)} className="text-[11px] text-ink-300 hover:text-ink-100">
                Dismiss
              </button>
            }
          />
          <CopyRow label="Email" value={tempCred.email} />
          <CopyRow label="Password" value={tempCred.tempPassword} mono />
        </Card>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <Card padding="p-0">
        <div className="border-b border-ink-700 px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-100">
            <Users size={14} className="text-accent-green" /> Team members
          </div>
        </div>
        {users === null ? (
          <div className="p-5"><LoadingState label="Loading team" /></div>
        ) : users.length === 0 ? (
          <div className="p-5 text-xs text-ink-400">No team members yet.</div>
        ) : (
          <>
            {/* Desktop: full table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-xs">
                <thead className="bg-ink-900/50 text-[10px] uppercase tracking-wider text-ink-400">
                  <tr>
                    <Th>Email</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isMe = u.id === me?.id;
                    const busy = busyId === u.id;
                    return (
                      <tr key={u.id} className="border-t border-ink-800 text-ink-200">
                        <Td>{emailCell(u)}</Td>
                        <Td>{roleSelect(u)}</Td>
                        <Td>{statusBadge(u)}</Td>
                        <Td title={u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : ''}>
                          {u.lastLoginAt ? relativeTime(u.lastLoginAt) : '—'}
                        </Td>
                        <Td className="text-right">
                          {busy && <Loader2 size={12} className="ml-auto animate-spin text-ink-400" />}
                          {!busy && !isMe && (
                            <div className="flex items-center justify-end gap-1.5">{actionButtons(u)}</div>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: stacked cards */}
            <div className="space-y-3 p-3 lg:hidden">
              {users.map((u) => {
                const isMe = u.id === me?.id;
                const busy = busyId === u.id;
                return (
                  <div key={u.id} className="rounded-lg border border-ink-800 bg-ink-900/40 p-3 text-xs text-ink-200">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">{emailCell(u)}</div>
                      {statusBadge(u)}
                    </div>
                    <MobileCardRow label="Role">{roleSelect(u)}</MobileCardRow>
                    <MobileCardRow label="Last sign-in">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : '—'}</MobileCardRow>
                    {!isMe && (
                      <div className="mt-2 border-t border-ink-800 pt-2">
                        {busy
                          ? <Loader2 size={14} className="animate-spin text-ink-400" />
                          : <div className="flex flex-wrap items-center gap-1.5">{actionButtons(u)}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Th({ children, className }) {
  return <th className={cx('px-4 py-2.5 font-semibold', className)}>{children}</th>;
}
function Td({ children, className }) {
  return <td className={cx('px-4 py-2.5 align-middle', className)}>{children}</td>;
}
function ActionBtn({ children, onClick, icon, danger }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition',
        danger
          ? 'border-bb-red/30 bg-bb-red/10 text-bb-red hover:bg-bb-red/20'
          : 'border-ink-700 bg-ink-850 text-ink-200 hover:bg-ink-800'
      )}
    >
      {icon}{children}
    </button>
  );
}
function CopyRow({ label, value, mono }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <div className="w-20 text-ink-400">{label}</div>
      <code className={cx('flex-1 select-all rounded bg-ink-900 px-2 py-1 text-ink-100', mono && 'font-mono')}>{value}</code>
      <button
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
      >
        {copied ? <CheckCircle2 size={11} className="text-accent-green" /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
function CreateTeamMemberCard({ onCreated }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('customer_readonly');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      await api.post('/api/customer-admin/users', { email: email.trim(), password, role });
      setEmail(''); setPassword(''); setRole('customer_readonly');
      onCreated?.();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Could not create user.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Add team member" icon={<UserPlus size={16} />} />
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr,1.5fr,1fr,auto]">
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com" autoCapitalize="none" spellCheck={false}
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40" />
        <input type="text" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Initial password (8+ chars)"
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40" />
        <select value={role} onChange={(e) => setRole(e.target.value)}
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100">
          {CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button type="submit" disabled={submitting}
          className={cx('inline-flex h-9 items-center justify-center rounded-md bg-bb-red px-4 text-sm font-medium text-white', submitting ? 'opacity-70' : 'hover:bg-bb-red/90')}>
          {submitting ? 'Adding…' : 'Add'}
        </button>
        {error && (
          <div role="alert" className="sm:col-span-4 flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
      </form>
    </Card>
  );
}
