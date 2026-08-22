// @vitest-environment jsdom
//
// The sign-in page, with SSO. Two things matter here and neither is covered by
// the server tests: that the SSO button only appears when the server says SSO
// is usable, and that a return trip from the identity provider is handled —
// code redeemed, failures explained in words, and the query string cleaned up
// so a refresh cannot replay it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';

// The component reaches for these; both are stubbed so nothing touches network.
const mockGet = vi.fn();
const ssoExchange = vi.fn();
const login = vi.fn();

vi.mock('../../src/lib/apiClient.js', () => ({
  api: { get: (...a) => mockGet(...a), post: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../src/lib/AppContext.jsx', () => ({
  useApp: () => ({ login, ssoExchange }),
}));

const { default: LoginView } = await import('../../src/views/LoginView.jsx');

function setUrl(search) {
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  setUrl('');
  mockGet.mockResolvedValue({ enabled: false });
  ssoExchange.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('the SSO button', () => {
  it('is absent when the server reports SSO disabled', async () => {
    render(<LoginView />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/auth/sso/status'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/sign in with your portal account/i)).toBeInTheDocument();
  });

  it('is absent when the status call fails, rather than breaking the page', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    render(<LoginView />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // The password form still works.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('appears with the operator-configured label when enabled', async () => {
    mockGet.mockResolvedValue({ enabled: true, buttonLabel: 'Sign in with Acme' });
    render(<LoginView />);
    const link = await screen.findByRole('link', { name: /sign in with acme/i });
    expect(link).toHaveAttribute('href', '/api/auth/sso/login');
    expect(screen.getByText(/or use a portal account/i)).toBeInTheDocument();
  });

  it('never hides the password form when SSO is on', async () => {
    mockGet.mockResolvedValue({ enabled: true, buttonLabel: 'SSO' });
    render(<LoginView />);
    await screen.findByRole('link', { name: /sso/i });
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });
});

describe('returning from the identity provider', () => {
  it('redeems a handoff code exactly once', async () => {
    setUrl('?sso=1&code=abc123');
    render(<LoginView />);
    await waitFor(() => expect(ssoExchange).toHaveBeenCalledWith('abc123'));
    expect(ssoExchange).toHaveBeenCalledTimes(1);
  });

  it('strips the code from the URL so a refresh cannot replay it', async () => {
    setUrl('?sso=1&code=abc123');
    render(<LoginView />);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('shows a plain-language reason when the exchange fails', async () => {
    setUrl('?sso=1&code=stale');
    ssoExchange.mockResolvedValue({ ok: false, error: 'Your sign-in link has expired. Please try again.' });
    render(<LoginView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
  });

  it('does nothing on a normal page load', async () => {
    render(<LoginView />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(ssoExchange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SSO failure messages', () => {
  // Each of these is a redirect the server can produce; the person at the
  // keyboard should learn who can fix it, not see a raw error code.
  const cases = [
    ['no_role', /not mapped to a portal role/i],
    ['account_conflict', /password account already exists/i],
    ['admin_not_allowed', /administrator role/i],
    ['no_email', /verified email/i],
    ['invalid_state', /took too long|reused/i],
    ['demo_account', /demo accounts/i],
    ['group_overage', /too many groups/i],
    ['discovery_failed', /could not reach/i],
    ['account_inactive', /deactivated/i],
    ['rate_limited', /too many sign-in attempts/i],
  ];

  it.each(cases)('explains %s', async (code, matcher) => {
    setUrl(`?sso=1&error=${code}`);
    render(<LoginView />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(matcher);
    expect(alert).not.toHaveTextContent(code);   // never surface the raw code
  });

  it('falls back gracefully on a reason it does not recognise', async () => {
    setUrl('?sso=1&error=something_new');
    render(<LoginView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/something_new/);
  });

  it('clears the error from the URL', async () => {
    setUrl('?sso=1&error=no_role');
    render(<LoginView />);
    await screen.findByRole('alert');
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('covers every error the SSO routes can emit', async () => {
    const fs = await import('node:fs');
    const routeSrc = fs.readFileSync('server/routes/sso.js', 'utf8');
    const viewSrc = fs.readFileSync('src/views/LoginView.jsx', 'utf8');
    const emitted = [...routeSrc.matchAll(/fail\(res,\s*'([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(5);
    for (const reason of new Set(emitted)) {
      expect(viewSrc, `LoginView has no message for '${reason}'`).toContain(`${reason}:`);
    }
  });
});
