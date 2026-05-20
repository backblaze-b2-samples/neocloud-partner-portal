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
import { api, ApiError } from './apiClient.js';
import { isDemoEmail } from './format.js';

const STORAGE_KEY = 'bb-neocloud-config';

const defaultConfig = {
  mode: 'demo',
  masterKeyId: '',
  masterApplicationKey: '',
  proxyUrl: '',
  reportsBucketName: '',   // e.g. "b2-reports-357e9d54ce31" — auto-discovered when blank
  defaultGroupId: 'neocloud-internal',
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
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    persist(config);
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get('/api/auth/me');
        if (!cancelled) setUser(me.user);
      } catch {
        if (!cancelled) setUser(null);
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

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.get('/api/auth/me');
      setUser(me.user);
      return me.user;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  const isLive = config.mode === 'live';
  const hasCreds = !!(config.masterKeyId && config.masterApplicationKey);
  const canGoLive = hasCreds;

  const isSupport = user?.role === 'support';
  const isCustomerAdmin = user?.role === 'customer_admin';
  const isCustomerReadonly = user?.role === 'customer_readonly';
  const isCustomer = isCustomerAdmin || isCustomerReadonly;
  const canSeeRevenue = ['admin', 'manager', 'user'].includes(user?.role);
  const customerAccountId = isCustomer ? (user?.accountId || null) : null;

  const value = {
    config,
    isLive,
    hasCreds,
    canGoLive,
    setMode,
    setCredentials,
    reset,
    user,
    isAuthenticated: !!user,
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
    refreshUser,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
