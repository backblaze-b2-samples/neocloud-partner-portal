import React, { useEffect, useState } from 'react';
import { Receipt, Upload, Download, Database, Activity, Calculator, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tabs, Tag,
  Table, THead, TBody, TR, TH, TD, LoadingState, ErrorState,
} from '../components/ui.jsx';
import { TrendAreaChart, StackedBarChart, Heatmap } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import { parseDailyUsageCsv, rollupBy, estimateCost, PRICING, loadSampleCsv } from '../api/csvParser.js';
import { CUSTOMERS } from '../data/customers.js';
import { bytes, compactNumber, currency, percent } from '../lib/format.js';
import { useApp } from '../lib/AppContext.jsx';

const RANGES = [
  { id: 'd7', label: 'Last 7 days', days: 7 },
  { id: 'd14', label: 'Last 14 days', days: 14 },
  { id: 'd30', label: 'Last 30 days', days: 30 },
];

export default function UsageBillingView() {
  const { isLive, canSeeRevenue } = useApp();
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState([]);
  const [usageSource, setUsageSource] = useState(null);
  const [reportsBucket, setReportsBucket] = useState(null);
  const [heatmap, setHeatmap] = useState([]);
  const [csvText, setCsvText] = useState('');
  const [parsed, setParsed] = useState([]);
  const [range, setRange] = useState('d30');
  const [resaleMultiplier, setResaleMultiplier] = useState(2.1);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    setLoading(true);
    Promise.all([
      b2.getDailyUsage({ days: 30 }),
      b2.getActivityHeatmap(),
      isLive ? Promise.resolve('') : loadSampleCsv(),
    ]).then(([{ usage: u, source, reportsBucketName }, { cells }, csv]) => {
      setUsage(u);
      setUsageSource(source);
      if (reportsBucketName) setReportsBucket(reportsBucketName);
      setHeatmap(cells);
      setCsvText(csv);
      setParsed(isLive ? [] : parseDailyUsageCsv(csv));
      setLoading(false);
    }).catch((e) => { setError(e?.message || String(e)); setLoading(false); });
  };

  useEffect(load, [isLive]);

  if (error) return <ErrorState title="Could not load usage data" message={error} onRetry={load} />;
  if (loading) return <LoadingState label="Downloading and parsing daily usage CSV" />;

  // Only show the "not available" warning when the server explicitly failed to find
  // the reports bucket. Zero-valued data (e.g. master account with no direct storage)
  // is valid — don't warn just because all metrics happen to be 0.
  const noLiveData = isLive && usageSource === 'no-data';
  const bucketLabel = reportsBucket || 'b2-reports-<accountId>';
  const days = RANGES.find((r) => r.id === range).days;
  const windowed = usage.slice(-days);
  const sum = windowed.reduce((acc, d) => {
    acc.storage = Math.max(acc.storage, d.storageBytes);
    acc.upload += d.uploadBytes;
    acc.egress += d.egressBytes;
    acc.classA += d.classATxn;
    acc.classB += d.classBTxn;
    acc.classC += d.classCTxn;
    acc.classD += d.classDTxn || 0;
    return acc;
  }, { storage: 0, upload: 0, egress: 0, classA: 0, classB: 0, classC: 0, classD: 0 });

  // Cost model — rough monthly using current windowed averages
  const monthlyAvg = days < 30 ? sum.egress * (30 / days) : sum.egress;
  const cost = estimateCost({
    storageBytesAvg: sum.storage,
    downloadBytes: monthlyAvg,
    classDTxn: (sum.classD ?? 0) * (30 / days),
    days: 30,
  });

  // Reseller margin model
  const monthlyCogs = cost.total;
  const monthlyRevenue = monthlyCogs * resaleMultiplier;
  const monthlyMargin = monthlyRevenue - monthlyCogs;

  // Per-customer rollup from CSV
  const perCustomer = rollupBy(parsed, 'sub_account_id');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Usage & billing"
        subtitle={isLive ? 'Storage, egress, and transaction data is updated daily.' : `All values on this page are derived from Backblaze B2 Usage Report CSV files stored in the \`${bucketLabel}/<YYYY-MM-DD>/\` reports bucket. Filenames vary by report type, for example \`usage.account-<accountId>.csv\`. The B2 Native API does not expose these Usage Report aggregates as a JSON endpoint.`}
        actions={!isLive ? <Tag variant="warn"><FileSpreadsheet size={11} className="mr-1" /> CSV-driven</Tag> : null}
      />

      {noLiveData && (
        <div className="flex items-start gap-3 rounded-lg border border-accent-amber/30 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Usage data not available.</span>{' '}
            All metrics on this page are derived from the Daily Usage CSV report stored in{' '}
            <code className="text-ink-200">{bucketLabel}</code>. No CSV files were found in that bucket, so all values show zero.{' '}
            <a
              href="https://secure.backblaze.com/reports.htm"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-white"
            >
              Enable at backblaze.com/reports.htm
            </a>
          </div>
        </div>
      )}

      {/* Data sources explanation */}
      <Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-300">Official billing data</h4>
            <p className="text-[11.5px] leading-relaxed text-ink-300">
              Storage, egress, upload volume, and transaction-class totals are sourced from{' '}
              <span className="text-ink-100">Backblaze B2 Usage Reports</span>,
              the daily usage ledger used for fee calculation. Most bucket usage values are reported by bucket and UTC day; some transaction totals may appear as account-level or region-level rows rather than bucket-level rows.
            </p>
          </div>
          <div>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-300">Per-key activity attribution</h4>
            <p className="text-[11.5px] leading-relaxed text-ink-300">
              Per-key activity attribution requires{' '}
              <span className="text-ink-100">Bucket Access Logs</span>{' '}
              to be enabled on each relevant source bucket. Access log records include an{' '}
              <code className="text-ink-200">Identity</code> field, which can identify the application key as{' '}
              <code className="text-ink-200">identity:applicationKey:&lt;applicationKeyId&gt;</code>.
              Buckets without access logging enabled will not provide historical per-key activity data, and unauthenticated or internal/system requests may not map cleanly to an application key.
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-md bg-accent-amber/5 px-3 py-2 text-[11px] leading-relaxed text-accent-amber ring-1 ring-inset ring-accent-amber/20">
          <span className="font-semibold">Reconciliation note:</span>{' '}
          Usage Reports may show official account or bucket usage even when key-level attribution is unavailable because Bucket Access Logs were disabled, delayed, incomplete, duplicated, or not configured for the relevant bucket.
          Per-key totals derived from access logs are operational telemetry only, not authoritative billing records.
          Access log delivery is best-effort; most logs are expected within a few hours, but delivery timing is not guaranteed.
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <Tabs tabs={RANGES} value={range} onChange={setRange} />
        <div className="flex items-center gap-2 text-xs">
          <SourceBadge source="csv" />
          <SourceBadge source="derived" />
        </div>
      </div>

      {/* Hero metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Storage (avg)" value={bytes(sum.storage)} source="csv" icon={<Database size={14} />} accent="red" />
        <MetricCard label={`Egress · ${days}d`} value={bytes(sum.egress)} source="csv" icon={<Download size={14} />} accent="teal" />
        <MetricCard label={`Uploads · ${days}d`} value={bytes(sum.upload)} source="csv" icon={<Upload size={14} />} accent="violet" />
        <MetricCard
          label={`Transactions · ${days}d`}
          value={compactNumber(sum.classA + sum.classB + sum.classC + sum.classD)}
          unit="A+B+C+D"
          source="csv"
          icon={<Activity size={14} />}
          accent="amber"
        />
      </div>

      {/* Trend chart */}
      <Card>
        <CardHeader
          title="Usage trend"
          subtitle="Daily storage average, uploads, egress and transactions from the parsed CSV"
          action={<SourceBadge source="csv" />}
        />
        <TrendAreaChart
          data={windowed}
          series={[
            { key: 'storageBytes', name: 'Storage', color: '#E61F18', format: bytes },
            { key: 'egressBytes', name: 'Egress', color: '#3DD9D6', format: bytes },
            { key: 'uploadBytes', name: 'Uploads', color: '#9B7CFF', format: bytes },
          ]}
          yFormatter={bytes}
          height={280}
        />
      </Card>

      {/* Cost model */}
      {canSeeRevenue ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Cost model · projected monthly"
              subtitle="Backblaze public list pricing applied to the windowed averages. Resellers typically negotiate volume discounts."
              icon={<Calculator size={16} />}
              action={<SourceBadge source="derived" />}
            />
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Component</TH>
                  <TH>Rate</TH>
                  <TH className="text-right">Quantity</TH>
                  <TH className="text-right">Cost</TH>
                </TR>
              </THead>
              <TBody>
                <TR hover={false}>
                  <TD className="text-ink-100">Storage</TD>
                  <TD className="text-ink-300">$6.95/TB·month</TD>
                  <TD className="text-right font-mono">{bytes(sum.storage)}</TD>
                  <TD className="text-right font-mono text-bb-red">{currency(cost.storageCost)}</TD>
                </TR>
                <TR hover={false}>
                  <TD className="text-ink-100">Egress (billable)</TD>
                  <TD className="text-ink-300">first 3× storage free, then {currency(PRICING.egressPerGb, { decimals: 4 })}/GB</TD>
                  <TD className="text-right font-mono">{bytes(monthlyAvg)}</TD>
                  <TD className="text-right font-mono text-bb-red">{currency(cost.egressCost)}</TD>
                </TR>
                <TR hover={false}>
                  <TD className="text-ink-100">Class A (uploads)</TD>
                  <TD className="text-accent-green">always free</TD>
                  <TD className="text-right font-mono">{compactNumber((sum.classA / days) * 30)}</TD>
                  <TD className="text-right font-mono text-accent-green">$0.00</TD>
                </TR>
                <TR hover={false}>
                  <TD className="text-ink-100">Class B (downloads)</TD>
                  <TD className="text-accent-green">always free</TD>
                  <TD className="text-right font-mono">{compactNumber((sum.classB / days) * 30)}</TD>
                  <TD className="text-right font-mono text-accent-green">$0.00</TD>
                </TR>
                <TR hover={false}>
                  <TD className="text-ink-100">Class C (list / metadata)</TD>
                  <TD className="text-accent-green">always free</TD>
                  <TD className="text-right font-mono">{compactNumber((sum.classC / days) * 30)}</TD>
                  <TD className="text-right font-mono text-accent-green">$0.00</TD>
                </TR>
                <TR hover={false}>
                  <TD className="text-ink-100">Class D (event notifications)</TD>
                  <TD className="text-ink-300">first 2,500/day free, then {currency(PRICING.classDPer10k, { decimals: 4 })}/10k</TD>
                  <TD className="text-right font-mono">{compactNumber((sum.classD ?? 0) * (30 / days))}</TD>
                  <TD className="text-right font-mono text-bb-red">{currency(cost.classDCost)}</TD>
                </TR>
              </TBody>
              <THead>
                <TR hover={false}>
                  <TH className="text-ink-100 text-base normal-case tracking-normal" colSpan={3}>
                    Projected monthly COGS
                  </TH>
                  <TH className="text-right text-ink-100 text-base normal-case tracking-normal">
                    {currency(cost.total)}
                  </TH>
                </TR>
              </THead>
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Reseller margin model"
              subtitle="Adjust your resale multiplier"
              icon={<Receipt size={16} />}
              action={<SourceBadge source="derived" />}
            />
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="text-ink-300">Resale multiplier</span>
                  <span className="font-mono text-ink-100">{resaleMultiplier.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min="1.2" max="4.0" step="0.05"
                  value={resaleMultiplier}
                  onChange={(e) => setResaleMultiplier(Number(e.target.value))}
                  className="w-full accent-bb-red"
                />
                <div className="mt-1 flex justify-between text-[10px] text-ink-400">
                  <span>1.2×</span><span>2.0×</span><span>3.0×</span><span>4.0×</span>
                </div>
              </div>
              <div className="space-y-2 rounded-lg bg-ink-900/60 p-3 ring-1 ring-ink-700">
                <Row label="COGS / month" value={currency(monthlyCogs)} />
                <Row label="Sell price / month" value={currency(monthlyRevenue)} accent="text-ink-100" />
                <hr className="border-ink-700" />
                <Row label="Gross margin / month" value={currency(monthlyMargin)} accent="text-accent-green" />
                <Row label="Margin %" value={percent(monthlyMargin / monthlyRevenue, 1)} accent="text-accent-green" />
              </div>
              <p className="text-[11px] leading-relaxed text-ink-400">
                Margin assumes flat passthrough plus your multiplier. Real reseller models often layer custom egress allowances, support tiers, and SLAs on top.
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <Card>
          <p className="py-4 text-center text-xs text-ink-400">Cost model and margin data are available to partner administrators only.</p>
        </Card>
      )}

      {/* CSV-derived per-customer rollup — hidden in live mode (requires CSV reports) */}
      {!isLive && <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Per-customer rollup · from parsed CSV</h3>
            <p className="mt-0.5 text-xs text-ink-300">
              Built by streaming the daily usage CSV and grouping by sub_account_id (see <code className="text-ink-200">src/api/csvParser.js</code>)
            </p>
          </div>
          <SourceBadge source="csv" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Sub-account</TH>
              <TH>Customer</TH>
              <TH className="text-right">Storage avg</TH>
              <TH className="text-right">Uploads</TH>
              <TH className="text-right">Downloads</TH>
              <TH className="text-right">Class A</TH>
              <TH className="text-right">Class B</TH>
              <TH className="text-right">Class C</TH>
            </TR>
          </THead>
          <TBody>
            {perCustomer.map((row) => {
              const cust = CUSTOMERS.find((c) => c.accountId === row.sub_account_id);
              return (
                <TR key={row.sub_account_id} hover={false}>
                  <TD className="font-mono text-[11.5px] text-ink-200">{row.sub_account_id}</TD>
                  <TD className="text-ink-100">{cust?.name || '—'}</TD>
                  <TD className="text-right font-mono">{bytes(row.storage_bytes_avg)}</TD>
                  <TD className="text-right font-mono">{bytes(row.upload_bytes)}</TD>
                  <TD className="text-right font-mono">{bytes(row.download_bytes)}</TD>
                  <TD className="text-right font-mono">{compactNumber(row.class_a_txn)}</TD>
                  <TD className="text-right font-mono">{compactNumber(row.class_b_txn)}</TD>
                  <TD className="text-right font-mono">{compactNumber(row.class_c_txn)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>}

      {/* Heatmap */}
      <Card>
        <CardHeader
          title="Request activity heatmap · 14 days × 24 hours"
          subtitle="Useful for sizing GPU job windows and bandwidth bursts"
          action={<SourceBadge source="csv" />}
        />
        <Heatmap cells={heatmap} />
      </Card>

      {/* Raw CSV preview — demo mode only */}
      {!isLive && (
        <Card padding="p-0">
          <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold text-ink-100">Raw CSV preview</h3>
              <p className="mt-0.5 text-xs text-ink-300">
                First {Math.min(20, csvText.split('\n').length - 1)} rows from the bundled sample (replace with the CSV pulled from <code>{bucketLabel}/&lt;YYYY-MM-DD&gt;/</code>)
              </p>
            </div>
            <Tag variant="info">{csvText.split('\n').length - 1} rows · {csvText.split(',').length / (csvText.split('\n').length - 1) | 0} cols/row</Tag>
          </div>
          <pre className="max-h-72 overflow-auto bg-ink-950/80 p-4 text-[11px] text-ink-300">
{csvText.split('\n').slice(0, 20).join('\n')}
          </pre>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, accent }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-ink-300">{label}</span>
      <span className={"text-right font-mono " + (accent || 'text-ink-100')}>{value}</span>
    </div>
  );
}
