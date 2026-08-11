// =============================================================================
// chatAgent — the "talk to your storage" loop.
//
// Claude (claude-opus-4-8) turns a user's intent into Backblaze MCP tool calls,
// orchestrating the same scoped tools the manual console exposes. This is the
// MCP value story: intent -> action, with guardrails, no per-action glue code.
//
// Guardrails:
//   - Scope: every tool runs through callTool(session, ...), which inherits the
//     session's scope (partner = full; customer = own sub-account; fail-closed).
//   - Control plane only: the system prompt forbids touching object data, and
//     the tool set only exposes B2 configuration tools.
//   - Confirm gate: read-only tools (b2_list_*/b2_get_*/authorize) run freely;
//     any *mutating* tool pauses for explicit user approval before it executes.
//
// The conversation is stateless. The full Anthropic-format transcript is the
// canonical state and round-trips through the client as opaque `messages`.
// (The client is the authenticated user acting within their own scope, so
// trusting their transcript grants nothing they couldn't already do via the
// tool-picker; all execution is still scope-checked server-side by callTool.)
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { listTools, callTool, McpError } from './client.js';
import {
  USAGE_GROWTH_TOOL, runUsageGrowthTool,
  LARGEST_FILES_TOOL, runLargestFilesTool,
  EGRESS_LEADERS_TOOL, runEgressLeadersTool,
  LIFECYCLE_HYGIENE_TOOL, runLifecycleHygieneTool,
} from './usageInsights.js';

// Sonnet 4.6 is a strong, cost-effective default for this orchestration demo
// (~40% cheaper than Opus, same 1M context, supports adaptive thinking).
// Override with MCP_CHAT_MODEL — e.g. claude-haiku-4-5 for minimum cost, or
// claude-opus-4-8 for a high-stakes showing.
const MODEL = process.env.MCP_CHAT_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;

// Adaptive thinking is supported on Opus 4.6+, Sonnet 4.6, and Fable 5; sending
// it to a model that doesn't support it (e.g. Haiku 4.5) is a 400. Omit it
// elsewhere so the model override stays drop-in.
function thinkingFor(model) {
  return /(opus-4-[678]|sonnet-4-6|fable-5)/.test(model) ? { type: 'adaptive' } : undefined;
}
const MAX_ITERATIONS = 12; // bound on tool round-trips within a single turn
const RESULT_PREVIEW_CHARS = 4000; // cap on result text streamed to the UI

let _client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new McpError('Conversational console is not configured (missing ANTHROPIC_API_KEY).', 503);
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Whether chat mode is available (an Anthropic key is configured). */
export function chatAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Derive the scope string from the session the same way resolveMcpAuth does,
// so we never need an MCP round-trip just to know who's asking.
function scopeOf(session) {
  const accountId = session?.user?.accountId || null;
  return accountId == null ? 'partner' : `account:${accountId}`;
}

// --- MCP tool-list cache --------------------------------------------------
// listTools() opens an MCP session every call; doing it per chat turn churns
// the MCP server's per-key session cap. Cache the (scope-stable) tool list for
// a short TTL so a burst of turns reuses one fetch. On a TRANSIENT MCP failure
// (429 too-many-sessions, network, timeout) we fall back to a cached list, or
// run with just the local custom tools (degraded). CONFIG/SCOPE failures
// (MCP not configured, no scope) still throw — chat requires MCP access.
const MCP_TOOLS_TTL_MS = 5 * 60 * 1000;
const _mcpToolsCache = new Map(); // scope -> { tools, fetchedAt }

/** Test hook: clear the cached MCP tool lists. */
export function _resetMcpToolsCache() { _mcpToolsCache.clear(); }

async function loadMcpTools(session, scope) {
  const cached = _mcpToolsCache.get(scope);
  if (cached && Date.now() - cached.fetchedAt < MCP_TOOLS_TTL_MS) {
    return { mcpTools: cached.tools, degraded: false };
  }
  try {
    const { tools } = await listTools(session);
    _mcpToolsCache.set(scope, { tools, fetchedAt: Date.now() });
    return { mcpTools: tools, degraded: false };
  } catch (err) {
    // Permanent config/scope problems are surfaced to the user as today.
    if (err instanceof McpError && (err.status === 401 || err.status === 403 || err.status === 503)) {
      throw err;
    }
    // Transient (429 / network / timeout): reuse a stale list if we have one,
    // else run with the local custom tools only.
    if (cached) return { mcpTools: cached.tools, degraded: false };
    console.warn(`[chatAgent] MCP tools unavailable (${err?.message}); running with custom tools only`);
    return { mcpTools: [], degraded: true };
  }
}

