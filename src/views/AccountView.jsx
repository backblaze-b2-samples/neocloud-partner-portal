import React, { useState } from 'react';
import { Lock, ShieldAlert, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { Card, CardHeader } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { cx } from '../lib/format.js';

export default function AccountView() {
  const { user, refreshUser } = useApp();
  const isDemo = user?.email?.endsWith('@demo.com');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(false);
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setError('Passwords do not match.'); return; }
    if (next === current) { setError('New password must differ from current.'); return; }
    setSubmitting(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setSuccess(true);
      setCurrent(''); setNext(''); setConfirm('');
      refreshUser();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401
        ? 'Current password is incorrect.'
        : 'Could not change password. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-100">My account</h1>
        <p className="mt-1 text-xs text-ink-300">
          Manage the password for your portal account.
        </p>
      </div>

      {user?.mustChangePassword && (
        <div className="flex items-start gap-2 rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>Your administrator has required you to set a new password before continuing.</span>
        </div>
      )}

      <Card>
        <CardHeader title="Profile" subtitle="The email shown here is private to your account." icon={<ShieldAlert size={16} />} />
        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <Field label="Email" value={user?.email || '—'} />
          <Field label="Role" value={user?.role || '—'} />
          <Field label="Account status" value={user?.active ? 'Active' : 'Inactive'} />
          <Field label="Last sign-in" value={user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'} />
        </dl>
      </Card>

      <Card>
        <CardHeader title="Change password" icon={<Lock size={16} />} />
        {isDemo ? (
          <div className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-800/50 px-3 py-2 text-xs text-ink-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>Password changes are not available for demo accounts.</span>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} />
            <PasswordField label="New password" autoComplete="new-password" value={next} onChange={setNext} />
            <PasswordField label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} />

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-start gap-2 rounded-md border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs text-accent-green">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> <span>Password updated.</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={cx(
                'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-bb-red px-4 text-sm font-medium text-white',
                submitting ? 'opacity-70' : 'hover:bg-bb-red/90'
              )}
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 text-sm text-ink-100">{value}</div>
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</span>
      <input
        type="password"
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
      />
    </label>
  );
}
