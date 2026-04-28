import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, Database, KeyRound, Activity, Plus, Mail, Hash, Globe, Layers,
  Lock, ShieldCheck, Eye, EyeOff, Clock, Trash2, GitBranch, ChevronRight,
  Download as DownloadIcon, FileSpreadsheet,
} from 'lucide-react';
import { buildCustomerUsageCsv, downloadText } from '../api/csvParser.js';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, HealthPill, Tabs,
  Table, THead, TBody, TR, TH, TD, LoadingState, EmptyState,
} from '../components/ui.jsx';
import { TrendAreaChart, StackedBarChart } from '../components/charts.jsx';
import { CreateBucketDialog } from '../components/dialogs.jsx';
import { REGIONS } from '../data/regions.js';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';
import { useNav } from '../lib/nav.js';
import { bytes, compactNumber, currency, percent, shortDate, relativeTime } from '../lib/format.js';
import { LastUsedCell } from './ApplicationKeysView.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'buckets',  label: 'Buckets' },
  { id: 'keys',     label: 'Application keys' },
  { id: 'activity', label: 'Activity' },
  { id: 'billing',  label: 'Billing & usage' },
];

export default function CustomerDetailView({ customerId }) {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState(null);
  const [buckets, setBuckets] = useState([]);
  const [keys, setKeys] = useState([]);
  const [activity, setActivity] = useState([]);
  const [tab, setTab] = useState('overview');
  const [showBucketDialog, setShowBucketDialog] = useState(false);

  const refresh = () => {
    partner.getCustomer(customerId).then((c) => {
      Promise.all([
        b2.listBuckets({ customerId }),
        b2.listApplicationKeys({ customerId }),
        b2.getBucketActivity({ accountId: c?.accountId }),
      ]).then(([{ buckets }, { keys }, { records }]) => {
        setCustomer(c);
        setBuckets(buckets);
        setKeys(keys);
        setActivity(records);
        setLoading(false);
      });
    });
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [customerId]);

  if (loading) return <LoadingState label="Loading customer detail" />;
  if (!customer) {
    return (
      <EmptyState
        title="Customer not found"
        message={`No customer with id ${customerId}`}
        action={<button onClick={() => navigate('partner')} className="rounded-md bg-bb-red px-3 py-1.5 text-xs text-white">Back to Customers</button>}
      />
    );
  }

  const region = REGIONS.find((r) => r.id === customer.region);
  const margin = (customer.revenue30d - customer.cogs30d) / customer.revenue30d;
  const groupTabsCount = [
    { ...TABS[0] },
    { ...TABS[1], count: buckets.length },
    { ...TABS[2], count: keys.length },
    { ...TABS[3], count: activity.length },
    { ...TABS[4] },
  ];

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('partner')}
        className="inline-flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100"
      >
        <ArrowLeft size={12} /> Back to Customers
      </button>

      <PageHeader
        eyebrow={`Customer · ${customer.industry}`}
        title={customer.name}
        subtitle={`Account ${customer.accountId} · onboarded ${shortDate(customer.onboarded)} · region ${region?.flag} ${region?.code}`}
        actions={
          <div className="flex items-center gap-2">
            <HealthPill status={customer.health} />
            <button
              onClick={() => downloadCustomerCsv(customer, buckets)}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-ink-200 hover:bg-ink-800"
              title="Generate a Backblaze-shaped Usage.csv for this customer"
            >
              <DownloadIcon size={12} /> Download usage CSV
            </button>
            <button
              onClick={() => setShowBucketDialog(true)}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              <Plus size={12} /> Create bucket
            </button>
          </div>
        }
      />

      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <MetricCard label="Storage" value={bytes(customer.storageBytes)} source="csv" icon={<Database size={14} />} accent="red" />
        <MetricCard label="Egress (30d)" value={bytes(customer.egressBytes30d)} source="csv" accent="teal" />
        <MetricCard label="Buckets" value={buckets.length} source="api" icon={<Database size={14} />} accent="violet" />
        <MetricCard label="App keys" value={keys.length} source="api" icon={<KeyRound size={14} />} accent="amber" />
        <MetricCard label="Margin (30d)" value={percent(margin, 1)} source="derived" accent="green" />
      </div>

      <Tabs tabs={groupTabsCount} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <OverviewTab customer={customer} buckets={buckets} keys={keys} />
      )}
      {tab === 'buckets' && (
        <BucketsTab buckets={buckets} customer={customer} onCreate={() => setShowBucketDialog(true)} />
      )}
      {tab === 'keys' && <KeysTab keys={keys} />}
      {tab === 'activity' && <ActivityTab events={activity} />}
      {tab === 'billing' && <BillingTab customer={customer} buckets={buckets} />}

      <CreateBucketDialog
        open={showBucketDialog}
        onClose={() => setShowBucketDialog(false)}
        customer={customer}
        onCreated={refresh}
      />
    </div>
  );
}