// Server-executed custom tools — analytics over the portal's OWN ingested data
// (the daily usage reports), not exposed by the MCP server. Read-only, so they
// skip the confirm gate. Executed locally in executeToolUses, not via callTool.
const CUSTOM_TOOLS = [USAGE_GROWTH_TOOL, LARGEST_FILES_TOOL, EGRESS_LEADERS_TOOL, LIFECYCLE_HYGIENE_TOOL];
const CUSTOM_HANDLERS = {
  [USAGE_GROWTH_TOOL.name]: runUsageGrowthTool,
  [LARGEST_FILES_TOOL.name]: runLargestFilesTool,
  [EGRESS_LEADERS_TOOL.name]: runEgressLeadersTool,
  [LIFECYCLE_HYGIENE_TOOL.name]: runLifecycleHygieneTool,
};
const CUSTOM_READ_ONLY = new Set([
  USAGE_GROWTH_TOOL.name, LARGEST_FILES_TOOL.name, EGRESS_LEADERS_TOOL.name, LIFECYCLE_HYGIENE_TOOL.name,
]);

// Fail-safe classification: a tool is read-only only if it clearly reads
// (b2_list_*/b2_get_*), just authorizes, or is one of our read-only custom
// tools. Everything else — including any new/unrecognized tool — is treated as
// a mutation and requires confirmation.
const READ_ONLY_RE = /^b2_(list|get)/i;
export function isReadOnlyTool(name) {
  return CUSTOM_READ_ONLY.has(name) || READ_ONLY_RE.test(name) || name === 'b2_authorize_account';
}

function systemPrompt(scope, degraded = false) {
  const scopeLine = scope === 'partner'
    ? 'You are operating with PARTNER STAFF scope: full access across every sub-account on this partner.'
    : `You are operating with CUSTOMER scope (${scope}): you can only see and act on this single sub-account, never any other account.`;
  return [
    'You are the Backblaze B2 operations assistant inside the Neocloud partner portal.',
    "You turn the user's intent into Backblaze B2 actions by calling the available MCP tools — you do the work, you don't just describe how to do it.",
    '',
    scopeLine,
    '',
    'CONTROL PLANE ONLY. Your tools manage B2 *configuration*: buckets, application keys, retention / Object Lock, lifecycle rules, replication, event notifications, and groups. You never touch object *data* — no uploading, downloading, or reading file contents passes through you.',
    '',
    'How you work:',
    '- Investigate with read-only tools (b2_list_*, b2_get_*) before proposing or making any change.',
    '- Chain several tool calls when needed to answer a question completely.',
    '- For provisioning / onboarding requests, carry out the whole sequence (e.g. create a private bucket, create a least-privilege key scoped to it, enable Object Lock, add a lifecycle rule) rather than stopping after one step.',
    '- Mutating actions (anything that creates, updates, deletes, or sets configuration) are gated: the user approves each one before it runs. Before such a call, state plainly what it will change and why.',
    '- Default to least privilege when creating application keys — never request broader capabilities than the task needs.',
    '- For storage growth / usage trends across accounts ("who grew the most or least", "who is shrinking or moving data off"), use the account_usage_growth tool — it reads the daily usage reports the portal ingests (usage/billing metadata, not object data).',
    '- To find the biggest objects in a bucket ("where are my largest files", "what is taking up space in X"), use the largest_files_in_bucket tool — it reads the nightly file index (object metadata, not contents).',
    '- For "who is downloading the most / egress leaders this month / where is egress concentrated", use the egress_leaders tool — it ranks accounts or buckets by downloaded bytes from the usage reports.',
    '- For stale-data / cost hygiene ("which buckets have old data", "where should I add lifecycle rules", "what can be cleaned up"), use the bucket_lifecycle_hygiene tool, then confirm a flagged bucket\'s lifecycleRules with the MCP bucket tools before proposing a gated b2_update_bucket change.',
    '- If a tool returns a permission or scope error, explain that it is outside your current scope instead of retrying it.',
    '',
    'Be concise and concrete. Surface the specific bucket/key names and the exact setting that matters, and end with a short plain-language summary.',
    ...(degraded ? ['', 'NOTE: The Backblaze MCP storage tools are temporarily unavailable, so creating, modifying, or listing buckets and keys will not work right now. You can still answer usage, growth, and largest-files questions from the ingested report and index data. If a request needs the MCP tools, say they are temporarily unavailable and suggest retrying shortly.'] : []),
  ].join('\n');
}

