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
import {
  getConfigPublic, getDecryptedConfigToken,
  getDecryptedAccountToken,
} from '../mcpStore.js';

const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 20000);

export class McpError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/**
 * Resolve { baseUrl, token, scope } for the *effective* session user.
 * - Partner staff (accountId == null, not impersonating) -> master token (full).
 * - Customer user, or staff impersonating a customer (effective accountId set)
 *   -> that account's scoped token. Absent -> 403 (fail closed; never master).
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

  if (accountId == null) {
    const token = getDecryptedConfigToken();
    if (!token) throw new McpError('MCP server has no token configured.', 503);
    return { baseUrl: cfg.baseUrl, token, scope: 'partner' };
  }

  const token = getDecryptedAccountToken(accountId);
  if (!token) {
    throw new McpError('No MCP access is configured for this account.', 403);
  }
  return { baseUrl: cfg.baseUrl, token, scope: `account:${accountId}` };
}

async function withClient(auth, fn) {
  const client = new Client(
    { name: 'neocloud-partner-portal', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(auth.baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
  });
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

/** Admin "Test connection" — uses an explicit URL + token, not the session. */
export async function testConnection({ baseUrl, token }) {
  if (!baseUrl) throw new McpError('Base URL is required.', 400);
  const auth = { baseUrl, token, scope: 'test' };
  return timeout(
    withClient(auth, async (client) => {
      const res = await client.listTools();
      return { ok: true, toolCount: (res.tools || []).length };
    }),
    REQUEST_TIMEOUT_MS, 'testConnection',
  );
}
