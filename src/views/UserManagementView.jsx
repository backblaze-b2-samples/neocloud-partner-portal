import React, { useEffect, useState, useCallback } from 'react';
import {
  ShieldCheck, UserPlus, KeyRound, Power, RefreshCcw,
  AlertTriangle, CheckCircle2, Copy, Loader2, Lock,
} from 'lucide-react';
import { Card, CardHeader, LoadingState } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { useNav } from '../lib/nav.js';
import { api, ApiError } from '../lib/apiClient.js';
import { cx, shortDate, relativeTime } from '../lib/format.js';
import { CUSTOMERS } from '../data/customers.js';

const ROLES = ['admin', 'manager', 'user', 'support', 'customer_admin', 'customer_readonly'];
const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  user: 'User',
  support: 'Support',
  customer_admin: 'Customer Admin',
  customer_readonly: 'Customer Read-only',
};

export default function UserManagementView() {
  const { isAdmin, user: me } = useApp();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [tempCred, setTempCred] = useState(null); // { email, tempPassword }
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    setError('');
    try {
      const data = await api.get('/api/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view this page.'
        : 'Could not load users.');
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <div className="flex items-start gap-2 text-sm text-ink-200">
            <AlertTriangle size={16} className="mt-0.5 text-bb-red" />
            <div>
              <div className="font-medium">Forbidden</div>
              <p className="mt-1 text-xs text-ink-400">You need administrator access to view this page.</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const onUpdate = async (id, body) => {
    setBusyId(id); setError('');
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      await reload();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Update failed.');
    } finally {
      setBusyId(null);
    }
  };

  const onResetPassword = async (u) => {
    if (!confirm(`Reset password for ${u.email}? The current session will be terminated.`)) return;
    setBusyId(u.id); setError('');
    try {
      const res = await api.post(`/api/admin/users/${u.id}/reset-password`);
      setTempCred({ email: u.email, tempPassword: res.tempPassword });
      await reload();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Reset failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-100">User management</h1>
          <p className="mt-1 text-xs text-ink-300">
            Create accounts, change roles, deactivate users, and force password resets.
          </p>
        </div>
        <button
          onClick={reload}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"
        >
          <RefreshCcw size={12} /> Refresh
        </button>
      </div>

      <CreateUserCard onCreated={reload} />

      {tempCred && (
        <Card className="border-accent-amber/40 bg-accent-amber/5">
          <CardHeader
            title="Temporary password"
            subtitle="Share this securely with the user. They will be required to change it on next sign-in."
            icon={<KeyRound size={16} />}
            action={
              <button
                onClick={() => setTempCred(null)}
                className="text-[11px] text-ink-300 hover:text-ink-100"
              >
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

      <UserSection
        title="Partner staff"
        icon={<ShieldCheck size={14} className="text-accent-green" />}
        users={users === null ? null : users.filter((u) => ['admin', 'manager', 'user', 'support'].includes(u.role))}
        loadingLabel="Loading users"
        emptyLabel="No partner staff."
        me={me}
        busyId={busyId}
        onUpdate={onUpdate}
        onResetPassword={onResetPassword}
      />

      <UserSection
        title="Customer portal users"
        icon={<ShieldCheck size={14} className="text-accent-teal" />}
        users={users === null ? null : users.filter((u) => ['customer_admin', 'customer_readonly'].includes(u.role))}
        loadingLabel="Loading users"
        emptyLabel="No customer portal users."
        me={me}
        busyId={busyId}
        onUpdate={onUpdate}
        onResetPassword={onResetPassword}
      />
    </div>
  );
}

function UserSection({ title, icon, users, loadingLabel, emptyLabel, me, busyId, onUpdate, onResetPassword }) {
  const { navigate } = useNav();
  return (
    <Card padding="p-0">
      <div className="border-b border-ink-700 px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink-100">
          {icon} {title}
        </div>
      </div>
      {users === null ? (
        <div className="p-5"><LoadingState label={loadingLabel} /></div>
      ) : users.length === 0 ? (
        <div className="p-5 text-xs text-ink-400">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-ink-900/50 text-[10px] uppercase tracking-wider text-ink-400">
              <tr>
                <Th>Email</Th><Th>Role</Th><Th>Account</Th><Th>Status</Th><Th>Created</Th><Th>Last sign-in</Th><Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u.id === me?.id;
                const busy = busyId === u.id;
                const protected_ = !!u.protected;
                return (
                  <tr key={u.id} className="border-t border-ink-800 text-ink-200">
                    <Td>
                      <button
                        onClick={() => navigate('user-detail', { userId: u.id })}
                        className="font-medium text-ink-100 hover:text-bb-red focus:outline-none"
                        title="View user detail + activity"
                      >
                        {u.email}
                      </button>
                      {isMe && <span className="ml-2 rounded bg-accent-violet/15 px-1.5 py-0.5 text-[10px] text-accent-violet">you</span>}
                      {protected_ && <span className="ml-2 inline-flex items-center gap-1 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 ring-1 ring-ink-600"><Lock size={9} /> protected</span>}
                      {u.mustChangePassword && <span className="ml-2 rounded bg-accent-amber/15 px-1.5 py-0.5 text-[10px] text-accent-amber">must reset</span>}
                    </Td>
                    <Td>
                      <select
                        disabled={busy || protected_}
                        value={u.role}
                        onChange={(e) => onUpdate(u.id, { role: e.target.value })}
                        className="h-7 rounded border border-ink-700 bg-ink-900 px-1.5 text-xs text-ink-100 focus:outline-none disabled:opacity-50"
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    </Td>
                    <Td className="font-mono text-[10.5px] text-ink-400">{u.accountId || '—'}</Td>
                    <Td>
                      <span className={cx(
                        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                        u.active
                          ? 'bg-accent-green/10 text-accent-green ring-accent-green/30'
                          : 'bg-ink-700 text-ink-300 ring-ink-600'
                      )}>{u.active ? 'Active' : 'Inactive'}</span>
                    </Td>
                    <Td>{shortDate(u.createdAt)}</Td>
                    <Td title={u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : ''}>
                      {u.lastLoginAt ? relativeTime(u.lastLoginAt) : '—'}
                    </Td>
                    <Td className="text-right">
                      {busy && <Loader2 size={12} className="ml-auto animate-spin text-ink-400" />}
                      {!busy && !protected_ && (
                        <div className="flex items-center justify-end gap-1.5">
                          <ActionBtn onClick={() => onUpdate(u.id, { mustChangePassword: !u.mustChangePassword })}>
                            {u.mustChangePassword ? 'Clear reset flag' : 'Force reset'}
                          </ActionBtn>
                          <ActionBtn onClick={() => onResetPassword(u)} icon={<KeyRound size={11} />}>Reset password</ActionBtn>
                          <ActionBtn
                            danger={u.active}
                            onClick={() => onUpdate(u.id, { active: !u.active })}
                            icon={<Power size={11} />}
                          >
                            {u.active ? 'Deactivate' : 'Reactivate'}
                          </ActionBtn>
                        </div>
                      )}
                      {!busy && protected_ && (
                        <span className="text-[10.5px] text-ink-500 italic">protected account</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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

function CreateUserCard({ onCreated }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      await api.post('/api/admin/users', { email: email.trim(), password, role, accountId: accountId.trim() || undefined });
      setEmail(''); setPassword(''); setRole('user'); setAccountId('');
      onCreated?.();
    } catch (err) {
      setError((err instanceof ApiError && err.body?.error) || 'Could not create user.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Create user" icon={<UserPlus size={16} />} />
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr,1.5fr,1fr,auto]">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          autoCapitalize="none"
          spellCheck={false}
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
        />
        <input
          type="text"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Initial password (8+ chars)"
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100"
        >
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button
          type="submit"
          disabled={submitting}
          className={cx(
            'inline-flex h-9 items-center justify-center rounded-md bg-bb-red px-4 text-sm font-medium text-white',
            submitting ? 'opacity-70' : 'hover:bg-bb-red/90'
          )}
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
        {['customer_admin', 'customer_readonly'].includes(role) && (
          <select
            required
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100 sm:col-span-4 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
          >
            <option value="">— Select customer account —</option>
            {CUSTOMERS.map((c) => (
              <option key={c.accountId} value={c.accountId}>
                {c.name} ({c.accountId})
              </option>
            ))}
          </select>
        )}
        {error && (
          <div role="alert" className="sm:col-span-4 flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
      </form>
    </Card>
  );
}
