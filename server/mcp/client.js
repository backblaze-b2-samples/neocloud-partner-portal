// =============================================================================
// MCP client — scope-aware bridge between portal sessions and the configured
// MCP server. The portal backend is the MCP *client*; it picks which token to
// attach based on the session, so customers can only reach their own scope.
//
// This is the seam a future agent re-uses: listTools(session) / callTool(...)
// take a session and inherit the same scoping for free.
// =============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getConfigPublic, getDecryptedConfigToken,
  getDecryptedAccountToken,
} from '../mcpStore.js';

const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 20000);

export class McpError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// A stored credential blob is either a bearer token (auth_mode 'bearer') or a
// JSON object of header name→value (auth_mode 'headers'). Turn it into the
// request headers the transport should send. Returns null if it can't (e.g. the
// blob doesn't match the current auth mode — fail closed).
function credentialToHeaders(raw, authMode) {
  if (!raw) return null;
  if (authMode === 'headers') {
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch { return null; }
  }
  return { Authorization: `Bearer ${raw}` };
}

/**
 * Resolve { baseUrl, transport, authMode, headers, token, scope } for the
 * *effective* session user.
 * - Partner staff (accountId == null, not impersonating) -> master credential.
 * - Customer user, or staff impersonating a customer (effective accountId set)
 *   -> that account's scoped credential. Absent -> 403 (fail closed).
 * Throws McpError on misconfiguration or missing scope.
 */
export function resolveMcpAuth(session) {
  const cfg = getConfigPublic();
  if (!cfg.enabled || !cfg.baseUrl) {
    throw new McpError('MCP server is not configured.', 503);
  }
  const user = session?.user;
  if (!user) throw new McpError('Unauthorized.', 401);

  // user.accountId is already the *effective* identity (impersonation swaps it).
  const accountId = user.accountId || null;
  const raw = accountId == null ? getDecryptedConfigToken() : getDecryptedAccountToken(accountId);
  if (!raw) {
    if (accountId == null) throw new McpError('MCP server has no credential configured.', 503);
    throw new McpError('No MCP access is configured for this account.', 403);
  }

  const headers = credentialToHeaders(raw, cfg.authMode);
  if (!headers) throw new McpError('MCP credential does not match the configured auth mode — re-enter it.', 503);

  return {
    baseUrl: cfg.baseUrl,
    transport: cfg.transport,
    authMode: cfg.authMode,
    headers,
    token: cfg.authMode === 'bearer' ? raw : null, // back-compat for callers/tests
    scope: accountId == null ? 'partner' : `account:${accountId}`,
  };
}

async function withClient(auth, fn) {
  const client = new Client(
    { name: 'neocloud-partner-portal', version: '1.0.0' },
    { capabilities: {} },
  );
  const url = new URL(auth.baseUrl);
  const opts = { requestInit: { headers: auth.headers || {} } };
  const transport = auth.transport === 'sse'
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts);
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
}

function timeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new McpError(`${label} timed out after ${ms}ms`, 504)), ms)),
  ]);
}

/** List tools available to this session (already scoped). */
export async function listTools(session) {
  const auth = resolveMcpAuth(session);
  return timeout(
    withClient(auth, async (client) => {
      const res = await client.listTools();
      return { scope: auth.scope, tools: res.tools || [] };
    }),
    REQUEST_TIMEOUT_MS, 'listTools',
  );
}

/** Invoke a tool as this session (already scoped). */
export async function callTool(session, name, args) {
  if (!name || typeof name !== 'string') throw new McpError('Tool name is required.', 400);
  const auth = resolveMcpAuth(session);
  return timeout(
    withClient(auth, async (client) => {
      const res = await client.callTool({ name, arguments: args || {} });
      return { scope: auth.scope, result: res };
    }),
    REQUEST_TIMEOUT_MS, 'callTool',
  );
}

/** Admin "Test connection" — uses an explicit URL + credential, not the session. */
export async function testConnection({ baseUrl, transport = 'http', authMode = 'bearer', token, headers }) {
  if (!baseUrl) throw new McpError('Base URL is required.', 400);
  const resolvedHeaders = authMode === 'headers'
    ? (headers && typeof headers === 'object' ? headers : {})
    : (token ? { Authorization: `Bearer ${token}` } : {});
  const auth = { baseUrl, transport, headers: resolvedHeaders, scope: 'test' };
  return timeout(
    withClient(auth, async (client) => {
      const res = await client.listTools();
      return { ok: true, toolCount: (res.tools || []).length };
    }),
    REQUEST_TIMEOUT_MS, 'testConnection',
  );
}