// Map MCP tool descriptors -> Anthropic tool definitions. Sorted by name so the
// tools+system prefix is byte-stable across turns and stays prompt-cacheable.
export function toAnthropicTools(mcpTools) {
  return [...(mcpTools || [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
}

// Flatten an MCP CallToolResult into a string for an Anthropic tool_result.
function mcpResultToText(result) {
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .map((c) => (c && c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
    return text || '(empty result)';
  }
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more chars)` : s);

function normalizeDecision(value) {
  if (value === 'deny' || value?.decision === 'deny') {
    return { allow: false, reason: (value && value.reason) || '' };
  }
  return { allow: true, reason: '' };
}

// Execute a list of tool_use blocks, applying approval decisions, emitting UI
// cards, and returning the matching tool_result blocks for the transcript.
async function executeToolUses({ session, scope, toolUses, decisions, emit, onToolExecuted }) {
  const results = [];
  for (const t of toolUses) {
    const readOnly = isReadOnlyTool(t.name);
    const { allow, reason } = readOnly ? { allow: true, reason: '' } : normalizeDecision(decisions?.[t.id]);

    if (!allow) {
      const note = reason ? `The user denied this action. Reason: ${reason}` : 'The user denied this action.';
      emit('tool_result', { id: t.id, ok: false, result: 'Denied by the user.' });
      results.push({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: note });
      continue;
    }

    emit('tool_call', { id: t.id, name: t.name, args: t.input, kind: readOnly ? 'read' : 'write' });
    try {
      let text;
      let isError = false;
      const handler = CUSTOM_HANDLERS[t.name];
      if (handler) {
        // Server-executed custom tool (e.g. usage analytics over our archive).
        text = await handler({ session, scope, input: t.input || {} });
      } else {
        const out = await callTool(session, t.name, t.input);
        isError = !!out.result?.isError;
        text = mcpResultToText(out.result);
      }
      onToolExecuted?.({ name: t.name, scope });
      emit('tool_result', { id: t.id, ok: !isError, result: truncate(text, RESULT_PREVIEW_CHARS) });
      results.push({ type: 'tool_result', tool_use_id: t.id, content: text, is_error: isError });
    } catch (err) {
      const message = err?.message || 'Tool call failed.';
      emit('tool_result', { id: t.id, ok: false, result: message });
      results.push({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: message });
    }
  }
  return results;
}

/**
 * Run one chat turn, streaming progress via emit(event, data).
 *
 * @param session       the authenticated portal session (carries scope)
 * @param messages      canonical Anthropic-format transcript from the client
 * @param decisions     on a resume, { [tool_use_id]: 'allow' | 'deny' | {decision,reason} }
 * @param emit          (event, data) => void — SSE sink
 * @param onToolExecuted({name,scope}) — called after each tool actually runs (for audit)
 * @param isClosed      () => boolean — whether the client disconnected
 *
 * Emits: text, tool_call, tool_result, confirm_required, paused, message_done, error.
 */
export async function runChatTurn({ session, messages, decisions = null, emit, onToolExecuted, isClosed }) {
  const client = anthropic();
  const scope = scopeOf(session);
  // Cached per scope; throws McpError only on permanent no-scope/not-configured.
  const { mcpTools, degraded } = await loadMcpTools(session, scope);
  const tools = [...toAnthropicTools(mcpTools), ...CUSTOM_TOOLS];
  const system = [{ type: 'text', text: systemPrompt(scope, degraded), cache_control: { type: 'ephemeral' } }];

  const convo = Array.isArray(messages) ? messages.slice() : [];

  // Resume: the posted transcript ends with the assistant's gated tool_use turn.
  // Execute its tool calls (applying decisions), append the results, then loop.
  const last = convo[convo.length - 1];
  if (decisions && last?.role === 'assistant' && Array.isArray(last.content)) {
    const toolUses = last.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length) {
      const results = await executeToolUses({ session, scope, toolUses, decisions, emit, onToolExecuted });
      convo.push({ role: 'user', content: results });
    }
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (isClosed?.()) return;

    const thinking = thinkingFor(MODEL);
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      ...(thinking ? { thinking } : {}),
      messages: convo,
    });
    stream.on('text', (delta) => emit('text', { text: delta }));
    const msg = await stream.finalMessage();
    convo.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason !== 'tool_use') {
      emit('message_done', { messages: convo });
      return;
    }

    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    const writes = toolUses.filter((t) => !isReadOnlyTool(t.name));

    if (writes.length) {
      // Pause for human approval. Nothing in this turn executes until the user
      // approves on resume — including any read calls Claude bundled alongside.
      for (const w of writes) emit('confirm_required', { id: w.id, name: w.name, args: w.input });
      emit('paused', { messages: convo, pending: writes.map((w) => ({ id: w.id, name: w.name })) });
      return;
    }

    const results = await executeToolUses({ session, scope, toolUses, decisions: null, emit, onToolExecuted });
    convo.push({ role: 'user', content: results });
  }

  emit('error', { message: 'Reached the tool-call limit for this turn. Ask me to continue.' });
}
