// @vitest-environment jsdom
//
// The Roles admin screen. The behaviour worth pinning down is that a viewer
// with roles:read but not roles:write gets a read-only screen, that built-in
// roles cannot be deleted from the UI, that a role still held by users cannot
// be deleted, and that permissions the server silently drops are reported back
// rather than left looking saved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import React from 'react';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
let permissions = ['roles:read', 'roles:write'];

vi.mock('../../src/lib/apiClient.js', () => ({
  api: {
    get: (...a) => api.get(...a),
    post: (...a) => api.post(...a),
    put: (...a) => api.put(...a),
    delete: (...a) => api.delete(...a),
  },
  ApiError: class ApiError extends Error {
    constructor(msg, status, body) { super(msg); this.status = status; this.body = body; }
  },
}));
vi.mock('../../src/lib/AppContext.jsx', () => ({
  useApp: () => ({ can: (p) => permissions.includes(p) }),
}));

const { default: RolesView } = await import('../../src/views/RolesView.jsx');

const ROLES = [
  { id: 'admin', name: 'Administrator', description: 'Everything', scope: 'partner', builtIn: true, permissions: ['users:read', 'audit:read'], userCount: 2 },
  { id: 'auditor', name: 'Auditor', description: 'Reads the log', scope: 'partner', builtIn: false, permissions: ['audit:read'], userCount: 0 },
  { id: 'inuse', name: 'In use', description: '', scope: 'partner', builtIn: false, permissions: [], userCount: 3 },
];
const CATALOG = {
  permissions: ['users:read', 'audit:read', 'buckets:read'],
  groups: [
    { label: 'Portal users', permissions: ['users:read', 'audit:read'] },
    { label: 'Storage', permissions: ['buckets:read'] },
  ],
  labels: { 'users:read': 'View portal users', 'audit:read': 'View the audit log', 'buckets:read': 'Browse buckets' },
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions = ['roles:read', 'roles:write'];
  api.get.mockImplementation((path) => {
    if (path === '/api/admin/roles') return Promise.resolve({ roles: ROLES });
    if (path === '/api/admin/roles/permissions') return Promise.resolve(CATALOG);
    return Promise.reject(new Error('unexpected ' + path));
  });
});
afterEach(cleanup);

describe('listing', () => {
  it('lists every role with its scope, size, and holder count', async () => {
    render(<RolesView />);
    expect(await screen.findByText('Administrator')).toBeInTheDocument();
    expect(screen.getByText('Auditor')).toBeInTheDocument();
    expect(screen.getByText(/2 permissions/)).toBeInTheDocument();
    expect(screen.getAllByText('built-in')).toHaveLength(1);
  });

  it('shows a forbidden notice instead of the page when the API refuses', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));
    render(<RolesView />);
    expect(await screen.findByText(/forbidden/i)).toBeInTheDocument();
  });
});

describe('write permission gating', () => {
  it('offers creation and saving to a roles:write holder', async () => {
    render(<RolesView />);
    expect(await screen.findByRole('button', { name: /new role/i })).toBeInTheDocument();
  });

  it('hides every mutation control from a read-only viewer', async () => {
    permissions = ['roles:read'];
    render(<RolesView />);
    await screen.findByText('Auditor');
    expect(screen.queryByRole('button', { name: /new role/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Auditor'));
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('renders the permission checkboxes disabled for a read-only viewer', async () => {
    permissions = ['roles:read'];
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByText('Auditor'));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b).toBeDisabled();
  });
});

describe('editing a role', () => {
  it('reflects the selected role\'s current permissions', async () => {
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByText('Auditor'));
    const audit = screen.getByRole('checkbox', { name: /audit:read/ });
    const users = screen.getByRole('checkbox', { name: /users:read/ });
    expect(audit).toBeChecked();
    expect(users).not.toBeChecked();
  });

  it('warns that a built-in role cannot be deleted, and offers no delete button', async () => {
    render(<RolesView />);
    await screen.findByText('Administrator');
    await userEvent.click(screen.getByText('Administrator'));
    expect(screen.getByText(/built-in role/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('disables delete for a role that users still hold, and says why', async () => {
    render(<RolesView />);
    await screen.findByText('In use');
    await userEvent.click(screen.getByText('In use'));
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', expect.stringMatching(/reassign/i));
  });

  it('sends only the editable fields when saving', async () => {
    api.put.mockResolvedValue({ role: { ...ROLES[1] }, rejected: [] });
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByText('Auditor'));
    await userEvent.click(screen.getByRole('checkbox', { name: /users:read/ }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [path, body] = api.put.mock.calls[0];
    expect(path).toBe('/api/admin/roles/auditor');
    expect(body.permissions).toContain('users:read');
    expect(body).not.toHaveProperty('scope');   // scope is immutable after creation
  });

  it('reports permissions the server dropped instead of implying they saved', async () => {
    api.put.mockResolvedValue({ role: { ...ROLES[1] }, rejected: ['settings:write'] });
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByText('Auditor'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/1 permission\(s\) were not applicable/i)).toBeInTheDocument();
  });

  it('surfaces a server error rather than claiming success', async () => {
    const { ApiError } = await import('../../src/lib/apiClient.js');
    api.put.mockRejectedValue(new ApiError('Role is referenced by 2 SSO group mapping(s).', 409, {}));
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByText('Auditor'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/SSO group mapping/i)).toBeInTheDocument();
  });
});

describe('creating a role', () => {
  it('asks for an id and scope, which existing roles do not expose', async () => {
    render(<RolesView />);
    await screen.findByText('Auditor');

    await userEvent.click(screen.getByText('Auditor'));
    expect(screen.queryByLabelText(/role id/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /new role/i }));
    expect(screen.getByLabelText(/role id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/scope/i)).toBeInTheDocument();
  });

  it('restricts the checkboxes to what a customer-scope role may hold', async () => {
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByRole('button', { name: /new role/i }));

    // Partner scope offers the partner-only permission...
    expect(screen.getByRole('checkbox', { name: /users:read/ })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/scope/i), 'customer');
    // ...customer scope does not, because the server would drop it anyway.
    expect(screen.queryByRole('checkbox', { name: /audit:read/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /buckets:read/ })).toBeInTheDocument();
  });

  it('posts the new role', async () => {
    api.post.mockResolvedValue({ role: { id: 'newrole', name: 'New', scope: 'partner', builtIn: false, permissions: [], userCount: 0, description: '' }, rejected: [] });
    render(<RolesView />);
    await screen.findByText('Auditor');
    await userEvent.click(screen.getByRole('button', { name: /new role/i }));
    await userEvent.type(screen.getByLabelText(/role id/i), 'newrole');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New');
    await userEvent.click(screen.getByRole('button', { name: /create role/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ id: 'newrole', name: 'New', scope: 'partner' });
  });
});
