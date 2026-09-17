import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, KeyRound, ShieldAlert, FlaskConical, Zap, Eye, EyeOff, Trash2, CheckCircle2, XCircle, Info, Code2, Users as UsersIcon, Plus, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { PageHeader, Card, CardHeader, Tag, SourceBadge } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { testConnection } from '../api/b2Adapter.js';
import { isDemoEmail } from '../lib/format.js';
import { api, ApiError } from '../lib/apiClient.js';

export default function SettingsView() {
  const { config, isLive, hasCreds, setMode, setCredentials, reset, user, trainingMode, setTrainingMode, isAdmin, can } = useApp();
  const isDemo = isDemoEmail(user?.email);
  const [draft, setDraft] = useState({
    masterKeyId: config.masterKeyId,
    masterApplicationKey: config.masterApplicationKey,
    proxyUrl: config.proxyUrl,
  });
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function save(e) {
    e?.preventDefault?.();
    setCredentials(draft);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  }

  async function runTest() {
    save();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection();
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, message: String(e.message || e) });
    } finally {
      setTesting(false);
    }
  }

  function clearAll() {
    if (!confirm('Clear all stored credentials and reset to demo mode?')) return;
    reset();
    setDraft({ masterKeyId: '', masterApplicationKey: '', proxyUrl: '' });
    setTestResult(null);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="System"
        title="Settings & credentials"
        subtitle="Switch between demo data and live Backblaze API calls. Credentials are kept in your browser's localStorage and never transmitted to any third party."
        actions={
          <div className="flex items-center gap-2">
            <Tag variant={isLive ? 'success' : 'violet'}>
              {isLive ? <><Zap size={11} className="mr-0.5" /> Live mode</> : <><FlaskConical size={11} className="mr-0.5" /> Demo mode</>}
            </Tag>
          </div>
        }
      />

      {/* Mode picker */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ModeCard
          active={!isLive}
          icon={<FlaskConical size={18} />}
          title="Demo mode"
          desc="All data comes from bundled fixtures. Safe to demo to anyone — no API calls leave your browser. Recommended for sales demos and design reviews."
          onClick={() => setMode('demo')}
          tone="violet"
        />
        <ModeCard
          active={isLive}
          icon={<Zap size={18} />}
          title="Live mode"
          desc="The dashboard issues real calls to api.backblazeb2.com using your master application key. Requires credentials below. Calls are proxied through the same-origin /b2-proxy path — no manual CORS proxy URL needed when deployed behind nginx."
          onClick={() => !isDemo && hasCreds ? setMode('live') : null}
          disabled={isDemo || !hasCreds}
          tone="green"
          disabledHint={isDemo ? 'Live mode is not available for demo accounts' : 'Add Master Key ID + Application Key below first'}
        />
      </div>

      {/* Credentials */}
      <Card>
        <CardHeader
          title="Master application key"
          subtitle="A master key has full account access. For production deployments use bucket-scoped keys with limited capabilities and proxy through a backend."
          icon={<KeyRound size={16} />}
          action={savedFlash ? <Tag variant="success">Saved</Tag> : <SourceBadge source="api" />}
        />
        <form onSubmit={save} className="space-y-4">
          <Field
            label="Master Key ID"
            placeholder="00500000000000000000000"
            value={draft.masterKeyId}
            onChange={(v) => setDraft({ ...draft, masterKeyId: v })}
            help="The keyID printed when you created the master key in the Backblaze console."
            mono
          />
          <Field
            label="Master Application Key"
            placeholder="K005************************************"
            value={draft.masterApplicationKey}
            onChange={(v) => setDraft({ ...draft, masterApplicationKey: v })}
            help="The applicationKey value. This is the secret — Backblaze only shows it once at creation."
            mono
            secret
            showSecret={showSecret}
            onToggleSecret={() => setShowSecret(!showSecret)}
          />
          {/* Partner Account ID was removed — it's redundant with the accountId
              returned by b2_authorize_account when the master key belongs to your
              partner account. Partner API calls now use that accountId directly. */}
          <Field
            label="CORS proxy URL (optional)"
            placeholder="https://your-proxy.example.com"
            value={draft.proxyUrl}
            onChange={(v) => setDraft({ ...draft, proxyUrl: v })}
            help="Overrides the auto-detected proxy. By default, calls go through /b2-proxy on the current origin (handled by nginx or the Vite dev proxy). Only set this if your proxy runs at a different URL."
          />

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-2 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              Save credentials
            </button>
            <button
              type="button"
              onClick={runTest}
              disabled={testing}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Save & test connection'}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-ink-300 hover:bg-bb-red/10 hover:text-bb-red"
            >
              <Trash2 size={12} /> Clear all
            </button>
          </div>

          {testResult && (
            <div className={"mt-2 flex items-start gap-3 rounded-lg border p-3 text-xs " +
              (testResult.ok
                ? "border-accent-green/30 bg-accent-green/5 text-accent-green"
                : "border-bb-red/30 bg-bb-red/5 text-bb-red")
            }>
              {testResult.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <div>
                <div className="font-semibold">{testResult.ok ? 'Connection ok' : 'Connection failed'}</div>
                <div className="mt-0.5 font-mono text-[11px] opacity-80">{testResult.message}</div>
              </div>
            </div>
          )}
        </form>
      </Card>

      {/* Developer / training mode */}
      <Card>
        <CardHeader
          title="Training mode"
          subtitle="Surface the real B2 API call behind each action — method, URL, request/response — so the portal doubles as a self-documenting reference. Authorization headers are masked and secrets (application keys, tokens) are redacted before display."
          icon={<Code2 size={16} />}
          action={
            <button
              type="button"
              role="switch"
              aria-checked={trainingMode}
              onClick={() => setTrainingMode(!trainingMode)}
              className={
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors ' +
                (trainingMode ? 'bg-bb-red' : 'bg-ink-700')
              }
            >
              <span className={'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' + (trainingMode ? 'translate-x-6' : 'translate-x-1')} />
            </button>
          }
        />
        <p className="text-xs text-ink-300">
          When on, a <span className="font-medium text-ink-100">B2 API activity</span> button appears in the top bar.
          In <span className="text-accent-violet">demo mode</span> it shows representative example calls; in{' '}
          <span className="text-accent-green">live mode</span> it captures the actual requests this portal makes.
        </p>
      </Card>

      {/* Advanced — MCP server (admin only) */}
      {isAdmin && <McpServerCard />}
      {can('settings:read') && <SsoCard canWrite={can('settings:write')} />}

      {/* Safety disclosure */}
      <Card className="border-bb-red/30 bg-bb-red/5">
        <div className="flex items-start gap-3">
          <ShieldAlert size={18} className="mt-0.5 text-bb-red" />
          <div className="text-xs text-ink-200">
            <div className="text-sm font-semibold text-ink-100">Production deployment notice</div>
            <p className="mt-1 leading-relaxed text-ink-300">
              For a real reseller portal, never store master credentials in the browser or call Backblaze directly from a browser session.
              The recommended pattern is:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-300">
              <li>Hold the master key in a backend secret store (AWS Secrets Manager, HashiCorp Vault, etc.)</li>
              <li>Expose a thin authenticated API from your backend that proxies B2 calls</li>
              <li>Issue per-customer scoped application keys via <code className="rounded bg-ink-800 px-1 text-[11px]">b2_create_key</code> with the smallest capability set the workload needs</li>
              <li>Rotate keys with <code className="rounded bg-ink-800 px-1 text-[11px]">validDurationInSeconds</code> and audit usage from the Daily CSV</li>
            </ul>
            <p className="mt-2 text-ink-300">
              This demo's <em>Live mode</em> is provided for engineering exploration only.
            </p>
          </div>
        </div>
      </Card>

      {/* About data sources */}
      <Card>
        <CardHeader title="Data sources used by this dashboard" icon={<Info size={16} />} />
        <ul className="space-y-2 text-xs text-ink-300">
          <SourceRow source="api" desc="Bucket metadata (b2_list_buckets), application keys (b2_list_keys / b2_create_key), file ops" />
          <SourceRow source="partner" desc="Group + sub-account hierarchy (b2_list_groups, b2_list_group_members), partner billing rollups" />
          <SourceRow source="csv" desc="Storage bytes, egress, Class A/B/C/D transactions — pulled from the Daily Usage CSV in b2-reports-$ACCOUNTID/YYYY-MM-DD/Usage.csv" />
          <SourceRow source="derived" desc="Cost models, growth percentages, margin — computed client-side from API + CSV data" />
          <SourceRow source="demo" desc="Region p99 latency, demo activity timestamps — placeholders that Backblaze does not expose as a metric" />
        </ul>
      </Card>
    </div>
  );
}

function ModeCard({ active, icon, title, desc, onClick, disabled, disabledHint, tone }) {
  const ringTone = tone === 'green' ? 'ring-accent-green/40' : 'ring-accent-violet/40';
  const bgTone = tone === 'green' ? 'bg-accent-green/5' : 'bg-accent-violet/5';
  const iconTone = tone === 'green' ? 'text-accent-green bg-accent-green/15' : 'text-accent-violet bg-accent-violet/15';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'group rounded-xl border p-5 text-left transition ' +
        (active
          ? 'border-transparent ring-2 ' + ringTone + ' ' + bgTone
          : 'border-ink-700 bg-ink-850/60 hover:border-ink-600') +
        (disabled ? ' cursor-not-allowed opacity-60' : ' cursor-pointer')
      }
    >
      <div className="flex items-start justify-between">
        <div className={"rounded-md p-2 " + iconTone}>{icon}</div>
        {active && <Tag variant={tone === 'green' ? 'success' : 'violet'}>Active</Tag>}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-ink-100">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-400">{desc}</p>
      {disabled && disabledHint && (
        <p className="mt-2 text-[11px] text-bb-red">⚠ {disabledHint}</p>
      )}
    </button>
  );
}

