// @vitest-environment jsdom
//
// The SSO settings card. This is where an operator points the portal at their
// identity provider, so the behaviours worth guaranteeing are: the client
// secret is never displayed, the redirect URI they must paste into their IdP is
// shown, the "allow admin from SSO" switch is presented with its consequence,
// and a read-only viewer cannot change anything.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import React from 'react';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../src/lib/apiClient.js', () => ({
  api: {
    get: (...a) => api.get(...a), post: (...a) => api.post(...a),
    put: (...a) => api.put(...a), delete: (...a) => api.delete(...a),
  },
  ApiError: class ApiError extends Error {
    constructor(msg, status, body) { super(msg); this.status = status; this.body = body; }
  },
}));
// SettingsView pulls in the B2 adapter at module scope; it is never exercised here.
vi.mock('../../src/api/b2Adapter.js', () => ({ testConnection: vi.fn() }));
vi.mock('../../src/lib/AppContext.jsx', () => ({
  useApp: () => ({
    config: {}, isLive: false, hasCreds: false, setMode: vi.fn(), setCredentials: vi.fn(),
    reset: vi.fn(), user: { email: 'a@b.c' }, trainingMode: false, setTrainingMode: vi.fn(),
    isAdmin: true, can: () => true,
  }),
}));

const { SsoCard } = await import('../../src/views/SettingsView.jsx');

const CONFIG = {
  enabled: true,
  issuerUrl: 'https://login.microsoftonline.com/tid/v2.0',
  clientId: 'client-abc',
  hasClientSecret: true,
  redirectUri: '',
  groupsClaim: 'groups',
  buttonLabel: 'Sign in with Acme',
  defaultRole: null,
  allowAdminRole: false,
};
const ROLES = [
  { id: 'admin', name: 'Administrator', scope: 'partner' },
  { id: 'support', name: 'Support', scope: 'partner' },
  { id: 'customer_admin', name: 'Customer administrator', scope: 'customer' },
];
const MAPPINGS = [
  { id: 1, groupValue: 'grp-ops', roleId: 'support', label: 'Ops', sortOrder: 0 },
  { id: 2, groupValue: 'grp-leads', roleId: 'admin', label: '', sortOrder: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((path) => {
    if (path === '/api/admin/sso/config') return Promise.resolve({ config: CONFIG });
    if (path === '/api/admin/sso/mappings') return Promise.resolve({ mappings: MAPPINGS });
    if (path === '/api/admin/roles') return Promise.resolve({ roles: ROLES });
    return Promise.reject(new Error('unexpected ' + path));
  });
});
afterEach(cleanup);

describe('rendering', () => {
  it('renders without crashing and shows the enabled state', async () => {
    render(<SsoCard canWrite />);
    expect(await screen.findByText(/single sign-on/i)).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('shows the stored issuer and client id', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    expect(screen.getByDisplayValue(CONFIG.issuerUrl)).toBeInTheDocument();
    expect(screen.getByDisplayValue('client-abc')).toBeInTheDocument();
  });

  it('never renders the client secret, only that one is stored', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    const secret = screen.getByPlaceholderText(/stored/i);
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('type', 'password');
    expect(screen.getByText(/leave blank to keep it/i)).toBeInTheDocument();
  });

  it('shows the redirect URI the operator must register with their provider', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    expect(screen.getByText(new RegExp(`${window.location.origin}/api/auth/sso/callback`))).toBeInTheDocument();
  });

  it('says that password sign-in always remains available', async () => {
    render(<SsoCard canWrite />);
    expect(await screen.findByText(/password sign-in always stays available/i)).toBeInTheDocument();
  });
});

