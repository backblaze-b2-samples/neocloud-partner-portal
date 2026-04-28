import React, { useState } from 'react';
import { LogIn, Mail, Lock, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { cx } from '../lib/format.js';

export default function LoginView() {
  const { login } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    const result = await login(email, password);
    if (!result.ok) setError(result.error);
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-950 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-bb-red shadow-glow">
            <span className="text-lg font-semibold text-white">B2</span>
          </div>
          <div className="text-center">
            <div className="text-base font-semibold text-ink-100">
              Backblaze<span className="text-bb-red">·</span>Neocloud
            </div>
            <div className="text-[11px] font-medium uppercase tracking-widest text-ink-400">
              Partner Portal
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-ink-700 bg-ink-850/80 p-6 shadow-card backdrop-blur-sm">
          <h1 className="text-lg font-semibold tracking-tight text-ink-100">Sign in</h1>
          <p className="mt-1 text-xs text-ink-300">
            Sign in with your portal account.
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
            <div>
              <label htmlFor="email" className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                Email
              </label>
              <div className="relative mt-1">
                <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  spellCheck={false}
                  autoCapitalize="none"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 pl-8 pr-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                Password
              </label>
              <div className="relative mt-1">
                <Lock size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 pl-8 pr-9 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-200"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={cx(
                'inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-bb-red text-sm font-medium text-white transition',
                submitting ? 'opacity-70' : 'hover:bg-bb-red/90'
              )}
            >
              <LogIn size={14} />
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
