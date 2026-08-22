import React, { useState, useEffect } from 'react';
import { LogIn, Mail, Lock, Eye, EyeOff, AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/apiClient.js';
import { cx } from '../lib/format.js';

// Reasons the SSO callback can bounce back to the login page. Phrased for the
// person at the keyboard: each one says who can fix it.
const SSO_ERRORS = {
  invalid_state:     'Sign-in took too long or the link was reused. Please try again.',
  missing_params:    'Your identity provider did not complete the sign-in. Please try again.',
  discovery_failed:  'Could not reach your identity provider. Contact your administrator.',
  token_error:       'Your identity could not be verified. Contact your administrator.',
  no_email:          'Your identity provider did not supply a verified email address.',
  no_role:           'Your groups are not mapped to a portal role. Contact your administrator.',
  group_overage:     'Your identity provider did not send your group memberships because you belong to too many groups. Contact your administrator.',
  invalid_role:      'The role mapped to your group is no longer valid. Contact your administrator.',
  admin_not_allowed: 'Your group maps to the administrator role, which this portal does not accept from SSO. Contact your administrator.',
  account_conflict:  'A password account already exists for this address. Ask an administrator to convert it to SSO.',
  account_inactive:  'Your portal account is deactivated. Contact your administrator.',
  demo_account:      'Demo accounts cannot sign in with SSO.',
  sso_disabled:      'SSO is not enabled for this portal.',
  rate_limited:      'Too many sign-in attempts. Wait a few minutes and try again.',
};

export default function LoginView() {
  const { login, ssoExchange } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sso, setSso] = useState({ enabled: false, buttonLabel: 'Sign in with SSO' });
  const [completingSso, setCompletingSso] = useState(false);

  // Handle a return trip from the identity provider. The callback redirects to
  // /?sso=1 with either a one-time code or a reason it failed. Either way the
  // query is stripped afterwards so a refresh doesn't replay it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sso') !== '1') return;

    const clearQuery = () => window.history.replaceState({}, '', window.location.pathname);
    const code = params.get('code');
    const failure = params.get('error');

    if (code) {
      setCompletingSso(true);
      ssoExchange(code).then((res) => {
        if (!res.ok) { setError(res.error); setCompletingSso(false); }
        clearQuery();   // on success the app re-renders authenticated
      });
      return;
    }
    if (failure) {
      setError(SSO_ERRORS[failure] || `Sign-in failed (${failure}).`);
      clearQuery();
    }
  }, [ssoExchange]);

  // Is SSO offered? Unauthenticated and deliberately uninformative when off.
  useEffect(() => {
    let cancelled = false;
    api.get('/api/auth/sso/status')
      .then((s) => { if (!cancelled && s?.enabled) setSso({ enabled: true, buttonLabel: s.buttonLabel }); })
      .catch(() => { /* SSO simply stays hidden */ });
    return () => { cancelled = true; };
  }, []);

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
            {sso.enabled ? 'Use your organisation account, or sign in with a portal account.' : 'Sign in with your portal account.'}
          </p>

          {sso.enabled && (
            <div className="mt-5">
              <a
                href="/api/auth/sso/login"
                className={cx(
                  'inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-ink-600 bg-ink-800 text-sm font-medium text-ink-100 transition hover:border-bb-red/50 hover:bg-ink-750',
                  completingSso && 'pointer-events-none opacity-60'
                )}
              >
                <KeyRound size={14} />
                {sso.buttonLabel}
              </a>
              <div className="mt-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-ink-700" />
                <span className="text-[11px] text-ink-400">or use a portal account</span>
                <span className="h-px flex-1 bg-ink-700" />
              </div>
            </div>
          )}

          {completingSso && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs text-ink-300">
              <Loader2 size={14} className="animate-spin" />
              Completing sign-in…
            </div>
          )}

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