function Field({ label, placeholder, value, onChange, help, mono, secret, showSecret, onToggleSecret }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-ink-200">{label}</span>
        {secret && (
          <button
            type="button"
            onClick={onToggleSecret}
            className="inline-flex items-center gap-1 text-[10.5px] text-ink-400 hover:text-ink-200"
          >
            {showSecret ? <EyeOff size={11} /> : <Eye size={11} />}
            {showSecret ? 'hide' : 'show'}
          </button>
        )}
      </div>
      <input
        type={secret && !showSecret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={"w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40 " + (mono ? "font-mono" : "")}
      />
      {help && <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{help}</p>}
    </label>
  );
}

function SourceRow({ source, desc }) {
  return (
    <li className="flex items-start gap-3">
      <SourceBadge source={source} />
      <span className="text-ink-300">{desc}</span>
    </li>
  );
}

const mcpErr = (e) => (e instanceof ApiError && (e.body?.error || e.message)) || 'Request failed';

const B2_HEADER_NAMES = ['X-B2-Key-Id', 'X-B2-Key', 'X-B2-App-Key-Id', 'X-B2-App-Key'];

function McpServerCard() {
  const [cfg, setCfg] = useState(null);        // { baseUrl, enabled, hasToken, transport, authMode, headerNames }
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [transport, setTransport] = useState('http');
  const [authMode, setAuthMode] = useState('bearer');
  const [headers, setHeaders] = useState([]);  // [{ name, value }]
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [test, setTest] = useState(null);
  const [err, setErr] = useState('');
  const [tokens, setTokens] = useState([]);
  const [acct, setAcct] = useState({ accountId: '', label: '', token: '' });
  const [acctHeaders, setAcctHeaders] = useState({}); // { headerName: value } for per-account add

  const load = async () => {
    setErr('');
    try {
      const c = await api.get('/api/admin/mcp/config');
      setCfg(c.config);
      setBaseUrl(c.config.baseUrl || '');
      setEnabled(!!c.config.enabled);
      setTransport(c.config.transport || 'http');
      setAuthMode(c.config.authMode || 'bearer');
      // Values are encrypted/never returned — show saved header NAMES with blank
      // values; re-enter a value to change it.
      setHeaders((c.config.headerNames || []).map((name) => ({ name, value: '' })));
      const t = await api.get('/api/admin/mcp/account-tokens');
      setTokens(t.tokens || []);
    } catch (e) { setErr(mcpErr(e)); }
  };
  useEffect(() => { load(); }, []);

  // Header-editor helpers (custom-headers auth mode)
  const setHeaderRow = (i, patch) => setHeaders((h) => h.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addHeaderRow = () => setHeaders((h) => [...h, { name: '', value: '' }]);
  const removeHeaderRow = (i) => setHeaders((h) => h.filter((_, idx) => idx !== i));
  const applyB2Preset = () => setHeaders(B2_HEADER_NAMES.map((name) => ({ name, value: '' })));
  const headersObject = () => {
    const o = {};
    headers.forEach((r) => { if (r.name.trim() && r.value) o[r.name.trim()] = r.value; });
    return o;
  };
  // Header NAMES configured on the master (used to label per-account value inputs).
  const configuredHeaderNames = headers.map((h) => h.name).filter(Boolean);

  const save = async () => {
    setBusy(true); setErr(''); setFlash('');
    try {
      const body = { baseUrl, enabled, transport, authMode };
      if (authMode === 'bearer') {
        if (token) body.token = token;
      } else {
        const ho = headersObject();
        if (Object.keys(ho).length) body.headers = ho;
      }
      const r = await api.put('/api/admin/mcp/config', body);
      setCfg(r.config); setToken('');
      setHeaders((r.config.headerNames || []).map((name) => ({ name, value: '' })));
      setFlash('Saved'); setTimeout(() => setFlash(''), 1500);
    } catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  const runTest = async () => {
    setTest(null); setErr('');
    try {
      const body = { transport, authMode };
      if (baseUrl) body.baseUrl = baseUrl;
      if (authMode === 'bearer') { if (token) body.token = token; }
      else { const ho = headersObject(); if (Object.keys(ho).length) body.headers = ho; }
      setTest(await api.post('/api/admin/mcp/test', body));
    } catch (e) { setTest({ ok: false, error: mcpErr(e) }); }
  };

  const addToken = async (e) => {
    e?.preventDefault?.();
    if (!acct.accountId) { setErr('accountId is required'); return; }
    const body = { label: acct.label };
    if (authMode === 'bearer') {
      if (!acct.token) { setErr('a scoped token is required'); return; }
      body.token = acct.token;
    } else {
      const ho = {};
      configuredHeaderNames.forEach((n) => { if (acctHeaders[n]) ho[n] = acctHeaders[n]; });
      if (!Object.keys(ho).length) { setErr('enter at least one header value for this account'); return; }
      body.headers = ho;
    }
    setErr('');
    try {
      await api.put(`/api/admin/mcp/account-tokens/${encodeURIComponent(acct.accountId)}`, body);
      setAcct({ accountId: '', label: '', token: '' });
      setAcctHeaders({});
      await load();
    } catch (e2) { setErr(mcpErr(e2)); }
  };
  const delToken = async (accountId) => {
    if (!confirm(`Remove MCP token for ${accountId}?`)) return;
    try { await api.delete(`/api/admin/mcp/account-tokens/${encodeURIComponent(accountId)}`); await load(); }
    catch (e) { setErr(mcpErr(e)); }
  };

  return (
    <Card>
      <CardHeader
        title="Advanced — MCP server"
        subtitle="Connect your Backblaze MCP server. Partner staff use the master credential (full scope); each customer account uses its own scoped credential. Supports a single bearer token or custom headers (e.g. the four X-B2-* values the hosted Backblaze MCP needs), over Streamable HTTP or SSE. Encrypted at rest, never returned."
        icon={<KeyRound size={16} />}
        action={
          <div className="flex items-center gap-2">
            {flash && <Tag variant="success">{flash}</Tag>}
            {cfg && <Tag variant={cfg.enabled && cfg.hasToken ? 'success' : 'default'}>{cfg.enabled && cfg.hasToken ? 'Connected' : 'Off'}</Tag>}
          </div>
        }
      />
      <div className="space-y-4">
        <Field
          label="MCP server URL"
          placeholder={transport === 'sse' ? 'https://mcp.backblazedemos.xyz/sse' : 'https://mcp.example.com/mcp'}
          value={baseUrl}
          onChange={setBaseUrl}
          help={transport === 'sse' ? 'The SSE endpoint (…/sse).' : 'The Streamable HTTP endpoint (…/mcp).'}
          mono
        />

        {/* Transport + auth mode */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <div className="mb-1 text-xs font-medium text-ink-200">Transport</div>
            <select value={transport} onChange={(e) => setTransport(e.target.value)} className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none">
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE (Server-Sent Events)</option>
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-medium text-ink-200">Authentication</div>
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value)} className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none">
              <option value="bearer">Bearer token (Authorization header)</option>
              <option value="headers">Custom headers</option>
            </select>
          </label>
        </div>

        {authMode === 'bearer' ? (
          <Field
            label={cfg?.hasToken ? 'Master bearer token (leave blank to keep current)' : 'Master bearer token'}
            placeholder={cfg?.hasToken ? '•••••••• (saved)' : 'mcp_xxx…'}
            value={token}
            onChange={setToken}
            help="Sent as 'Authorization: Bearer …' for partner-staff sessions. Full scope."
            mono
            secret
            showSecret={showToken}
            onToggleSecret={() => setShowToken(!showToken)}
          />
        ) : (
          <div className="space-y-2 rounded-md border border-ink-700 bg-ink-900/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Master headers {cfg?.headerNames?.length ? `· ${cfg.headerNames.length} saved` : ''}</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={applyB2Preset} className="rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-[10.5px] text-ink-300 hover:bg-ink-800">B2 preset</button>
                <button type="button" onClick={addHeaderRow} className="rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-[10.5px] text-ink-300 hover:bg-ink-800">+ Add</button>
              </div>
            </div>
            <p className="text-[11px] text-ink-400">Header name → value, sent on every request. The hosted Backblaze MCP needs <code className="font-mono">X-B2-Key-Id</code>, <code className="font-mono">X-B2-Key</code>, <code className="font-mono">X-B2-App-Key-Id</code>, <code className="font-mono">X-B2-App-Key</code> — click “B2 preset”. Leave a value blank to keep the saved one.</p>
            {headers.length === 0 && <p className="py-1 text-[11px] text-ink-500">No headers. Click “B2 preset” or “Add”.</p>}
            {headers.map((h, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.3fr_auto] gap-2">
                <input value={h.name} onChange={(e) => setHeaderRow(i, { name: e.target.value })} placeholder="X-B2-Key-Id"
                  className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none" />
                <input value={h.value} onChange={(e) => setHeaderRow(i, { value: e.target.value })} type="password" placeholder={cfg?.headerNames?.includes(h.name) ? '•••••••• (saved)' : 'value'}
                  className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none" />
                <button type="button" onClick={() => removeHeaderRow(i)} className="grid place-items-center rounded-md px-2 text-ink-400 hover:bg-ink-800 hover:text-bb-red" title="Remove"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-ink-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-ink-700 bg-ink-900" />
          Enable the MCP console
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-2 text-xs font-medium text-white hover:bg-bb-redDim disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button onClick={runTest} className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-ink-200 hover:bg-ink-800">
            Test connection
          </button>
        </div>

        {test && (
          <div className={'flex items-start gap-3 rounded-lg border p-3 text-xs ' + (test.ok ? 'border-accent-green/30 bg-accent-green/5 text-accent-green' : 'border-bb-red/30 bg-bb-red/5 text-bb-red')}>
            {test.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <div className="font-medium">{test.ok ? `Connected — ${test.toolCount} tool(s) available` : `Failed: ${test.error}`}</div>
          </div>
        )}
        {err && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" /> <span>{err}</span>
          </div>
        )}

        {/* Per-customer scoped tokens */}
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
          <div className="mb-2 text-xs font-semibold text-ink-100">Per-customer scoped tokens</div>
          {tokens.length === 0 ? (
            <p className="text-[11px] text-ink-400">No scoped tokens yet. Customer-portal users have no MCP access until you add one here.</p>
          ) : (
            <ul className="mb-3 space-y-1">
              {tokens.map((t) => (
                <li key={t.accountId} className="flex items-center justify-between gap-2 rounded border border-ink-800 bg-ink-900/60 px-2 py-1.5 text-[11px]">
                  <span className="min-w-0 truncate"><span className="font-mono text-ink-200">{t.accountId}</span>{t.label && <span className="ml-2 text-ink-400">{t.label}</span>}</span>
                  <button onClick={() => delToken(t.accountId)} className="shrink-0 rounded px-1.5 py-0.5 text-ink-400 hover:bg-bb-red/10 hover:text-bb-red">
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {authMode === 'bearer' ? (
            <form onSubmit={addToken} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr,1fr,1.3fr,auto]">
              <input value={acct.accountId} onChange={(e) => setAcct({ ...acct, accountId: e.target.value })} placeholder="accountId" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-xs text-ink-100" />
              <input value={acct.label} onChange={(e) => setAcct({ ...acct, label: e.target.value })} placeholder="label (optional)" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100" />
              <input value={acct.token} onChange={(e) => setAcct({ ...acct, token: e.target.value })} placeholder="scoped token" type="password" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-xs text-ink-100" />
              <button type="submit" className="inline-flex h-8 items-center justify-center rounded-md border border-ink-700 bg-ink-850 px-3 text-xs font-medium text-ink-200 hover:bg-ink-800">Add</button>
            </form>
          ) : configuredHeaderNames.length === 0 ? (
            <p className="text-[11px] text-accent-amber">Configure the master headers above (e.g. “B2 preset”) and Save first — per-account values use the same header names.</p>
          ) : (
            <form onSubmit={addToken} className="space-y-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input value={acct.accountId} onChange={(e) => setAcct({ ...acct, accountId: e.target.value })} placeholder="accountId" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-xs text-ink-100" />
                <input value={acct.label} onChange={(e) => setAcct({ ...acct, label: e.target.value })} placeholder="label (optional)" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100" />
              </div>
              <p className="text-[10.5px] text-ink-400">This account's values for each configured header:</p>
              {configuredHeaderNames.map((name) => (
                <div key={name} className="grid grid-cols-[1fr_1.3fr] items-center gap-2">
                  <span className="truncate font-mono text-[11px] text-ink-300">{name}</span>
                  <input value={acctHeaders[name] || ''} onChange={(e) => setAcctHeaders((h) => ({ ...h, [name]: e.target.value }))} type="password" placeholder="value"
                    className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none" />
                </div>
              ))}
              <button type="submit" className="inline-flex h-8 items-center justify-center rounded-md border border-ink-700 bg-ink-850 px-3 text-xs font-medium text-ink-200 hover:bg-ink-800">Add account credential</button>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}

// =============================================================================
// Single sign-on (OIDC)
// =============================================================================
// Optional: password login always remains available, so the portal is never
// dependent on the identity provider being reachable. The client secret is
// write-only — the server reports presence as hasClientSecret and never returns
// the value, so the field stays blank on load and an empty submit means
// "leave it alone".
export function SsoCard({ canWrite }) {
  const [cfg, setCfg] = useState(null);
  const [roles, setRoles] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [form, setForm] = useState({
    enabled: false, issuerUrl: '', clientId: '', clientSecret: '', redirectUri: '',
    groupsClaim: 'groups', buttonLabel: 'Sign in with SSO', defaultRole: '', allowAdminRole: false,
  });
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const [test, setTest] = useState(null);
  const [newMap, setNewMap] = useState({ groupValue: '', roleId: '', label: '' });

  const load = async () => {
    setErr('');
    try {
      const [c, m, r] = await Promise.all([
        api.get('/api/admin/sso/config'),
        api.get('/api/admin/sso/mappings'),
        api.get('/api/admin/roles').catch(() => ({ roles: [] })),
      ]);
      setCfg(c.config);
      setForm({
        enabled: c.config.enabled,
        issuerUrl: c.config.issuerUrl,
        clientId: c.config.clientId,
        clientSecret: '',
        redirectUri: c.config.redirectUri,
        groupsClaim: c.config.groupsClaim,
        buttonLabel: c.config.buttonLabel,
        defaultRole: c.config.defaultRole || '',
        allowAdminRole: c.config.allowAdminRole,
      });
      setMappings(m.mappings);
      setRoles((r.roles || []).filter((x) => x.scope === 'partner'));
    } catch (e) {
      setErr(mcpErr(e));
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setErr(''); setFlash('');
    try {
      const res = await api.put('/api/admin/sso/config', { ...form, defaultRole: form.defaultRole || null });
      setCfg(res.config);
      setForm((f) => ({ ...f, clientSecret: '' }));
      setFlash('Saved.');
    } catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  const runTest = async () => {
    setBusy(true); setErr(''); setTest(null);
    try {
      setTest(await api.post('/api/admin/sso/test', { issuerUrl: form.issuerUrl }));
    } catch (e) { setTest({ ok: false, error: mcpErr(e) }); } finally { setBusy(false); }
  };

  const addMapping = async () => {
    if (!newMap.groupValue.trim() || !newMap.roleId) return;
    setBusy(true); setErr('');
    try {
      await api.post('/api/admin/sso/mappings', newMap);
      setNewMap({ groupValue: '', roleId: '', label: '' });
      await load();
    } catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  const removeMapping = async (id) => {
    setBusy(true); setErr('');
    try { await api.delete(`/api/admin/sso/mappings/${id}`); await load(); }
    catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  // Order is priority: the first mapping whose group the user belongs to wins.
  const move = async (index, delta) => {
    const next = [...mappings];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setMappings(next);
    setBusy(true);
    try { await api.post('/api/admin/sso/mappings/reorder', { orderedIds: next.map((m) => m.id) }); await load(); }
    catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  if (!cfg) return null;

  const defaultRedirect = `${window.location.origin}/api/auth/sso/callback`;

  return (
    <Card>
      <CardHeader
        title="Single sign-on (OIDC)"
        subtitle="Optional. Works with Microsoft Entra ID, Okta, Google Workspace, Keycloak, and other standards-compliant providers."
        icon={<KeyRound size={16} />}
        action={<Tag variant={cfg.enabled ? 'success' : 'default'}>{cfg.enabled ? 'Enabled' : 'Disabled'}</Tag>}
      />

      <div className="mt-4 flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2 text-[11px] text-ink-300">
        <Info size={13} className="mt-0.5 shrink-0 text-ink-400" />
        <span>
          Password sign-in always stays available, even with SSO enabled. Keep at least one
          administrator on a password account so an identity-provider outage cannot lock you out.
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Issuer URL" placeholder="https://login.microsoftonline.com/{tenant-id}/v2.0"
          value={form.issuerUrl} onChange={(v) => setForm({ ...form, issuerUrl: v })} mono
          help="The base URL of your provider's discovery document." />
        <Field label="Client ID" placeholder="application (client) id"
          value={form.clientId} onChange={(v) => setForm({ ...form, clientId: v })} mono />
        <Field label="Client secret" placeholder={cfg.hasClientSecret ? '•••••••• (stored)' : 'client secret'}
          value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })}
          secret showSecret={showSecret} onToggleSecret={() => setShowSecret((x) => !x)}
          help={cfg.hasClientSecret ? 'Stored and encrypted. Leave blank to keep it.' : 'Encrypted before it is stored.'} />
        <Field label="Groups claim" placeholder="groups"
          value={form.groupsClaim} onChange={(v) => setForm({ ...form, groupsClaim: v })} mono
          help="Entra sends group object IDs; Okta and Keycloak usually send names." />
        <Field label="Redirect URI" placeholder={defaultRedirect}
          value={form.redirectUri} onChange={(v) => setForm({ ...form, redirectUri: v })} mono
          help={`Paste this into your provider. Default: ${defaultRedirect}`} />
        <Field label="Button label" placeholder="Sign in with SSO"
          value={form.buttonLabel} onChange={(v) => setForm({ ...form, buttonLabel: v })}
          help="Shown on the sign-in page." />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Default role</span>
          <select
            value={form.defaultRole}
            onChange={(e) => setForm({ ...form, defaultRole: e.target.value })}
            disabled={!canWrite}
            className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100 disabled:opacity-60"
          >
            <option value="">No default — refuse unmapped users</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <span className="mt-1 block text-[10px] text-ink-500">
            Used when none of the group mappings below match.
          </span>
        </label>

        <label className="mt-1 flex cursor-pointer items-start gap-2 rounded-md border border-ink-700 bg-ink-900/50 px-3 py-2">
          <input
            type="checkbox"
            checked={form.allowAdminRole}
            onChange={(e) => setForm({ ...form, allowAdminRole: e.target.checked })}
            disabled={!canWrite}
            className="mt-0.5 h-3.5 w-3.5 accent-bb-red"
          />
          <span>
            <span className="flex items-center gap-1 text-xs font-medium text-ink-100">
              <AlertTriangle size={12} className="text-bb-red" />
              Allow SSO to grant the administrator role
            </span>
            <span className="mt-0.5 block text-[11px] text-ink-400">
              Off by default. While off, a group mapped to Administrator is refused. Turning it on
              means anyone who can edit that group in your identity provider can grant full portal
              administration, including access to stored credentials.
            </span>
          </span>
        </label>
      </div>

      <label className="mt-4 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          disabled={!canWrite}
          className="h-3.5 w-3.5 accent-bb-red"
        />
        <span className="text-xs text-ink-200">Show the SSO button on the sign-in page</span>
      </label>

      {test && (
        <div className={cxSso(
          'mt-4 rounded-md border px-3 py-2 text-[11px]',
          test.ok ? 'border-accent-green/30 bg-accent-green/10 text-accent-green' : 'border-bb-red/30 bg-bb-red/10 text-bb-red'
        )}>
          {test.ok
            ? <>Discovery succeeded. Issuer <span className="font-mono">{test.issuer}</span>.</>
            : <>Discovery failed: {test.error}</>}
        </div>
      )}
      {flash && <div className="mt-3 text-[11px] text-accent-green">{flash}</div>}
      {err && <div className="mt-3 text-[11px] text-bb-red">{err}</div>}

      {canWrite && (
        <div className="mt-4 flex items-center gap-2">
          <button onClick={save} disabled={busy}
            className="inline-flex h-9 items-center rounded-md bg-bb-red px-3 text-sm font-medium text-white hover:bg-bb-red/90 disabled:opacity-60">
            Save SSO settings
          </button>
          <button onClick={runTest} disabled={busy || !form.issuerUrl}
            className="inline-flex h-9 items-center rounded-md border border-ink-700 px-3 text-sm text-ink-200 hover:border-ink-500 disabled:opacity-40">
            Test discovery
          </button>
        </div>
      )}

      {/* --- group -> role mappings --- */}
      <div className="mt-6 border-t border-ink-700 pt-4">
        <div className="flex items-center gap-2">
          <UsersIcon size={14} className="text-ink-400" />
          <span className="text-xs font-medium text-ink-100">Group → role mappings</span>
        </div>
        <p className="mt-1 text-[11px] text-ink-400">
          Checked in order; the first group the user belongs to decides their role. Roles are
          re-evaluated on every sign-in, so changes in your identity provider take effect immediately.
        </p>

        {mappings.length === 0 ? (
          <p className="mt-3 text-[11px] text-ink-500">No mappings yet — every user falls back to the default role above.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {mappings.map((m, i) => (
              <li key={m.id} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900/50 px-3 py-2">
                <span className="w-6 shrink-0 text-center text-[11px] text-ink-500">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-ink-200">{m.groupValue}</span>
                  {m.label && <span className="block truncate text-[11px] text-ink-400">{m.label}</span>}
                </span>
                <Tag variant="default">{roles.find((r) => r.id === m.roleId)?.name || m.roleId}</Tag>
                {canWrite && (
                  <span className="flex shrink-0 items-center gap-1">
                    <button onClick={() => move(i, -1)} disabled={busy || i === 0}
                      className="rounded p-1 text-ink-400 hover:text-ink-100 disabled:opacity-30" aria-label="Move up">
                      <ArrowUp size={13} />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={busy || i === mappings.length - 1}
                      className="rounded p-1 text-ink-400 hover:text-ink-100 disabled:opacity-30" aria-label="Move down">
                      <ArrowDown size={13} />
                    </button>
                    <button onClick={() => removeMapping(m.id)} disabled={busy}
                      className="rounded p-1 text-ink-400 hover:text-bb-red disabled:opacity-30" aria-label="Remove mapping">
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <input
              value={newMap.groupValue}
              onChange={(e) => setNewMap({ ...newMap, groupValue: e.target.value })}
              placeholder="Group ID or name from your IdP"
              className="h-9 rounded-md border border-ink-700 bg-ink-900 px-3 font-mono text-xs text-ink-100 placeholder:text-ink-500"
            />
            <select
              value={newMap.roleId}
              onChange={(e) => setNewMap({ ...newMap, roleId: e.target.value })}
              className="h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100"
            >
              <option value="">Select a role…</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button onClick={addMapping} disabled={busy || !newMap.groupValue.trim() || !newMap.roleId}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-ink-700 px-3 text-sm text-ink-200 hover:border-ink-500 disabled:opacity-40">
              <Plus size={14} /> Add
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

// Local class-name joiner — SettingsView does not otherwise import cx.
function cxSso(...parts) {
  return parts.filter(Boolean).join(' ');
}
