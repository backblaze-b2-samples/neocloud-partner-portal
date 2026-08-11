// Tests for the conversational MCP agent loop (server/mcp/chatAgent.js).
// The Anthropic SDK and the scoped MCP client are mocked so the test exercises
// the loop, the read/write classifier, and the confirm-gate — no network, no DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared, hoisted handles the mock factories can close over.
const h = vi.hoisted(() => ({
  script: [],        // queue of finalMessage() results, one per model turn
  callTool: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: () => ({
        on: () => {},
        finalMessage: async () => h.script.shift(),
      }),
    };
  },
}));

vi.mock('../../server/mcp/client.js', () => ({
  McpError: class extends Error { constructor(m, s) { super(m); this.status = s; } },
  listTools: vi.fn(async () => ({
    scope: 'partner',
    tools: [
      { name: 'b2_list_buckets', inputSchema: { type: 'object', properties: {} } },
      { name: 'b2_get_bucket', inputSchema: { type: 'object', properties: {} } },
      { name: 'b2_update_bucket', inputSchema: { type: 'object', properties: {} } },
    ],
  })),
  callTool: h.callTool,
}));

import { runChatTurn, isReadOnlyTool, toAnthropicTools } from '../../server/mcp/chatAgent.js';

const session = { user: { id: 1, role: 'admin', accountId: null } };
const userTurn = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];

function collector() {
  const events = [];
  return { events, emit: (e, d) => events.push({ e, d }), has: (e) => events.some((x) => x.e === e) };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  h.script.length = 0;
  h.callTool.mockReset();
  h.callTool.mockResolvedValue({ scope: 'partner', result: { content: [{ type: 'text', text: 'ok' }] } });
});

describe('isReadOnlyTool — fail-safe classifier', () => {
  it('treats list/get/authorize as read-only', () => {
    expect(isReadOnlyTool('b2_list_buckets')).toBe(true);
    expect(isReadOnlyTool('b2_get_bucket')).toBe(true);
    expect(isReadOnlyTool('b2_authorize_account')).toBe(true);
  });
  it('treats mutations — and anything unrecognized — as writes', () => {
    expect(isReadOnlyTool('b2_update_bucket')).toBe(false);
    expect(isReadOnlyTool('b2_delete_key')).toBe(false);
    expect(isReadOnlyTool('b2_create_key')).toBe(false);
    expect(isReadOnlyTool('some_new_tool')).toBe(false);
  });
});

describe('toAnthropicTools', () => {
  it('sorts by name and fills input_schema', () => {
    const out = toAnthropicTools([{ name: 'b2_zzz', inputSchema: { type: 'object' } }, { name: 'b2_aaa' }]);
    expect(out.map((t) => t.name)).toEqual(['b2_aaa', 'b2_zzz']);
    expect(out[0].input_schema).toEqual({ type: 'object', properties: {} });
  });
});

describe('runChatTurn — read path', () => {
  it('auto-executes a read tool and continues to a final answer', async () => {
    h.script.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'b2_list_buckets', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You have 2 buckets.' }] },
    );
    const { emit, events, has } = collector();
    const onToolExecuted = vi.fn();
    await runChatTurn({ session, messages: userTurn('list my buckets'), emit, onToolExecuted });

    expect(h.callTool).toHaveBeenCalledWith(expect.anything(), 'b2_list_buckets', {});
    expect(onToolExecuted).toHaveBeenCalledWith({ name: 'b2_list_buckets', scope: 'partner' });
    expect(has('confirm_required')).toBe(false);
    expect(has('message_done')).toBe(true);
    expect(events.find((e) => e.e === 'message_done').d.messages.at(-1).role).toBe('assistant');
  });
});

describe('runChatTurn — write confirm gate', () => {
  it('pauses on a write without executing it', async () => {
    h.script.push({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'w1', name: 'b2_update_bucket', input: { bucketName: 'backups' } }],
    });
    const { emit, events, has } = collector();
    await runChatTurn({ session, messages: userTurn('lock the backups bucket'), emit, onToolExecuted: vi.fn() });

    expect(h.callTool).not.toHaveBeenCalled();
    expect(has('confirm_required')).toBe(true);
    const paused = events.find((e) => e.e === 'paused');
    expect(paused.d.pending[0].id).toBe('w1');
    expect(paused.d.messages.at(-1).role).toBe('assistant');
  });

  it('on resume=allow, executes the write then finishes', async () => {
    h.script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Object Lock enabled.' }] });
    const messages = [
      ...userTurn('lock the backups bucket'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'b2_update_bucket', input: { bucketName: 'backups' } }] },
    ];
    const onToolExecuted = vi.fn();
    const { emit, has } = collector();
    await runChatTurn({ session, messages, decisions: { w1: 'allow' }, emit, onToolExecuted });

    expect(h.callTool).toHaveBeenCalledWith(expect.anything(), 'b2_update_bucket', { bucketName: 'backups' });
    expect(onToolExecuted).toHaveBeenCalled();
    expect(has('message_done')).toBe(true);
  });

  it('on resume=deny, does NOT execute and feeds an error result back', async () => {
    h.script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay, leaving it as-is.' }] });
    const messages = [
      ...userTurn('lock the backups bucket'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'b2_update_bucket', input: { bucketName: 'backups' } }] },
    ];
    const { emit, events, has } = collector();
    await runChatTurn({ session, messages, decisions: { w1: 'deny' }, emit, onToolExecuted: vi.fn() });

    expect(h.callTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.e === 'tool_result' && e.d.ok === false)).toBe(true);
    expect(has('message_done')).toBe(true);
  });
});
