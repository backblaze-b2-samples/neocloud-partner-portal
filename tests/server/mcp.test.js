// Tests for the MCP scope-resolution logic — the security heart of Feature B.
// Set the encryption key before importing modules that decrypt at call time.
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-32';

import { describe, it, expect, beforeAll } from 'vitest';
import { setConfig, upsertAccountToken, getConfigPublic } from '../../server/mcpStore.js';
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

describe('transport + custom-header auth mode', () => {
  it('bearer mode resolves an Authorization header + http transport', () => {
    setConfig({ baseUrl: 'https://mcp.example.com/mcp', enabled: true, transport: 'http', authMode: 'bearer', token: 'tok-xyz' });
    const a = resolveMcpAuth(staff);
    expect(a.transport).toBe('http');
    expect(a.authMode).toBe('bearer');
    expect(a.headers.Authorization).toBe('Bearer tok-xyz');
    expect(a.token).toBe('tok-xyz');
  });

  it('headers mode resolves the custom X-B2 headers + sse transport (no bearer)', () => {
    setConfig({
      baseUrl: 'https://mcp.backblazedemos.xyz/sse', enabled: true, transport: 'sse', authMode: 'headers',
      headers: { 'X-B2-Key-Id': 'kid', 'X-B2-Key': 'ksec', 'X-B2-App-Key-Id': 'akid', 'X-B2-App-Key': 'asec' },
    });
    const a = resolveMcpAuth(staff);
    expect(a.transport).toBe('sse');
    expect(a.authMode).toBe('headers');
    expect(a.headers['X-B2-Key-Id']).toBe('kid');
    expect(a.headers['X-B2-App-Key']).toBe('asec');
    expect(a.headers.Authorization).toBeUndefined();
    expect(a.token).toBeNull();
  });

  it('public config exposes header names (for display) but never values', () => {
    const cfg = getConfigPublic();
    expect(cfg.transport).toBe('sse');
    expect(cfg.authMode).toBe('headers');
    expect(cfg.headerNames).toContain('X-B2-Key-Id');
    expect(JSON.stringify(cfg)).not.toContain('ksec'); // no secret leakage
  });

  it('per-account header credentials scope to the customer', () => {
    upsertAccountToken({ accountId: 'acct-h', label: 'Acme', headers: { 'X-B2-Key-Id': 'acme-kid', 'X-B2-Key': 'acme-sec' } });
    const a = resolveMcpAuth({ user: { id: 9, role: 'customer_admin', accountId: 'acct-h' } });
    expect(a.scope).toBe('account:acct-h');
    expect(a.headers['X-B2-Key-Id']).toBe('acme-kid');
  });

  it('fails closed (503) when the stored blob does not match the auth mode', () => {
    // Store a bearer token, then flip the global mode to headers without re-entering.
    setConfig({ baseUrl: 'https://mcp.example.com/mcp', enabled: true, transport: 'http', authMode: 'bearer', token: 'plain-token' });
    setConfig({ enabled: true, authMode: 'headers' }); // no new credential
    expect(statusOf(() => resolveMcpAuth(staff))).toBe(503);
  });

  it('fails closed (does NOT leak header values as a Bearer token) on headers→bearer switch', () => {
    // Store secret headers, then flip global mode to bearer WITHOUT re-entering.
    setConfig({ baseUrl: 'https://mcp.example.com/sse', enabled: true, transport: 'sse', authMode: 'headers', headers: { 'X-B2-Key': 'SUPERSECRET', 'X-B2-Key-Id': 'kid' } });
    setConfig({ enabled: true, transport: 'http', authMode: 'bearer' }); // stale headers blob, no new token
    // Must throw (fail closed) rather than send Authorization: Bearer {…json…}.
    expect(statusOf(() => resolveMcpAuth(staff))).toBe(503);
    let leaked = null;
    try { leaked = JSON.stringify(resolveMcpAuth(staff).headers || {}); } catch { /* expected */ }
    expect(leaked).toBeNull(); // never built headers from the stale blob
  });

  it('per-account headers blob under bearer mode also fails closed', () => {
    setConfig({ baseUrl: 'https://mcp.example.com/mcp', enabled: true, transport: 'http', authMode: 'bearer', token: 'master-ok' });
    upsertAccountToken({ accountId: 'acct-mix', label: 'Mix', headers: { 'X-B2-Key': 'leakme' } });
    expect(statusOf(() => resolveMcpAuth({ user: { id: 7, role: 'customer_admin', accountId: 'acct-mix' } }))).toBe(503);
  });
});
