// Tests for the MCP scope-resolution logic — the security heart of Feature B.
// Set the encryption key before importing modules that decrypt at call time.
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-32';

import { describe, it, expect, beforeAll } from 'vitest';
import { setConfig, upsertAccountToken } from '../../server/mcpStore.js';
import { resolveMcpAuth, McpError } from '../../server/mcp/client.js';
import { db } from '../../server/db.js';

const staff = { user: { id: 1, role: 'admin', accountId: null } };
const cust1 = { user: { id: 2, role: 'customer_admin', accountId: 'acct-1' } };
const cust2 = { user: { id: 3, role: 'customer_readonly', accountId: 'acct-2' } };

function statusOf(fn) {
  try { fn(); return null; } catch (e) { return e instanceof McpError ? e.status : 'not-mcp-error'; }
}

beforeAll(() => {
  db.prepare('DELETE FROM mcp_account_tokens').run();
  db.prepare('DELETE FROM mcp_config').run();
});

describe('resolveMcpAuth scoping', () => {
  it('throws 503 when the server is not configured', () => {
    expect(statusOf(() => resolveMcpAuth(staff))).toBe(503);
  });

  it('partner staff resolve to the master token (full scope)', () => {
    setConfig({ baseUrl: 'https://mcp.example.com/mcp', enabled: true, token: 'master-tok' });
    const a = resolveMcpAuth(staff);
    expect(a.token).toBe('master-tok');
    expect(a.scope).toBe('partner');
  });

  it('a customer with a scoped token resolves to that token', () => {
    upsertAccountToken({ accountId: 'acct-1', label: 'Lumora', token: 'scoped-1' });
    const a = resolveMcpAuth(cust1);
    expect(a.token).toBe('scoped-1');
    expect(a.scope).toBe('account:acct-1');
  });

  it('a customer WITHOUT a scoped token is denied (403, fail-closed)', () => {
    expect(statusOf(() => resolveMcpAuth(cust2))).toBe(403);
  });

  it('never falls back to the master token for a customer', () => {
    let leaked = null;
    try { leaked = resolveMcpAuth(cust2).token; } catch { /* expected */ }
    expect(leaked).not.toBe('master-tok');
    expect(leaked).toBeNull();
  });

  it('a disabled connection throws 503 even with a token stored', () => {
    setConfig({ baseUrl: 'https://mcp.example.com/mcp', enabled: false });
    expect(statusOf(() => resolveMcpAuth(staff))).toBe(503);
  });
});
