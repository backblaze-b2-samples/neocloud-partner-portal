import React, { useState } from 'react';
import { Settings as SettingsIcon, KeyRound, ShieldAlert, FlaskConical, Zap, Eye, EyeOff, Trash2, CheckCircle2, XCircle, Info } from 'lucide-react';
import { PageHeader, Card, CardHeader, Tag, SourceBadge } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { testConnection } from '../api/b2Adapter.js';

export default function SettingsView() {
  const { config, isLive, hasCreds, setMode, setCredentials, reset } = useApp();
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
          desc="The dashboard issues real calls to api.backblazeb2.com using your master application key. Requires credentials below and (in most browsers) a small CORS proxy — Backblaze's Native API does not allow direct browser calls."
          onClick={() => hasCreds ? setMode('live') : null}
          disabled={!hasCreds}
          tone="green"
          disabledHint="Add Master Key ID + Application Key below first"
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
            help="Browsers cannot call api.backblazeb2.com directly because Backblaze does not send CORS headers. Point this at a small reverse-proxy you control. Leave blank in demo mode."
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
          <SourceRow source="csv" desc="Storage bytes, egress, Class A/B/C transactions — pulled from the Daily Usage CSV in b2-reports-$ACCOUNTID/YYYY-MM-DD/Usage.csv" />
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
