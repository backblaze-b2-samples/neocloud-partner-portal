// @vitest-environment jsdom
//
// The command palette is a second route to every destination in the sidebar, so
// it has to apply the same permission filter. It previously did not — it was
// still matching on role names after the nav moved to permissions, which would
// have offered admin-only destinations to everyone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import React from 'react';

let user = { role: 'user', permissions: [] };
const navigate = vi.fn();

vi.mock('../../src/lib/AppContext.jsx', () => ({ useApp: () => ({ user }) }));
vi.mock('../../src/lib/nav.js', () => ({ useNav: () => ({ navigate, active: 'overview' }) }));
vi.mock('../../src/lib/apiClient.js', () => ({
  api: { get: vi.fn().mockResolvedValue({}) },
  ApiError: class ApiError extends Error {},
}));
// The palette prefetches entities on open; none of that is under test here.
vi.mock('../../src/api/partnerApi.js', () => ({
  getCustomers: vi.fn().mockResolvedValue({ customers: [] }),
}));
vi.mock('../../src/api/b2Adapter.js', () => ({
  listBuckets: vi.fn().mockResolvedValue({ buckets: [] }),
  listApplicationKeys: vi.fn().mockResolvedValue({ keys: [] }),
}));

const { CommandPalette } = await import('../../src/components/CommandPalette.jsx');

async function openPalette() {
  render(<CommandPalette />);
  await userEvent.keyboard('{Meta>}k{/Meta}');
}

beforeEach(() => { vi.clearAllMocks(); user = { role: 'user', permissions: [] }; });
afterEach(cleanup);

describe('permission filtering', () => {
  it('hides gated destinations from a user without the permission', async () => {
    await openPalette();
    await waitFor(() => expect(screen.queryByPlaceholderText(/jump to a page/i)).toBeInTheDocument());
    expect(screen.queryByText('User management')).not.toBeInTheDocument();
    expect(screen.queryByText('Roles & permissions')).not.toBeInTheDocument();
    expect(screen.queryByText('Audit log')).not.toBeInTheDocument();
  });

  it('offers a destination once its permission is held', async () => {
    user = { role: 'user', permissions: ['users:read', 'roles:read'] };
    await openPalette();
    await waitFor(() => expect(screen.queryByPlaceholderText(/jump to a page/i)).toBeInTheDocument());
    expect(screen.getByText('User management')).toBeInTheDocument();
    expect(screen.getByText('Roles & permissions')).toBeInTheDocument();
    expect(screen.queryByText('Audit log')).not.toBeInTheDocument();
  });

  it('still shows ungated destinations to everyone', async () => {
    await openPalette();
    await waitFor(() => expect(screen.queryByPlaceholderText(/jump to a page/i)).toBeInTheDocument());
    expect(screen.getByText('Executive overview')).toBeInTheDocument();
  });

  it('keeps the support carve-out for Settings', async () => {
    user = { role: 'support', permissions: ['impersonate:start'] };
    await openPalette();
    await waitFor(() => expect(screen.queryByPlaceholderText(/jump to a page/i)).toBeInTheDocument());
    expect(screen.queryByText('Settings & credentials')).not.toBeInTheDocument();
    expect(screen.getByText('View as customer')).toBeInTheDocument();
  });
});
