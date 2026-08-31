// =============================================================================
// AppContext — global state for mode (demo/live), B2 credentials, and the
// authenticated session.
// =============================================================================
// Auth is fully server-side: cookies (httpOnly, SameSite=Strict) hold the
// session; the client only knows the public profile returned by /api/auth/me.
// We deliberately do NOT cache the user in localStorage — refreshing the page
// re-fetches /me so a server-side logout takes effect everywhere.
// =============================================================================

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { storedTheme, resolveTheme, applyTheme, persistTheme } from './theme.js';
import { api, ApiError } from './apiClient.js';
import { isDemoEmail } from './format.js';
import { setTrainingEnabled } from './apiTrace.js';

const STORAGE_KEY = 'bb-neocloud-config';

const defaultConfig = {
  mode: 'demo',
  masterKeyId: '',
  masterApplicationKey: '',
  proxyUrl: '',
  reportsBucketName: '',   // e.g. "b2-reports-357e9d54ce31" — auto-discovered when blank
  defaultGroupId: 'neocloud-internal',
  trainingMode: false,     // when on, surface the real B2 API call behind each action
};

function load() {
  if (typeof window === 'undefined') return defaultConfig;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig;
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return defaultConfig;
  }
}

function persist(config) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore quota errors */
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [config, setConfig] = useState(load);
  const [user, setUser] = useState(null);
  const [impersonator, setImpersonator] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // Theme preference: 'light' | 'dark' | 'system'. index.html already applied
  // the right one before paint; this keeps React in step and handles changes.
  const [themePref, setThemePrefState] = useState(storedTheme);

  useEffect(() => { applyTheme(resolveTheme(themePref)); }, [themePref]);

  // Follow the OS while the preference is 'system' — someone on macOS auto
  // light/dark should see the portal turn over with everything else.
  useEffect(() => {
    if (themePref !== 'system') return;
    let mq;
    try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return; }
    const onChange = () => applyTheme(resolveTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  const setTheme = useCallback((pref) => {
    setThemePrefState(pref);
    persistTheme(pref);
  }, []);

  useEffect(() => {
    persist(config);
  }, [config]);

  // Keep the framework-agnostic trace recorder in sync with the toggle.
  useEffect(() => {
    setTrainingEnabled(!!config.trainingMode);
  }, [config.trainingMode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get('/api/auth/me');
        if (!cancelled) { setUser(me.user); setImpersonator(me.impersonator || null); }
      } catch {
        if (!cancelled) { setUser(null); setImpersonator(null); }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setMode = useCallback((mode) => {
    if (mode === 'live' && isDemoEmail(user?.email)) return;
    setConfig((c) => ({ ...c, mode }));
  }, [user]);

  const setCredentials = useCallback((creds) => {
    setConfig((c) => ({ ...c, ...creds }));
  }, []);

  const setTrainingMode = useCallback((on) => {
    setConfig((c) => ({ ...c, trainingMode: !!on }));
  }, []);

  const reset = useCallback(() => setConfig(defaultConfig), []);

  const login = useCallback(async (email, password) => {
    try {
      const res = await api.post('/api/auth/login', { email, password });
      setUser(res.user);
      return { ok: true, user: res.user };
    } catch (err) {
      const message = err instanceof ApiError && err.status === 429
        ? 'Too many attempts. Please wait and try again.'
        : 'Invalid email or password.';
      return { ok: false, error: message };
    }
  }, []);

  // Complete an SSO sign-in: swap the one-time code from the callback redirect
  // for a real session, then load the profile. The code is single-use and
  // expires in 60 seconds.
  const ssoExchange = useCallback(async (code) => {
    try {
      await api.post('/api/auth/sso/exchange', { code });
      const me = await api.get('/api/auth/me');
      setUser(me.user);
      setImpersonator(me.impersonator || null);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : 'Your sign-in link has expired. Please try again.',
      };
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
    setImpersonator(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.get('/api/auth/me');
      setUser(me.user);
      setImpersonator(me.impersonator || null);
      return me.user;
    } catch {
      setUser(null);
      setImpersonator(null);
      return null;
    }
  }, []);

  // Start/stop impersonation. Reloading the page forces the right shell
  // (CustomerShell vs Shell) to mount based on the new effective role.
  const stopImpersonation = useCallback(async () => {
    try { await api.post('/api/impersonate/stop'); } catch { /* ignore */ }
    window.location.assign('/');
  }, []);

  const isLive = config.mode === 'live';
  const hasCreds = !!(config.masterKeyId && config.masterApplicationKey);
  const canGoLive = hasCreds;

  const isSupport = user?.role === 'support';
  const isCustomerAdmin = user?.role === 'customer_admin';
  const isCustomerReadonly = user?.role === 'customer_readonly';
  const isCustomer = isCustomerAdmin || isCustomerReadonly;

  // Permission check. The server is always the real gate — this only decides
  // what to render, so a stale client can never grant access it doesn't have.
  const permissions = user?.permissions || [];
  const can = useCallback(
    (permission) => permissions.includes(permission),
    [permissions],
  );

  // Customer roles hold billing:read so they can see their OWN spend in the
  // customer shell; canSeeRevenue means partner-side revenue and margin, which
  // is a different thing. Keep the tenancy half of the condition.
  const canSeeRevenue = can('billing:read') && !isCustomer;
  const customerAccountId = isCustomer ? (user?.accountId || null) : null;

  const value = {
    config,
    isLive,
    hasCreds,
    canGoLive,
    trainingMode: !!config.trainingMode,
    setTrainingMode,
    setMode,
    setCredentials,
    reset,
    user,
    isAuthenticated: !!user,
    permissions,
    can,
    themePref,
    theme: resolveTheme(themePref),
    setTheme,
    isAdmin: user?.role === 'admin',
    isManagerOrAdmin: user?.role === 'admin' || user?.role === 'manager',
    isSupport,
    isCustomerAdmin,
    isCustomerReadonly,
    isCustomer,
    canSeeRevenue,
    customerAccountId,
    authReady,
    login,
    logout,
    ssoExchange,
    refreshUser,
    impersonator,
    isImpersonating: !!impersonator,
    stopImpersonation,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
