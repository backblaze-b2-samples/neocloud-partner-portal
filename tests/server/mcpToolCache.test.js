// Tests for MCP tool-list caching + graceful degradation in the chat agent.
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-32';

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ script: [], callTool: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: () => ({ on: () => {}, finalMessage: async () => h.script.shift() }) };
  },
}));

const TOOLS = [{ name: 'b2_list_buckets', inputSchema: { type: 'object', properties: {} } }];

vi.mock('../../server/mcp/client.js', () => ({
  McpError: class extends Error { constructor(m, s) { super(m); this.status = s; } },
  listTools: vi.fn(async () => ({ scope: 'partner', tools: TOOLS })),
  callTool: h.callTool,
}));

import { runChatTurn, _resetMcpToolsCache } from '../../server/mcp/chatAgent.js';
import { listTools, McpError } from '../../server/mcp/client.js';

const session = { user: { id: 1, role: 'admin', accountId: null } };
const userTurn = (t) => [{ role: 'user', content: [{ type: 'text', text: t }] }];
function collector() {
  const events = [];
  return { emit: (ev, d) => events.push({ ev, d }), has: (ev) => events.some((x) => x.ev === ev) };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  h.script.length = 0;
  h.callTool.mockReset();
  listTools.mockClear();
  listTools.mockResolvedValue({ scope: 'partner', tools: TOOLS });
  _resetMcpToolsCache();
});

describe('MCP tool-list caching', () => {
  it('fetches the tool list once and reuses it across turns', async () => {
    h.script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'one' }] });
    h.script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'two' }] });

    const a = collector();
    await runChatTurn({ session, messages: userTurn('a'), emit: a.emit });
    const b = collector();
    await runChatTurn({ session, messages: userTurn('b'), emit: b.emit });

    expect(listTools).toHaveBeenCalledTimes(1); // second turn served from cache
    expect(a.has('message_done')).toBe(true);
    expect(b.has('message_done')).toBe(true);
  });
});

describe('MCP degradation', () => {
  it('runs with custom tools only when listTools fails transiently', async () => {
    listTools.mockRejectedValueOnce(new Error('429 Too many concurrent sessions for this key'));
    h.script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'answered from local data' }] });

    const c = collector();
    await expect(runChatTurn({ session, messages: userTurn('largest files?'), emit: c.emit })).resolves.toBeUndefined();
    expect(c.has('message_done')).toBe(true);
    expect(c.has('error')).toBe(false);
  });

  it('still throws on a permanent McpError (no scope / not configured)', async () => {
    listTools.mockRejectedValueOnce(new McpError('No MCP access is configured for this account.', 403));
    const c = collector();
    await expect(runChatTurn({ session, messages: userTurn('x'), emit: c.emit })).rejects.toThrow(/No MCP access/);
  });
});
