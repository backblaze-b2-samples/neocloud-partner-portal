import React, { useEffect, useState, useMemo } from 'react';
import {
  Database, Download, Activity, Users, Boxes, Globe, DollarSign, TrendingUp, FolderTree, ChevronDown, AlertTriangle, RefreshCcw,
} from 'lucide-react';
import {
  PageHeader, MetricCard, Card, CardHeader, SourceBadge, HealthPill,
  Tag, Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import { TrendAreaChart, DonutChart, Sparkline, CHART_COLORS } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';
import { useNav } from '../lib/nav.js';
import { bytes, compactNumber, currency, percent, relativeTime } from '../lib/format.js';
import { useApp } from '../lib/AppContext.jsx';

const SERIES_STORAGE = [{ key: 'storageBytes', name: 'Storage under management', color: '#E61F18', format: bytes }];
const SERIES_EGRESS = [
  { key: 'egressBytes', name: 'Egress', color: '#3DD9D6', format: bytes },
  { key: 'uploadBytes', name: 'Uploads', color: '#9B7CFF', format: bytes },
];

export default function ExecutiveOverview() {
  const { navigate } = useNav();
  const { canSeeRevenue } = useApp();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [usageSource, setUsageSource] = useState(null);
  const [reportsBucket, setReportsBucket] = useState(null);
  const [groupId, setGroupId] = useState('all');
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [, forceTick] = useState(0);

  const loadAll = () => Promise.all([
    partner.getCustomers(),
    partner.listGroups(),
    b2.listBuckets(),
    b2.getDailyUsage({ days: 30 }),
    b2.getRegionUsage(),
    b2.getObjectSyncStatus(),
  ]).then(([{ customers }, { groups }, { buckets }, { usage, source, reportsBucketName }, { regions }, { jobRanAt }]) => {
    setData({ allCustomers: customers, groups, buckets, usage, regions });
    setUsageSource(source);
    if (reportsBucketName) setReportsBucket(reportsBucketName);
    setLastSyncAt(jobRanAt);
    setLoading(false);
  });

  useEffect(() => { loadAll(); }, []);

  // Bump every 30s so "Last sync Xm ago" stays current.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const onSync = async () => {
    setSyncing(true);
    try {
      await b2.syncAllAccounts();
    } catch (e) {
      console.warn('[ExecutiveOverview] sync-all failed:', e?.message || e);
    } finally {
      await loadAll();
      setSyncing(false);
    }
  };

  // Filter all metrics by selected group (or 'all' = unfiltered).
  // useMemo so we don't recompute on every render — only when group / data changes.
  const view = useMemo(() => {
    if (!data) return null;
    // Exclude ejected (active=false) sub-accounts from every Overview metric —
    // they appear only on the dedicated "Inactive" tab in PartnerView.
    const activeOnly = data.allCustomers.filter((c) => c.active !== false);
    const filteredCustomers = groupId === 'all'
      ? activeOnly
      : activeOnly.filter((c) => c.groupId === groupId);
    const customerIds = new Set(filteredCustomers.map((c) => c.id));
    const filteredBuckets = groupId === 'all'
      ? data.buckets
      : data.buckets.filter((b) => customerIds.has(b.customerId));
    const totals = filteredCustomers.reduce((acc, c) => {
      acc.storageBytes += c.storageBytes;
      acc.egressBytes30d += c.egressBytes30d;
      acc.txnA30d += c.txnA30d;
      acc.txnB30d += c.txnB30d;
      acc.txnC30d += c.txnC30d;
      acc.txnD30d += c.txnD30d || 0;
      acc.cogs30d += c.cogs30d;
      acc.revenue30d += c.revenue30d;
      return acc;
    }, { storageBytes: 0, egressBytes30d: 0, txnA30d: 0, txnB30d: 0, txnC30d: 0, txnD30d: 0, cogs30d: 0, revenue30d: 0 });
    return { customers: filteredCustomers, buckets: filteredBuckets, totals };
  }, [data, groupId]);

  if (loading || !data) return <LoadingState label="Pulling latest metrics" />;
  const { customers, buckets, totals } = view;
  const { groups, usage, regions } = data;
  const selectedGroup = groups.find((g) => g.groupId === groupId);

  // Derived metrics — mark with SourceBadge "derived"
  const grossMargin = totals.revenue30d > 0 ? (totals.revenue30d - totals.cogs30d) / totals.revenue30d : 0;
  const sparkStorage = usage.map((d) => ({ value: d.storageBytes }));
  const sparkEgress  = usage.map((d) => ({ value: d.egressBytes }));
  const sparkTxn     = usage.map((d) => ({ value: (d.classATxn || 0) + (d.classBTxn || 0) + (d.classCTxn || 0) + (d.classDTxn || 0) }));
  const sparkRevenue = usage.map((d) => ({ value: d.egressBytes * 2.1 * 0.01 })); // rough MRR proxy from egress

  // Period-over-period deltas — only meaningful when we have ≥ 2 days of data.
  // Split the usage window in half and compare the two halves.
  const half = Math.floor(usage.length / 2);
  function periodDelta(key) {
    if (usage.length < 4) return null; // not enough data for a meaningful comparison
    const prev = usage.slice(0, half).reduce((s, d) => s + (d[key] || 0), 0);
    const curr = usage.slice(half).reduce((s, d) => s + (d[key] || 0), 0);
    if (prev === 0) return null;
    return (curr - prev) / prev;
  }
  const deltaStorage = periodDelta('storageBytes');
  const deltaEgress  = periodDelta('egressBytes');
  const deltaTxn     = periodDelta('classATxn'); // class A as proxy for overall activity
  const deltaRevenue = periodDelta('egressBytes'); // revenue tracks egress

  const customerShare = customers
    .map((c) => ({ name: c.name, value: c.storageBytes, color: undefined }))
    .sort((a, b) => b.value - a.value);
  customerShare.forEach((c, i) => (c.color = CHART_COLORS[i % CHART_COLORS.length]));

  const regionShare = regions.map((r, i) => ({
    name: r.code, value: r.storageBytes, color: ['#3DD9D6', '#9B7CFF', '#F5B73E', '#2BD68A'][i],
  }));

  const topCustomers = [...customers].sort((a, b) => b.revenue30d - a.revenue30d).slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Executive view"
        title="Backblaze B2 — Neocloud Partner Operations"
        subtitle="Live snapshot of your reseller footprint across customers, regions, and revenue. Storage, egress and transactions roll up from daily usage CSV reports; bucket and key metadata come from the B2 Native and Partner APIs."
        actions={
          <div className="flex items-center gap-2">
            <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
            {syncing
              ? <span className="text-[10.5px] text-accent-teal animate-pulse">
                  Syncing all accounts from B2…
                </span>
              : lastSyncAt && (
                  <span className="text-[10.5px] text-ink-400" title={new Date(lastSyncAt).toLocaleString()}>
                    Last sync {relativeTime(lastSyncAt)}
                  </span>
                )}
            <button
              onClick={onSync}
              disabled={syncing}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-60"
              title="Re-walk every sub-account's buckets on B2 to refresh object counts and storage size. Takes ~1 minute for 47 accounts."
            >
              <RefreshCcw size={12} className={syncing ? 'animate-spin' : undefined} />
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        }
      />

      {usageSource === 'no-data' && (
        <div className="flex items-start gap-3 rounded-lg border border-accent-amber/30 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Usage Reports not yet available.</span>{' '}
            Storage, egress, and transaction charts require the daily CSV report stored in{' '}
            <code className="text-ink-200">{reportsBucket || 'b2-reports-<accountId>'}</code>.
            Reports are generated once per day — if you just enabled them, check back tomorrow.{' '}
            <a
              href="https://secure.backblaze.com/reports.htm"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-white"
            >
              Enable Usage Reports at backblaze.com/reports.htm
            </a>
          </div>
        </div>
      )}

      {selectedGroup && (
        <div className="-mt-2 text-[11.5px] text-ink-400">
          Filtered by group <span className="font-mono text-ink-200">{selectedGroup.groupName}</span> · {customers.length} of {data.allCustomers.length} customers
        </div>
      )}

      {/* Hero metrics row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Storage under management"
          value={bytes(totals.storageBytes)}
          delta={deltaStorage}
          source="csv"
          icon={<Database size={14} />}
          accent="red"
        >
          <Sparkline data={sparkStorage} color="#E61F18" />
        </MetricCard>
        <MetricCard
          label="30-day egress"
          value={bytes(totals.egressBytes30d)}
          delta={deltaEgress}
          source="csv"
          icon={<Download size={14} />}
          accent="teal"
        >
          <Sparkline data={sparkEgress} color="#3DD9D6" />
        </MetricCard>
        <MetricCard
          label="API transactions (30d)"
          value={compactNumber(totals.txnA30d + totals.txnB30d + totals.txnC30d + totals.txnD30d)}
          unit="A + B + C"
          delta={deltaTxn}
          source="csv"
          icon={<Activity size={14} />}
          accent="violet"
        >
          <Sparkline data={sparkTxn} color="#A78BFA" />
        </MetricCard>
        {canSeeRevenue && (
          <MetricCard
            label="Estimated MRR"
            value={currency(totals.revenue30d, { compact: true })}
            delta={deltaRevenue}
            deltaLabel="vs prev 30d"
            source="derived"
            icon={<DollarSign size={14} />}
            accent="green"
          >
            <Sparkline data={sparkRevenue} color="#2BD68A" />
          </MetricCard>
        )}
      </div>

      {/* Secondary metrics row
          Bucket count: sum of b2Stats.bucketCount per member (B2 Native API data returned
            inside b2_list_group_members). b2_list_buckets on the master account only sees
            master-account buckets, not the sub-account buckets where customer data lives.
          Region count: derived — unique regions across filtered customers. getRegionUsage()
            only returns CSV-active regions and misses zero-activity regions. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard label="Active customers" value={customers.length} source="api" icon={<Users size={14} />} accent="amber" />
        <MetricCard
          label="Active buckets"
          value={customers.reduce((s, c) => s + (c.activeBuckets || 0), 0)}
          source="api"
          icon={<Boxes size={14} />}
          accent="teal"
        />
        <MetricCard
          label="Active regions"
          value={new Set(customers.map((c) => c.region).filter(Boolean)).size}
          source="derived"
          icon={<Globe size={14} />}
          accent="violet"
        />
        {canSeeRevenue && (
          <MetricCard
            label="Gross margin (30d)"
            value={percent(grossMargin, 1)}
            source="derived"
            icon={<TrendingUp size={14} />}
            accent="green"
          />
        )}
        {canSeeRevenue && (
          <MetricCard
            label="COGS (30d)"
            value={currency(totals.cogs30d, { compact: true })}
            source="derived"
            icon={<DollarSign size={14} />}
            accent="red"
          />
        )}
      </div>

      {/* Trend charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Storage growth · 30 days"
            subtitle="Aggregated across all sub-accounts and regions · Reports reflect prior-day usage, available shortly after midnight UTC"
            icon={<Database size={16} />}
            action={<SourceBadge source="csv" />}
          />
          <TrendAreaChart data={usage} series={SERIES_STORAGE} yFormatter={bytes} />
        </Card>
        <Card>
          <CardHeader
            title="Storage by customer"
            icon={<Users size={16} />}
            action={<SourceBadge source="csv" />}
          />
          <DonutChart data={customerShare.slice(0, 6)} formatter={bytes} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Egress vs uploads · 30 days"
            subtitle="High egress-to-storage ratios indicate read-heavy workloads (CDN origin, training data lakes)"
            icon={<Download size={16} />}
            action={<SourceBadge source="csv" />}
          />
          <TrendAreaChart data={usage} series={SERIES_EGRESS} yFormatter={bytes} />
        </Card>
        <Card>
          <CardHeader
            title="Storage by region"
            icon={<Globe size={16} />}
            action={<SourceBadge source="csv" />}
          />
          <DonutChart data={regionShare} formatter={bytes} />
        </Card>
      </div>

      {/* Top customers */}
      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Top revenue customers · last 30 days</h3>
            <p className="mt-0.5 text-xs text-ink-300">Sorted by estimated reseller revenue</p>
          </div>
          <SourceBadge source="derived" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Customer</TH>
              <TH>Industry</TH>
              <TH className="text-right">Storage</TH>
              <TH className="text-right">Egress (30d)</TH>
              {canSeeRevenue && <TH className="text-right">Revenue (30d)</TH>}
              {canSeeRevenue && <TH className="text-right">Margin</TH>}
              <TH>Health</TH>
            </TR>
          </THead>
          <TBody>
            {topCustomers.map((c) => {
              const margin = (c.revenue30d - c.cogs30d) / c.revenue30d;
              return (
                <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                  <TD>
                    <div className="font-medium text-ink-100">{c.name}</div>
                    <div className="text-[11px] text-ink-400">{c.accountId}</div>
                  </TD>
                  <TD className="text-ink-300">{c.industry}</TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(c.storageBytes)}</TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(c.egressBytes30d)}</TD>
                  {canSeeRevenue && <TD className="text-right font-mono text-ink-100">{currency(c.revenue30d, { compact: true })}</TD>}
                  {canSeeRevenue && <TD className="text-right font-mono text-accent-green">{percent(margin, 0)}</TD>}
                  <TD><HealthPill status={c.health} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      {!usageSource || usageSource === 'mock' ? (
        <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-4 text-[11px] text-ink-400">
          <strong className="text-ink-200">Data sources:</strong>{' '}
          <SourceBadge source="api" /> bucket and key metadata via B2 Native API{' '}
          ·{' '}
          <SourceBadge source="csv" /> storage / egress / transactions from daily usage CSV{' '}
          ·{' '}
          <SourceBadge source="partner" /> sub-account list via Partner API v3{' '}
          ·{' '}
          <SourceBadge source="derived" /> revenue, margin, growth calculated from CSV + your reseller pricing
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// Group filter — switches the dashboard between "All groups" and one Group.
// =============================================================================
function GroupFilter({ groups, value, onChange }) {
  return (
    <div className="relative">
      <FolderTree size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 cursor-pointer appearance-none rounded-md border border-ink-700 bg-ink-850 pl-7 pr-7 text-xs font-medium text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
      >
        <option value="all">All groups</option>
        {groups.map((g) => (
          <option key={g.groupId} value={g.groupId}>{g.groupName}</option>
        ))}
      </select>
    </div>
  );
}
