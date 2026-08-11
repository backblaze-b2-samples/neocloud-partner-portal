import React, { useEffect, useRef, useState } from 'react';
import {
  Plug, Play, RefreshCcw, Wrench, AlertTriangle, Lock, Send, Sparkles,
  ShieldCheck, Check, X, ChevronRight, Loader2, Eraser,
} from 'lucide-react';
import { PageHeader, Card, Tabs, Tag, LoadingState, EmptyState } from '../components/ui.jsx';
import { JsonView } from '../components/JsonView.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { streamChat } from '../lib/mcpChat.js';

const errText = (err, fallback) =>
  (err instanceof ApiError && (err.body?.error || err.message)) || (err?.message) || fallback;

// Starter prompts — one per demo scenario, plus the "one-click onboard" recipe
// that fans a single sentence into a full provisioning sequence.
const EXAMPLES = [
  { label: 'Account growth', prompt: 'Which customers grew the most in stored data over the last 30 days, and is anyone shrinking or moving data off?' },
  { label: 'Largest files', prompt: 'Where are the largest files across my buckets — show the biggest objects and which bucket they live in.' },
  { label: 'Egress leaders', prompt: 'Who are my egress leaders this month — which customers are downloading the most, and how concentrated is it?' },
  { label: 'Lifecycle hygiene', prompt: 'Which buckets have the most stale data that should probably have a lifecycle rule to clean it up?' },
  { label: 'Posture audit', prompt: "Which of my buckets don't have Object Lock enabled, and are any of them public?" },
  { label: 'Cost & lifecycle hygiene', prompt: 'Find buckets with no lifecycle rules and list application keys that look stale or overly broad.' },
  { label: 'Ransomware / immutability', prompt: 'Walk me through enabling 30-day compliance Object Lock on my backups bucket.' },
  { label: 'Least-privilege key', prompt: "Create a least-privilege application key that can only write to my 'backups' bucket." },
  { label: 'One-click onboard', prompt: 'Onboard a new project: create a private bucket, a least-privilege key scoped to it, 30-day Object Lock, and a lifecycle rule that expires old versions.' },
];