describe('the allow-admin-role switch', () => {
  it('spells out the consequence rather than just labelling the toggle', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    expect(screen.getByText(/allow sso to grant the administrator role/i)).toBeInTheDocument();
    expect(screen.getByText(/anyone who can edit that group.*can grant full portal/i)).toBeInTheDocument();
  });

  it('is off when the stored config has it off', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    const box = screen.getByRole('checkbox', { name: /allow sso to grant the administrator role/i });
    expect(box).not.toBeChecked();
  });
});

describe('group mappings', () => {
  it('lists them in priority order with their resolved role names', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    expect(screen.getByText('grp-leads')).toBeInTheDocument();
    // Role names also appear as <option>s in the add-mapping select, so assert
    // on the list items rather than a bare text match.
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('grp-ops');
    expect(rows[0]).toHaveTextContent('Support');
    expect(rows[1]).toHaveTextContent('grp-leads');
    expect(rows[1]).toHaveTextContent('Administrator');
  });

  it('explains that order decides the outcome', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    expect(screen.getByText(/checked in order; the first group the user belongs to decides/i)).toBeInTheDocument();
  });

  it('only offers partner roles, since SSO cannot grant a tenant role', async () => {
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    const select = screen.getAllByRole('combobox').at(-1);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Administrator');
    expect(options).toContain('Support');
    expect(options).not.toContain('Customer administrator');
  });

  it('posts a new mapping', async () => {
    api.post.mockResolvedValue({ mapping: {} });
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    await userEvent.type(screen.getByPlaceholderText(/group id or name/i), 'grp-new');
    await userEvent.selectOptions(screen.getAllByRole('combobox').at(-1), 'support');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/admin/sso/mappings', expect.objectContaining({
      groupValue: 'grp-new', roleId: 'support',
    })));
  });

  it('reorders by sending the full new order', async () => {
    api.post.mockResolvedValue({ mappings: [] });
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    await userEvent.click(screen.getAllByLabelText(/move down/i)[0]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/admin/sso/mappings/reorder', { orderedIds: [2, 1] }));
  });

  it('deletes a mapping', async () => {
    api.delete.mockResolvedValue({ ok: true });
    render(<SsoCard canWrite />);
    await screen.findByText('grp-ops');
    await userEvent.click(screen.getAllByLabelText(/remove mapping/i)[0]);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/admin/sso/mappings/1'));
  });
});

describe('read-only viewer', () => {
  it('cannot save, test, or edit mappings', async () => {
    render(<SsoCard canWrite={false} />);
    await screen.findByText(/single sign-on/i);
    expect(screen.queryByRole('button', { name: /save sso settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /test discovery/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/remove mapping/i)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /allow sso to grant/i })).toBeDisabled();
  });
});

describe('saving', () => {
  it('clears the secret field after a successful save so it is not resubmitted', async () => {
    api.put.mockResolvedValue({ config: { ...CONFIG } });
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    const secret = screen.getByPlaceholderText(/stored/i);
    await userEvent.type(secret, 'rotated-secret');
    await userEvent.click(screen.getByRole('button', { name: /save sso settings/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].clientSecret).toBe('rotated-secret');
    await waitFor(() => expect(secret).toHaveValue(''));
  });

  it('surfaces a validation error from the server', async () => {
    const { ApiError } = await import('../../src/lib/apiClient.js');
    api.put.mockRejectedValue(new ApiError('bad', 400, { error: 'Issuer URL must be an HTTPS URL with a host' }));
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    await userEvent.click(screen.getByRole('button', { name: /save sso settings/i }));
    expect(await screen.findByText(/must be an HTTPS URL/i)).toBeInTheDocument();
  });

  it('reports the outcome of a discovery test', async () => {
    api.post.mockResolvedValue({ ok: true, issuer: 'https://login.microsoftonline.com/tid/v2.0' });
    render(<SsoCard canWrite />);
    await screen.findByText(/single sign-on/i);
    await userEvent.click(screen.getByRole('button', { name: /test discovery/i }));
    expect(await screen.findByText(/discovery succeeded/i)).toBeInTheDocument();
  });
});
