import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, KeyRound, ShieldAlert, FlaskConical, Zap, Eye, EyeOff, Trash2, CheckCircle2, XCircle, Info, Code2 } from 'lucide-react';
import { PageHeader, Card, CardHeader, Tag, SourceBadge } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { testConnection } from '../api/b2Adapter.js';
import { isDemoEmail } from '../lib/format.js';
import { api, ApiError } from '../lib/apiClient.js';

export default function SettingsView() {
  const { config, isLive, hasCreds, setMode, setCredentials, reset, user, trainingMode, setTrainingMode, isAdmin } = useApp();
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

function McpServerCard() {
  const [cfg, setCfg] = useState(null);        // { baseUrl, enabled, hasToken }
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [test, setTest] = useState(null);
  const [err, setErr] = useState('');
  const [tokens, setTokens] = useState([]);
  const [acct, setAcct] = useState({ accountId: '', label: '', token: '' });

  const load = async () => {
    setErr('');
    try {
      const c = await api.get('/api/admin/mcp/config');
      setCfg(c.config); setBaseUrl(c.config.baseUrl || ''); setEnabled(!!c.config.enabled);
      const t = await api.get('/api/admin/mcp/account-tokens');
      setTokens(t.tokens || []);
    } catch (e) { setErr(mcpErr(e)); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setErr(''); setFlash('');
    try {
      const body = { baseUrl, enabled };
      if (token) body.token = token;
      const r = await api.put('/api/admin/mcp/config', body);
      setCfg(r.config); setToken('');
      setFlash('Saved'); setTimeout(() => setFlash(''), 1500);
    } catch (e) { setErr(mcpErr(e)); } finally { setBusy(false); }
  };

  const runTest = async () => {
    setTest(null); setErr('');
    try {
      const body = {};
      if (baseUrl) body.baseUrl = baseUrl;
      if (token) body.token = token;
      setTest(await api.post('/api/admin/mcp/test', body));
    } catch (e) { setTest({ ok: false, error: mcpErr(e) }); }
  };

  const addToken = async (e) => {
    e?.preventDefault?.();
    if (!acct.accountId || !acct.token) { setErr('accountId and token are required'); return; }
    setErr('');
    try {
      await api.put(`/api/admin/mcp/account-tokens/${encodeURIComponent(acct.accountId)}`, { label: acct.label, token: acct.token });
      setAcct({ accountId: '', label: '', token: '' });
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
        subtitle="Connect your Backblaze MCP server. Partner staff use the master token (full scope); each customer account uses its own scoped token. Tokens are encrypted at rest and never returned."
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
          placeholder="https://mcp.example.com/mcp"
          value={baseUrl}
          onChange={setBaseUrl}
          help="The Streamable HTTP endpoint of your MCP server."
          mono
        />
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
          <form onSubmit={addToken} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr,1fr,1.3fr,auto]">
            <input value={acct.accountId} onChange={(e) => setAcct({ ...acct, accountId: e.target.value })} placeholder="accountId" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-xs text-ink-100" />
            <input value={acct.label} onChange={(e) => setAcct({ ...acct, label: e.target.value })} placeholder="label (optional)" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100" />
            <input value={acct.token} onChange={(e) => setAcct({ ...acct, token: e.target.value })} placeholder="scoped token" type="password" className="h-8 rounded border border-ink-700 bg-ink-900 px-2 font-mono text-xs text-ink-100" />
            <button type="submit" className="inline-flex h-8 items-center justify-center rounded-md border border-ink-700 bg-ink-850 px-3 text-xs font-medium text-ink-200 hover:bg-ink-800">Add</button>
          </form>
        </div>
      </div>
    </Card>
  );
}
