// @vitest-environment jsdom
//
// The assignable-role list. The fallback matters: a user may hold users:write
// without roles:read, and an empty dropdown would make it impossible to create
// a user at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const get = vi.fn();
vi.mock('../../src/lib/apiClient.js', () => ({
  api: { get: (...a) => get(...a) },
  ApiError: class ApiError extends Error {},
}));

beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });
afterEach(cleanup);

async function freshHook() {
  // The module memoises across mounts, so reload it per test.
  const { useRoles } = await import('../../src/lib/useRoles.js');
  return renderHook(() => useRoles());
}

describe('useRoles', () => {
  it('returns the roles the server reports', async () => {
    get.mockResolvedValue({ roles: [{ id: 'ops', name: 'Operations', scope: 'partner' }] });
    const { result } = await freshHook();
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe('ops');
  });

  it('falls back to the built-ins when the caller may not read roles', async () => {
    get.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { result } = await freshHook();
    await waitFor(() => expect(result.current.length).toBeGreaterThan(1));
    const ids = result.current.map((r) => r.id);
    expect(ids).toContain('admin');
    expect(ids).toContain('customer_readonly');
  });

  it('falls back rather than rendering an empty dropdown', async () => {
    get.mockResolvedValue({ roles: [] });
    const { result } = await freshHook();
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
  });

  it('renders something usable on the very first paint', async () => {
    get.mockReturnValue(new Promise(() => {}));   // never settles
    const { result } = await freshHook();
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('fetches once and reuses the result across mounts', async () => {
    get.mockResolvedValue({ roles: [{ id: 'ops', name: 'Operations', scope: 'partner' }] });
    const { useRoles } = await import('../../src/lib/useRoles.js');
    const a = renderHook(() => useRoles());
    await waitFor(() => expect(a.result.current[0].id).toBe('ops'));
    renderHook(() => useRoles());
    expect(get).toHaveBeenCalledTimes(1);
  });
});
