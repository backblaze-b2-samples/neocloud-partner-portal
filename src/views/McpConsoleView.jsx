import React, { useEffect, useState } from 'react';
import { Plug, Play, RefreshCcw, Wrench, AlertTriangle, Lock } from 'lucide-react';
import { PageHeader, Card, LoadingState, EmptyState } from '../components/ui.jsx';
import { JsonView } from '../components/JsonView.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api, ApiError } from '../lib/apiClient.js';

const errText = (err, fallback) =>
  (err instanceof ApiError && (err.body?.error || err.message)) || fallback;

// Render a simple form from a tool's JSON-Schema inputSchema.
function SchemaForm({ schema, value, onChange }) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return <p className="text-xs text-ink-400">This tool takes no input.</p>;
  }
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
              <input
                type="checkbox"
                checked={!!value[key]}
                onChange={(e) => set(e.target.checked)}
                className="h-4 w-4 rounded border-ink-700 bg-ink-900"
              />
            ) : type === 'number' || type === 'integer' ? (
              <input
                type="number"
                value={value[key] ?? ''}
                onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
                className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
              />
            ) : (
              <input
                type="text"
                value={value[key] ?? ''}
                onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
                placeholder={p.description || ''}
                className="h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
              />
            )}
            {p.description && <p className="mt-1 text-[11px] text-ink-400">{p.description}</p>}
          </label>
        );
      })}
    </div>
  );
}

export default function McpConsoleView() {
  const { isAdmin } = useApp();
  const [status, setStatus] = useState(null);
  const [tools, setTools] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [args, setArgs] = useState({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const load = async () => {
    setError(''); setTools(null); setSelected(null); setResult(null);
    try {
      const st = await api.get('/api/mcp/status');
      setStatus(st);
      if (st.configured && st.hasScope) {
        const t = await api.get('/api/mcp/tools');
        setTools(t.tools || []);
      } else {
        setTools([]);
      }
    } catch (err) {
      setError(errText(err, 'Failed to load MCP tools.'));
      setTools([]);
    }
  };
  useEffect(() => { load(); }, []);

  const run = async () => {
    if (!selected) return;
    setRunning(true); setResult(null); setError('');
    try {
      const out = await api.post('/api/mcp/tools/call', { name: selected.name, arguments: args });
      setResult(out.result);
    } catch (err) {
      setError(errText(err, 'Tool call failed.'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Developer"
        title="MCP console"
        subtitle="Invoke your Backblaze MCP server's tools, scoped to your access. Partner staff see the full tool set; customer users see only their own account's scope."
        actions={
          <button
            onClick={load}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"
          >
            <RefreshCcw size={12} /> Refresh
          </button>
        }
      />

      {tools === null ? (
        <LoadingState label="Connecting to MCP server" />
      ) : !status?.configured ? (
        <EmptyState
          icon={<Plug size={20} />}
          title="MCP server not configured"
          message={isAdmin
            ? 'Add your MCP server URL and token under Settings → Advanced — MCP server.'
            : 'Ask an administrator to configure the MCP server connection.'}
        />
      ) : !status?.hasScope ? (
        <EmptyState
          icon={<Lock size={20} />}
          title="No MCP access for your account"
          message="The MCP server is configured, but no scoped token is set for your account. Ask an administrator to grant access."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px,1fr]">
          {/* Tool list */}
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
                      className={
                        'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ' +
                        (selected?.name === t.name ? 'bg-bb-red/10 text-ink-100 ring-1 ring-inset ring-bb-red/30' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100')
                      }
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

          {/* Detail / run / result */}
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
                    <button
                      onClick={run}
                      disabled={running}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-bb-red px-4 text-sm font-medium text-white hover:bg-bb-redDim disabled:opacity-60"
                    >
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
      )}
    </div>
  );
}
