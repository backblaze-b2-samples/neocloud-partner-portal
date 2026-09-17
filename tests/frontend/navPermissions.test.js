// Which navigation entries a user can see, by permission.
//
// This is presentation only — every view behind these entries is independently
// gated server-side — but it is the layer that decides whether an admin-only
// destination is even rendered into the DOM, so it is worth pinning down.
import { describe, it, expect } from 'vitest';
import { navFor, NAV } from '../../src/components/Layout.jsx';

const user = (permissions, role = 'user') => ({ role, permissions });
const ids = (u) => navFor(u).map((n) => n.id);

describe('navFor', () => {
  it('shows nothing without a user', () => {
    expect(navFor(null)).toEqual([]);
  });

  it('omits gated entries rather than disabling them', () => {
    const visible = ids(user([]));
    expect(visible).not.toContain('users');
    expect(visible).not.toContain('roles');
    expect(visible).not.toContain('audit');
    expect(visible).not.toContain('support');
  });

  it('still shows the ungated entries to everyone', () => {
    const visible = ids(user([]));
    expect(visible).toContain('overview');
    expect(visible).toContain('storage');
    expect(visible).toContain('account');
  });

  it('reveals each administration entry only with its own permission', () => {
    expect(ids(user(['users:read']))).toContain('users');
    expect(ids(user(['users:read']))).not.toContain('audit');

    expect(ids(user(['audit:read']))).toContain('audit');
    expect(ids(user(['audit:read']))).not.toContain('users');

    expect(ids(user(['roles:read']))).toContain('roles');
    expect(ids(user(['impersonate:start']))).toContain('support');
  });

  it('gives an admin every gated entry', () => {
    const all = NAV.filter((n) => n.requirePermission).map((n) => n.requirePermission);
    const visible = ids(user(all, 'admin'));
    for (const n of NAV.filter((x) => x.requirePermission)) {
      expect(visible, `expected ${n.id} to be visible`).toContain(n.id);
    }
  });

  it('keeps the pre-existing carve-out that support does not see Settings', () => {
    expect(ids(user(['impersonate:start'], 'support'))).not.toContain('settings');
    expect(ids(user(['impersonate:start'], 'user'))).toContain('settings');
  });

  it('tolerates a user object with no permissions array', () => {
    expect(() => navFor({ role: 'user' })).not.toThrow();
    expect(navFor({ role: 'user' }).map((n) => n.id)).not.toContain('users');
  });

  it('every gated NAV entry names a permission that exists in the catalog', async () => {
    const { ALL_PERMISSIONS } = await import('../../server/rbac.js');
    for (const n of NAV.filter((x) => x.requirePermission)) {
      expect(ALL_PERMISSIONS, `${n.id} -> ${n.requirePermission}`).toContain(n.requirePermission);
    }
  });
});