// ============================================================================
// Tab content
// ============================================================================
function OverviewTab({ customer, buckets, keys }) {
  // Build a synthetic 30-day series proportional to this customer's totals
  const days = 30;
  const data = Array.from({ length: days }, (_, i) => {
    const d = new Date('2026-04-25T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days - i - 1));
    const factor = 0.9 + Math.sin((i + customer.name.length) / 5) * 0.15;
    return {
      date: d.toISOString().slice(0, 10),
      storageBytes: customer.storageBytes * (0.92 + i / days * 0.08),
      egressBytes: customer.egressBytes30d / days * factor,
    };
  });

  const lifecycleRules = buckets.flatMap((b) => b.lifecycleRules);
  const expiringKeys = keys.filter((k) => k.expirationTimestamp && k.expirationTimestamp < Date.now());

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Storage & egress · 30 days" subtitle="Aggregated across all buckets in this account" action={<SourceBadge source="csv" />} />
        <TrendAreaChart
          data={data}
          series={[
            { key: 'storageBytes', name: 'Storage', color: '#E61F18', format: bytes },
            { key: 'egressBytes', name: 'Egress', color: '#3DD9D6', format: bytes },
          ]}
          yFormatter={bytes}
        />
      </Card>

      <div className="space-y-4">
        <Card padding="p-4">
          <h4 className="mb-2 text-xs font-semibold text-ink-200">Quick facts</h4>
          <dl className="space-y-1.5 text-xs">
            <KV icon={<Mail size={12} />} label="Contact" value={customer.contactEmail} />
            <KV icon={<Hash size={12} />} label="Account ID" value={customer.accountId} mono />
            <KV icon={<Globe size={12} />} label="Region" value={`${customer.region}`} mono />
            <KV label="Plan" value={customer.plan} />
            <KV label="Onboarded" value={shortDate(customer.onboarded)} />
          </dl>
        </Card>
        <Card padding="p-4">
          <h4 className="mb-2 text-xs font-semibold text-ink-200">Configuration counts</h4>
          <dl className="space-y-1.5 text-xs">
            <KV label="Buckets" value={buckets.length} mono />
            <KV label="Lifecycle rules" value={lifecycleRules.length} mono />
            <KV label="Application keys" value={keys.length} mono />
            <KV label="Expired keys" value={<span className={expiringKeys.length ? 'text-bb-red' : 'text-accent-green'}>{expiringKeys.length}</span>} mono />
            <KV label="Public buckets" value={buckets.filter((b) => b.publicAccess).length} mono />
            <KV label="Object Lock buckets" value={buckets.filter((b) => b.fileLock !== 'none').length} mono />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function BucketsTab({ buckets, customer, onCreate }) {
  if (buckets.length === 0) {
    return (
      <EmptyState
        title="No buckets yet"
        message="Create the first bucket for this sub-account."
        action={
          <button onClick={onCreate} className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs text-white">
            <Plus size={12} /> Create bucket
          </button>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      {buckets.map((b) => <BucketDetailCard key={b.bucketId} bucket={b} />)}
    </div>
  );
}

function BucketDetailCard({ bucket }) {
  const { navigate } = useNav();
  const region = REGIONS.find((r) => r.id === bucket.region);
  const open = () => navigate('bucket-detail', { bucketId: bucket.bucketId, fromCustomer: true });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className="group block w-full cursor-pointer rounded-xl border border-ink-700 bg-ink-850/80 p-5 text-left shadow-card transition hover:border-bb-red/60 hover:bg-ink-850 hover:shadow-glow focus:border-bb-red/80 focus:outline-none focus:ring-2 focus:ring-bb-red/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-bb-red" />
            <span className="truncate font-mono text-sm font-semibold text-ink-100">{bucket.bucketName}</span>
            {bucket.publicAccess
              ? <Tag variant="warn"><Eye size={10} className="mr-0.5" /> public</Tag>
              : <Tag><EyeOff size={10} className="mr-0.5" /> private</Tag>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-400">{bucket.bucketId}</div>
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right">
            <div className="text-sm font-mono text-ink-100">{bytes(bucket.storageBytes)}</div>
            <div className="text-[11px] text-ink-400">{compactNumber(bucket.objectCount)} objects</div>
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-400 group-hover:text-bb-red">
            <span>Open</span>
            <ChevronRight size={14} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Pill icon={<Lock size={11} />} label="Encryption" value={bucket.encryption} />
        <Pill icon={<ShieldCheck size={11} />} label="Object Lock" value={bucket.fileLock === 'none' ? 'disabled' : `${bucket.fileLock}`} />
        <Pill label="Versioning" value={bucket.versioning} />
        <Pill icon={<Globe size={11} />} label="Region" value={`${region?.flag} ${region?.code}`} />
      </div>

      {bucket.lifecycleRules.length > 0 && (
        <div className="mt-4 rounded-md bg-ink-900/60 p-3 ring-1 ring-ink-700">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-300">
            <Layers size={12} /> Lifecycle rules ({bucket.lifecycleRules.length})
          </div>
          <ul className="space-y-1.5 text-xs">
            {bucket.lifecycleRules.map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-md bg-ink-850 px-2.5 py-1.5">
                <div className="font-mono text-ink-200">prefix: {r.fileNamePrefix || '(all)'}</div>
                <div className="flex items-center gap-3 text-[11px] text-ink-300">
                  <span className="inline-flex items-center gap-1">
                    <Clock size={10} className="text-accent-amber" />
                    hide: {r.daysFromUploadingToHiding ? `${r.daysFromUploadingToHiding}d` : '—'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Trash2 size={10} className="text-bb-red" />
                    delete: {r.daysFromHidingToDeleting ? `${r.daysFromHidingToDeleting}d` : '—'}
                  </span>
                </div>
              </li>
            ))}
            <li className="text-[10.5px] text-ink-400">
              B2 lifecycle rules only hide and delete files. There is no transition to a colder class.
            </li>
          </ul>
        </div>
      )}

      {bucket.replicationTo && (
        <div className="mt-3 inline-flex items-center gap-1 rounded-md bg-accent-violet/10 px-2 py-1 text-[11px] text-accent-violet ring-1 ring-inset ring-accent-violet/30">
          <GitBranch size={11} /> Replicating to {REGIONS.find((r) => r.id === bucket.replicationTo)?.code}
        </div>
      )}
    </div>
  );
}

function KeysTab({ keys }) {
  const { navigate } = useNav();
  if (keys.length === 0) {
    return <EmptyState title="No application keys for this customer" message="Use Application Keys & Security to issue a least-privilege key." />;
  }
  return (
    <Card padding="p-0">
      <Table>
        <THead>
          <TR hover={false}>
            <TH>Key name</TH>
            <TH>Bucket</TH>
            <TH>Capabilities</TH>
            <TH>Prefix</TH>
            <TH>Expires</TH>
            <TH>Last used</TH>
          </TR>
        </THead>
        <TBody>
          {keys.map((k) => (
            <TR key={k.applicationKeyId} onClick={() => navigate('key-detail', { keyId: k.applicationKeyId })}>
              <TD>
                <div className="font-mono text-[12px] text-ink-100">{k.keyName}</div>
                <div className="font-mono text-[10.5px] text-ink-400">{k.applicationKeyId}</div>
              </TD>
              <TD className="text-ink-300">{k.bucketName}</TD>
              <TD>
                <div className="flex flex-wrap gap-1">
                  {k.capabilities.slice(0, 4).map((c) => (
                    <Tag key={c} variant={c.startsWith('write') || c.startsWith('delete') ? 'warn' : 'info'}>{c}</Tag>
                  ))}
                  {k.capabilities.length > 4 && <Tag>+{k.capabilities.length - 4}</Tag>}
                </div>
              </TD>
              <TD className="font-mono text-[11px] text-accent-violet">{k.namePrefix || '—'}</TD>
              <TD className="text-xs text-ink-300">{k.expirationDate || <Tag variant="warn">no expiry</Tag>}</TD>
              <TD className="text-[11.5px] text-ink-300">
                <LastUsedCell ts={null} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function ActivityTab({ events }) {
  // events here are real per-request records parsed from Bucket Access Logs.
  if (!events || events.length === 0) {
    return (
      <EmptyState
        title="No access log records"
        message="Bucket Access Logs are best-effort and may take a few hours to appear. If you haven't enabled access logging on this customer's buckets yet, the per-request activity feed will be empty until you do."
      />
    );
  }

  // Per-bucket totals from real records
  const byBucket = events.reduce((acc, r) => {
    const k = r.bucket || 'unknown';
    if (!acc[k]) acc[k] = { bucket: k, count: 0, bytes: 0, errors: 0, lastTs: null };
    acc[k].count += 1;
    acc[k].bytes += r.bytesSent || 0;
    if (r.httpStatus >= 400) acc[k].errors += 1;
    if (!acc[k].lastTs || (r.timestamp && r.timestamp > acc[k].lastTs)) acc[k].lastTs = r.timestamp;
    return acc;
  }, {});
  const bucketSummaries = Object.values(byBucket).sort((a, b) => b.count - a.count);

  // Top operations
  const opMap = {};
  events.forEach((r) => {
    const op = r.operation || 'unknown';
    opMap[op] = (opMap[op] || 0) + 1;
  });
  const topOps = Object.entries(opMap).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="space-y-4">
      <Card className="border-ink-700 bg-ink-900/40">
        <div className="text-[11.5px] leading-relaxed text-ink-300">
          <strong className="text-ink-100">Source:</strong> Backblaze <a href="https://www.backblaze.com/docs/cloud-storage-bucket-access-logs" target="_blank" rel="noreferrer" className="text-bb-red hover:underline">Bucket Access Logs</a> — real per-request records delivered to a destination bucket. Format follows the AWS S3 server access log format. Showing the {events.length} most recent parsed records for this customer's buckets.
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card padding="p-0">
          <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
            <h3 className="text-sm font-semibold text-ink-100">Per-bucket activity</h3>
            <SourceBadge source="api" />
          </div>
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Bucket</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">Bytes sent</TH>
                <TH className="text-right">4xx/5xx</TH>
              </TR>
            </THead>
            <TBody>
              {bucketSummaries.map((b) => (
                <TR key={b.bucket} hover={false}>
                  <TD className="font-mono text-[12px] text-ink-100">{b.bucket}</TD>
                  <TD className="text-right font-mono">{compactNumber(b.count)}</TD>
                  <TD className="text-right font-mono">{bytes(b.bytes)}</TD>
                  <TD className={"text-right font-mono " + (b.errors > 0 ? 'text-bb-red' : 'text-ink-400')}>{b.errors}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card padding="p-0">
          <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
            <h3 className="text-sm font-semibold text-ink-100">Top operations</h3>
            <SourceBadge source="api" />
          </div>
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Operation</TH>
                <TH className="text-right">Count</TH>
              </TR>
            </THead>
            <TBody>
              {topOps.map(([op, count]) => (
                <TR key={op} hover={false}>
                  <TD className="font-mono text-[11.5px] text-ink-200">{op}</TD>
                  <TD className="text-right font-mono">{compactNumber(count)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h3 className="text-sm font-semibold text-ink-100">Recent requests</h3>
          <SourceBadge source="api" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Time</TH>
              <TH>Operation</TH>
              <TH>Bucket / key</TH>
              <TH>Identity</TH>
              <TH>IP</TH>
              <TH className="text-right">Status</TH>
              <TH className="text-right">Bytes</TH>
              <TH className="text-right">ms</TH>
            </TR>
          </THead>
          <TBody>
            {events.slice(0, 50).map((r) => (
              <TR key={r.requestId} hover={false}>
                <TD className="text-[11px] font-mono text-ink-200">{r.timestamp ? r.timestamp.replace('T', ' ').slice(0, 19) : '—'}</TD>
                <TD className="font-mono text-[11px] text-ink-200">{r.operation}</TD>
                <TD>
                  <div className="font-mono text-[11.5px] text-ink-100">{r.bucket}</div>
                  <div className="font-mono text-[10.5px] text-ink-400">{r.key || '—'}</div>
                </TD>
                <TD className="font-mono text-[10.5px] text-ink-300">{r.identityType ? `${r.identityType}:${(r.identityId || '').slice(0, 12)}…` : 'anon'}</TD>
                <TD className="font-mono text-[10.5px] text-ink-300">{r.remoteIp || '—'}</TD>
                <TD className={"text-right font-mono " + (r.httpStatus >= 400 ? 'text-bb-red' : 'text-accent-green')}>{r.httpStatus}</TD>
                <TD className="text-right font-mono text-ink-200">{r.bytesSent ? bytes(r.bytesSent) : '—'}</TD>
                <TD className="text-right font-mono text-ink-300">{r.totalTimeMs ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function BillingTab({ customer, buckets }) {
  const txnBarData = [{
    name: 'Last 30 days',
    A: customer.txnA30d,
    B: customer.txnB30d,
    C: customer.txnC30d,
  }];
  const margin = customer.revenue30d - customer.cogs30d;
  return (
    <div className="space-y-4">
    <Card padding="p-4" className="bg-ink-900/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <FileSpreadsheet size={18} className="mt-0.5 text-accent-amber" />
          <div>
            <div className="text-sm font-semibold text-ink-100">Download usage CSV</div>
            <p className="mt-0.5 text-[11.5px] text-ink-400">
              Generate a Backblaze-shaped Usage.csv scoped to {customer.name}. Mirrors the column set of the real <code className="text-ink-200">b2-reports-$ACCOUNTID/YYYY-MM-DD/Usage.csv</code> so anything that reads the real file will read this too.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => downloadCustomerCsv(customer, buckets, d)}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800 hover:text-ink-100"
            >
              <DownloadIcon size={12} /> Last {d}d
            </button>
          ))}
        </div>
      </div>
    </Card>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Transaction breakdown · 30 days" action={<SourceBadge source="csv" />} />
        <StackedBarChart
          data={txnBarData}
          series={[
            { key: 'A', name: 'Class A (uploads, free)', color: '#3DD9D6', format: compactNumber },
            { key: 'B', name: 'Class B (downloads)',     color: '#9B7CFF', format: compactNumber },
            { key: 'C', name: 'Class C (metadata)',      color: '#F5B73E', format: compactNumber },
          ]}
          yFormatter={compactNumber}
          height={220}
        />
      </Card>
      <Card>
        <CardHeader title="Revenue & margin" action={<SourceBadge source="derived" />} />
        <dl className="space-y-2 text-sm">
          <KV label="Revenue (30d)" value={currency(customer.revenue30d)} mono accent="text-ink-100" />
          <KV label="COGS (30d)" value={currency(customer.cogs30d)} mono accent="text-bb-red" />
          <hr className="border-ink-700" />
          <KV label="Gross margin" value={currency(margin)} mono accent="text-accent-green" />
          <KV label="Margin %" value={percent(margin / customer.revenue30d, 1)} mono accent="text-accent-green" />
          <hr className="border-ink-700" />
          <KV label="Annualized revenue" value={currency(customer.revenue30d * 12, { compact: true })} mono />
          <KV label="Growth (30d)" value={<span className={customer.growth >= 0 ? 'text-accent-green' : 'text-bb-red'}>{customer.growth >= 0 ? '+' : ''}{percent(customer.growth, 1)}</span>} mono />
        </dl>
      </Card>
    </div>
    </div>
  );
}

function downloadCustomerCsv(customer, buckets, days = 30) {
  const csv = buildCustomerUsageCsv(customer, buckets, days);
  const fname = `${customer.accountId}_usage_${new Date().toISOString().slice(0, 10)}_last${days}d.csv`;
  downloadText(fname, csv);
}

function KV({ label, value, mono, icon, accent }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="inline-flex items-center gap-1 text-ink-400">{icon}{label}</dt>
      <dd className={"text-right " + (mono ? "font-mono " : "") + (accent || 'text-ink-100')}>{value}</dd>
    </div>
  );
}

function Pill({ icon, label, value }) {
  return (
    <div className="rounded-md bg-ink-900/60 px-2.5 py-1.5 ring-1 ring-ink-700">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-400">{icon}{label}</div>
      <div className="mt-0.5 text-xs text-ink-100">{value}</div>
    </div>
  );
}