// =============================================================================
// Chat mode — talk to your storage; Claude orchestrates the scoped MCP tools.
// =============================================================================
function ChatPanel({ scope }) {
  const [items, setItems] = useState([]);   // display timeline
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const messagesRef = useRef([]);            // canonical Anthropic transcript (opaque)
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [items]);

  // ---- timeline mutators (functional updates — safe inside stream callback) ----
  const finalizeStreaming = (arr) => {
    const last = arr[arr.length - 1];
    if (last && last.type === 'assistant' && last.streaming) {
      const copy = arr.slice();
      copy[copy.length - 1] = { ...last, streaming: false };
      return copy;
    }
    return arr;
  };
  const pushText = (text) => setItems((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.type === 'assistant' && last.streaming) {
      const copy = prev.slice();
      copy[copy.length - 1] = { ...last, text: last.text + text };
      return copy;
    }
    return [...prev, { type: 'assistant', text, streaming: true }];
  });
  const pushTool = (d) => setItems((prev) =>
    [...finalizeStreaming(prev), { type: 'tool', id: d.id, name: d.name, args: d.args, kind: d.kind, status: 'running' }]);
  const updateTool = (d) => setItems((prev) => prev.map((it) =>
    (it.type === 'tool' && it.id === d.id)
      ? { ...it, status: d.ok === false ? (it.kind === 'write' ? 'denied' : 'error') : 'done', ok: d.ok, result: d.result }
      : it));

  async function runTurn(body) {
    setBusy(true); setError(''); setPaused(false);
    const confirms = [];
    try {
      await streamChat(body, (event, data) => {
        switch (event) {
          case 'text': pushText(data.text); break;
          case 'tool_call': pushTool(data); break;
          case 'tool_result': updateTool(data); break;
          case 'confirm_required': confirms.push(data); break;
          case 'paused':
            messagesRef.current = data.messages;
            setPaused(true);
            setItems((prev) => [...finalizeStreaming(prev), { type: 'confirm', tools: confirms.slice(), resolved: false }]);
            break;
          case 'message_done': messagesRef.current = data.messages; break;
          case 'error': setError(data.message); break;
          default: break;
        }
      });
    } catch (e) {
      setError(errText(e, 'Chat failed.'));
    } finally {
      setItems((prev) => finalizeStreaming(prev));
      setBusy(false);
    }
  }

  function send(text) {
    const t = text.trim();
    if (!t || busy) return;
    const userMsg = { role: 'user', content: [{ type: 'text', text: t }] };
    messagesRef.current = [...messagesRef.current, userMsg];
    setItems((prev) => [...prev, { type: 'user', text: t }]);
    setInput('');
    runTurn({ messages: messagesRef.current });
  }

  function resolveConfirm(idx, allow) {
    const item = items[idx];
    if (!item || item.resolved) return;
    const decisions = {};
    for (const tool of item.tools) decisions[tool.id] = allow ? 'allow' : 'deny';
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, resolved: true, allowed: allow } : it)));
    runTurn({ messages: messagesRef.current, decisions });
  }

  function reset() {
    if (busy) return;
    messagesRef.current = [];
    setItems([]); setError(''); setPaused(false); setInput('');
  }

  const scopeBadge = scope === 'partner'
    ? <Tag variant="violet">Partner — full scope</Tag>
    : <Tag variant="info">Scoped — {scope?.replace('account:', '')}</Tag>;

  return (
    <div className="flex flex-col gap-3">
      {/* Control-plane / scope banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2 text-xs text-ink-300">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-accent-green" />
          Control plane only — Claude changes B2 <strong className="font-medium text-ink-200">configuration</strong> (buckets, keys, retention, lifecycle). Object data never passes through this chat.
        </span>
        {scopeBadge}
      </div>

      <Card padding="p-0" className="flex h-[62vh] flex-col">
        {/* Transcript */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-3 rounded-full bg-ink-800 p-3 text-bb-red"><Sparkles size={20} /></div>
              <h4 className="text-sm font-semibold text-ink-100">Turn intent into action</h4>
              <p className="mt-1 max-w-md text-xs text-ink-400">
                Describe what you want and Claude orchestrates your Backblaze MCP tools — reads run instantly,
                changes pause for your approval. Try one:
              </p>
              <div className="mt-4 flex max-w-lg flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    onClick={() => send(ex.prompt)}
                    className="inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-200 hover:border-bb-red/40 hover:text-ink-100"
                  >
                    <Sparkles size={11} className="text-bb-red" /> {ex.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((it, i) => <TimelineItem key={i} item={it} onResolve={(allow) => resolveConfirm(i, allow)} />)
          )}

          {busy && !paused && (
            <div className="flex items-center gap-2 text-xs text-ink-400">
              <Loader2 size={13} className="animate-spin" /> Working…
            </div>
          )}
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-ink-700 p-3">
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={1}
              placeholder={paused ? 'Approve or deny the pending action above…' : 'Ask about your buckets, keys, retention…'}
              disabled={busy || paused}
              className="max-h-32 min-h-[38px] flex-1 resize-none rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={reset}
              disabled={busy || items.length === 0}
              title="New conversation"
              className="inline-flex h-[38px] items-center rounded-md border border-ink-700 bg-ink-850 px-2.5 text-ink-300 hover:bg-ink-800 disabled:opacity-40"
            >
              <Eraser size={14} />
            </button>
            <button
              type="submit"
              disabled={busy || paused || !input.trim()}
              className="inline-flex h-[38px] items-center gap-1.5 rounded-md bg-bb-red px-4 text-sm font-medium text-white hover:bg-bb-redDim disabled:opacity-50"
            >
              <Send size={14} /> Send
            </button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function TimelineItem({ item, onResolve }) {
  if (item.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm bg-bb-red/15 px-3 py-2 text-sm text-ink-100 ring-1 ring-inset ring-bb-red/25">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.type === 'assistant') {
    return (
      <div className="max-w-[88%] whitespace-pre-wrap text-sm text-ink-200">
        {item.text}
        {item.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ink-400 align-middle" />}
      </div>
    );
  }
  if (item.type === 'tool') return <ToolCard item={item} />;
  if (item.type === 'confirm') return <ConfirmCard item={item} onResolve={onResolve} />;
  return null;
}

function ToolCard({ item }) {
  const [open, setOpen] = useState(false);
  const statusIcon = item.status === 'running'
    ? <Loader2 size={12} className="animate-spin text-ink-400" />
    : item.status === 'denied'
      ? <X size={12} className="text-ink-400" />
      : item.ok === false
        ? <AlertTriangle size={12} className="text-bb-red" />
        : <Check size={12} className="text-accent-green" />;
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/60 text-xs">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight size={12} className={'shrink-0 text-ink-500 transition-transform ' + (open ? 'rotate-90' : '')} />
        <Wrench size={12} className="shrink-0 text-ink-400" />
        <span className="font-mono font-medium text-ink-100">{item.name}</span>
        <Tag variant={item.kind === 'write' ? 'warn' : 'info'} className="ml-0.5">{item.kind}</Tag>
        <span className="ml-auto">{statusIcon}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-ink-700 px-3 py-2">
          {item.args && Object.keys(item.args).length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Arguments</div>
              <JsonView value={item.args} />
            </div>
          )}
          {item.result != null && item.status !== 'running' && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Result</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-ink-900 p-2 text-[11px] text-ink-300">{item.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmCard({ item, onResolve }) {
  return (
    <div className={'rounded-md border px-3 py-2.5 text-xs ' +
      (item.resolved ? 'border-ink-700 bg-ink-850/40 opacity-80' : 'border-accent-amber/40 bg-accent-amber/10')}>
      <div className="mb-2 flex items-center gap-1.5 font-medium text-ink-100">
        <ShieldCheck size={13} className="text-accent-amber" />
        {item.resolved
          ? (item.allowed ? 'Approved — running the change' : 'Denied')
          : `Approve ${item.tools.length > 1 ? `${item.tools.length} changes` : 'this change'}?`}
      </div>
      <div className="space-y-2">
        {item.tools.map((t) => (
          <div key={t.id} className="rounded border border-ink-700 bg-ink-900/70 p-2">
            <div className="mb-1 font-mono font-medium text-ink-100">{t.name}</div>
            {t.args && Object.keys(t.args).length > 0 && <JsonView value={t.args} />}
          </div>
        ))}
      </div>
      {!item.resolved && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => onResolve(true)}
            className="inline-flex items-center gap-1 rounded-md bg-accent-green/90 px-3 py-1.5 text-xs font-medium text-ink-950 hover:bg-accent-green"
          >
            <Check size={13} /> Approve &amp; run
          </button>
          <button
            onClick={() => onResolve(false)}
            className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-ink-200 hover:bg-ink-800"
          >
            <X size={13} /> Deny
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Tools mode — the original manual tool-picker (kept for power users/debugging).
// =============================================================================
function SchemaForm({ schema, value, onChange }) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const keys = Object.keys(props);
  if (keys.length === 0) return <p className="text-xs text-ink-400">This tool takes no input.</p>;
  return (
    <div className="space-y-3">
      {keys.map((key) => {
        const p = props[key] || {};
        const type = Array.isArray(p.type) ? p.type[0] : p.type;
        const set = (v) => onChange({ ...value, [key]: v });
        return (
          <label key={key} className="block">
            <div className="mb-1 flex items-center gap-1.5 text-xs">
              <span className="font-medium text-ink-200">{key}</span>
              {required.has(key) && <span className="text-bb-red">*</span>}
              {type && <span className="text-[10px] text-ink-500">{type}</span>}
            </div>
            {type === 'boolean' ? (
              <input type="checkbox" checked={!!value[key]} onChange={(e) => set(e.target.checked)}
                className="h-4 w-4 rounded border-ink-700 bg-ink-900" />
            ) : type === 'number' || type === 'integer' ? (
              <input type="number" value={value[key] ?? ''}
                onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
                className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40" />
            ) : (
              <input type="text" value={value[key] ?? ''}
                onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
                placeholder={p.description || ''}
                className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40" />
            )}
            {p.description && <p className="mt-1 text-[11px] text-ink-400">{p.description}</p>}
          </label>
        );
      })}
    </div>
  );
}

function ToolsPanel() {
  const [tools, setTools] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [args, setArgs] = useState({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try { const t = await api.get('/api/mcp/tools'); setTools(t.tools || []); }
      catch (err) { setError(errText(err, 'Failed to load MCP tools.')); setTools([]); }
    })();
  }, []);

  const run = async () => {
    if (!selected) return;
    setRunning(true); setResult(null); setError('');
    try {
      const out = await api.post('/api/mcp/tools/call', { name: selected.name, arguments: args });
      setResult(out.result);
    } catch (err) { setError(errText(err, 'Tool call failed.')); }
    finally { setRunning(false); }
  };

  if (tools === null) return <LoadingState label="Loading tools" />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px,1fr]">
      <Card padding="p-0" className="self-start">
        <div className="border-b border-ink-700 px-4 py-3 text-sm font-semibold text-ink-100">
          Tools <span className="text-ink-400">({tools.length})</span>
        </div>
        {tools.length === 0 ? (
          <div className="p-4 text-xs text-ink-400">No tools exposed for this scope.</div>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto p-2">
            {tools.map((t) => (
              <li key={t.name}>
                <button
                  onClick={() => { setSelected(t); setArgs({}); setResult(null); setError(''); }}
                  className={'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ' +
                    (selected?.name === t.name ? 'bg-bb-red/10 text-ink-100 ring-1 ring-inset ring-bb-red/30' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100')}
                >
                  <Wrench size={13} className="mt-0.5 shrink-0 text-ink-400" />
                  <span className="min-w-0">
                    <span className="block truncate font-mono font-medium">{t.name}</span>
                    {t.description && <span className="mt-0.5 block truncate text-[10.5px] text-ink-500">{t.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="space-y-4">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {!selected ? (
          <Card><p className="text-xs text-ink-400">Select a tool to inspect its inputs and run it.</p></Card>
        ) : (
          <>
            <Card>
              <div className="mb-3">
                <h3 className="font-mono text-sm font-semibold text-ink-100">{selected.name}</h3>
                {selected.description && <p className="mt-1 text-xs text-ink-300">{selected.description}</p>}
              </div>
              <SchemaForm schema={selected.inputSchema} value={args} onChange={setArgs} />
              <div className="mt-4">
                <button onClick={run} disabled={running}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-bb-red px-4 text-sm font-medium text-white hover:bg-bb-redDim disabled:opacity-60">
                  <Play size={14} /> {running ? 'Running…' : 'Run tool'}
                </button>
              </div>
            </Card>
            {result != null && (
              <Card>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">Result</div>
                <JsonView value={result} />
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Page shell — status gate + Chat / Tools mode switch.
// =============================================================================
export default function McpConsoleView() {
  const { isAdmin } = useApp();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('chat');

  const load = async () => {
    setError(''); setStatus(null);
    try { setStatus(await api.get('/api/mcp/status')); }
    catch (err) { setError(errText(err, 'Failed to reach the MCP server.')); setStatus({}); }
  };
  useEffect(() => { load(); }, []);

  const chatReady = status?.configured && status?.hasScope && status?.chatAvailable;
  const tabs = [{ id: 'chat', label: 'Chat' }, { id: 'tools', label: 'Tools' }];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Developer · MCP"
        title="Talk to your storage"
        subtitle="State your intent; Claude turns it into scoped Backblaze MCP actions — reads run instantly, changes pause for your approval. The power of MCP with guardrails, no per-action glue code."
        actions={
          <div className="flex items-center gap-2">
            {status?.configured && status?.hasScope && (
              <Tabs tabs={tabs} value={mode} onChange={setMode} />
            )}
            <button
              onClick={load}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"
            >
              <RefreshCcw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {status === null ? (
        <LoadingState label="Connecting to MCP server" />
      ) : !status?.configured ? (
        <EmptyState
          icon={<Plug size={20} />}
          title="MCP server not configured"
          message={isAdmin
            ? 'Add your MCP server URL and credentials under Settings → Advanced — MCP server.'
            : 'Ask an administrator to configure the MCP server connection.'}
        />
      ) : !status?.hasScope ? (
        <EmptyState
          icon={<Lock size={20} />}
          title="No MCP access for your account"
          message="The MCP server is configured, but no scoped token is set for your account. Ask an administrator to grant access."
        />
      ) : mode === 'chat' ? (
        chatReady ? (
          <ChatPanel scope={status.scope} />
        ) : (
          <EmptyState
            icon={<Sparkles size={20} />}
            title="Chat mode is unavailable"
            message={isAdmin
              ? 'Set ANTHROPIC_API_KEY in the server environment to enable the conversational console. The manual Tools mode still works.'
              : 'Conversational mode is not enabled. You can still use the Tools mode.'}
            action={
              <button onClick={() => setMode('tools')}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-bb-red px-3 text-xs font-medium text-white hover:bg-bb-redDim">
                <Wrench size={13} /> Open Tools mode
              </button>}
          />
        )
      ) : (
        <ToolsPanel />
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
    </div>
  );
}
