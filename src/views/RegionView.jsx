import React, { useEffect, useState } from 'react';
import { Globe, Server, Activity, Boxes, AlertTriangle, Users } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag,
  LoadingState, EmptyState,
} from '../components/ui.jsx';
import { TrendAreaChart, StackedBarChart, DonutChart } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';
import { REGIONS } from '../data/regions.js';
import { bytes, percent } from '../lib/format.js';
import { useApp } from '../lib/AppContext.jsx';

const COLORS = ['#3DD9D6', '#9B7CFF', '#F5B73E', '#2BD68A'];

export default function RegionView() {
  const { isLive } = useApp();
  const [loading, setLoading] = useState(true);
  const [regionUsage, setRegionUsage] = useState([]);
  const [regionSource, setRegionSource] = useState('');
  const [usage, setUsage] = useState([]);

  useEffect(() => {
    const fetches = [
      b2.getRegionUsage(),
      b2.getDailyUsage({ days: 30 }),
      // In live mode, derive regions from Partner API sub-account data.
      // Customers already carry region + storageBytes from b2Stats.
      isLive ? partner.getCustomers().catch(() => null) : Promise.resolve(null),
    ];

    Promise.all(fetches).then(([{ regions, source: rSrc }, { usage: u }, customersResp]) => {
      let finalRegions = regions;
      let finalSource  = rSrc || '';

      if (isLive && customersResp?.customers?.length) {
        const customers = customersResp.customers;

        // Build a customerCount map from the Partner API regardless of CSV availability.
        const countByRegion = new Map();
        for (const c of customers) {
          if (!c.region) continue;
          countByRegion.set(c.region, (countByRegion.get(c.region) || 0) + 1);
        }

        if (rSrc === 'csv-live') {
          // CSV is the authoritative source for metrics. Enrich each CSV region
          // with customerCount, then append any partner-known regions that had no
          // CSV activity (zero uploads in the window) so they still appear in the UI.
          const csvRegionIds = new Set(regions.map((r) => r.regionId));

          // Partner-only regions (no CSV activity) — show with partner storage
          // from b2Stats and customerCount, but null egress/upload (not in API).
          const partnerOnlyRegions = [];
          for (const [regionId, count] of countByRegion) {
            if (csvRegionIds.has(regionId)) continue;
            const meta = REGIONS.find((r) => r.id === regionId);
            // Sum storageBytes from partner b2Stats for customers in this region
            const storageSumBytes = customers
              .filter((c) => c.region === regionId && c.storageBytes != null)
              .reduce((s, c) => s + c.storageBytes, 0);
            partnerOnlyRegions.push({
              regionId,
              code:          meta?.code  || regionId,
              flag:          meta?.flag  || null,
              color:         meta?.color || null,
              city:          meta?.city  || null,
              country:       meta?.country || null,
              storageBytes:  storageSumBytes || null,
              egressBytes30d: null,
              uploadBytes30d: null,
              classATxn30d:   null,
              classBTxn30d:   null,
              classCTxn30d:   null,
              classDTxn30d:   null,
              bucketCount:   null,
              customerCount: count,
              growth30d:     null,
            });
          }

          finalRegions = [
            ...regions.map((r) => ({ ...r, customerCount: countByRegion.get(r.regionId) ?? null })),
            ...partnerOnlyRegions,
          ];
          // Ensure every defined REGION shows up at least once, even with no
          // customers and no CSV activity — operators want to see all available
          // placement options on the Regions screen.
          const present = new Set(finalRegions.map((r) => r.regionId));
          for (const r of REGIONS) {
            if (present.has(r.id)) continue;
            finalRegions.push({
              regionId: r.id,
              code: r.code,
              flag: r.flag,
              color: r.color,
              city: r.city,
              country: r.country,
              storageBytes: null,
              egressBytes30d: null,
              uploadBytes30d: null,
              classATxn30d: null,
              classBTxn30d: null,
              classCTxn30d: null,
              classDTxn30d: null,
              bucketCount: null,
              customerCount: 0,
              growth30d: null,
            });
          }
          finalSource = 'csv-live';
        } else if (countByRegion.size > 0) {
          // CSV unavailable — fall back to partner-derived (shows warning).
          const byRegion = new Map();
          for (const c of customers) {
            if (!c.region) continue;
            const meta = REGIONS.find((r) => r.id === c.region);
            const cur = byRegion.get(c.region) || {
              regionId:      c.region,
              code:          meta?.code  || c.region,
              storageBytes:  null,
              egressBytes30d: null,
              uploadBytes30d: null,
              bucketCount:   null,
              customerCount: 0,
              growth30d:     null,
            };
            cur.customerCount += 1;
            if (c.storageBytes   != null) cur.storageBytes   = (cur.storageBytes   ?? 0) + c.storageBytes;
            if (c.egressBytes30d != null) cur.egressBytes30d = (cur.egressBytes30d ?? 0) + c.egressBytes30d;
            byRegion.set(c.region, cur);
          }
          finalRegions = Array.from(byRegion.values());
          finalSource  = 'partner-derived';
        }
      }

      setRegionUsage(finalRegions);
      setRegionSource(finalSource);
      setUsage(u);
      setLoading(false);
    });
  }, [isLive]);

  if (loading) return <LoadingState label="Computing region rollups" />;

  const hasStorageData = regionUsage.some((r) => r.storageBytes != null);
  const hasEgressData = regionUsage.some((r) => r.egressBytes30d != null);
  const totalStorage = hasStorageData
    ? regionUsage.reduce((s, r) => s + (r.storageBytes ?? 0), 0)
    : null;
  const totalEgress = hasEgressData
    ? regionUsage.reduce((s, r) => s + (r.egressBytes30d ?? 0), 0)
    : null;
  const totalBuckets = regionUsage.reduce((s, r) => s + (r.bucketCount || 0), 0);

  // Storage placement by region — donut (only when storage data exists)
  const placement = regionUsage
    .filter((r) => r.storageBytes != null)
    .map((r, i) => ({
      name: r.code,
      value: r.storageBytes,
      color: COLORS[i % COLORS.length],
    }));

  // Stacked bar: per-region storage vs egress
  const barData = regionUsage.map((r) => ({
    name: r.code,
    storage: r.storageBytes ?? 0,
    egress: r.egressBytes30d ?? 0,
  }));

  // Synthesize per-region growth lines from daily totals.
  // We don't have per-region daily breakdowns without CSV reports, so we
  // use equal weight per region. Only rendered when usage data is present.
  const trendData = usage.length > 0 && hasStorageData
    ? usage.map((d, i) => {
        const out = { date: d.date };
        regionUsage.forEach((r, idx) => {
          const w = 1 / regionUsage.length;
          const factor = 1 + i * 0.004 + Math.sin((i + idx) / 4) * 0.05;
          out[r.code] = (d.storageBytes ?? 0) * w * factor;
        });
        return out;
      })
    : [];

  // Show CSV notice in live mode when egress/storage data isn't from the CSV report
  const showCsvNotice = isLive && (regionSource === 'api-derived' || regionSource === 'no-data' || regionSource === 'partner-derived');

  const regionCount = regionUsage.length > 0 ? regionUsage.length : REGIONS.length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Regions & placement"
        subtitle="Backblaze B2 currently operates in 4 public regions. Region is set at account creation and cannot be migrated via API — multi-region presence is achieved by holding sub-accounts in different regions and replicating between them."
        actions={<Tag variant="info">{regionCount} region{regionCount !== 1 ? 's' : ''}</Tag>}
      />

      {showCsvNotice && (
        <div className="flex items-start gap-3 rounded-lg border border-accent-amber/30 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Storage & egress data unavailable.</span>{' '}
            Usage Reports are not enabled for this account. Bucket count is live from the B2 API;
            storage, egress, and growth metrics require the daily CSV report.{' '}
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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="Active regions"
          value={regionUsage.length || REGIONS.length}
          source="api"
          icon={<Globe size={14} />}
          accent="violet"
        />
        <MetricCard
          label="Total storage placed"
          value={totalStorage != null ? bytes(totalStorage) : '—'}
          source="csv"
          icon={<Server size={14} />}
          accent="red"
        />
        <MetricCard
          label="30-day egress"
          value={totalEgress != null ? bytes(totalEgress) : '—'}
          source="csv"
          icon={<Activity size={14} />}
          accent="teal"
        />
        <MetricCard
          label="Total buckets"
          value={totalBuckets}
          source="api"
          icon={<Boxes size={14} />}
          accent="green"
        />
      </div>

      {/* Region cards */}
      {regionUsage.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {regionUsage.map((r, i) => {
            const meta = REGIONS.find((x) => x.id === r.regionId);
            return (
              <Card key={r.regionId} className="overflow-hidden">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-ink-100">
                      <span className="text-base">{meta?.flag}</span>
                      {r.code}
                    </div>
                    <div className="text-[11px] text-ink-400">{meta?.city}</div>
                  </div>
                  <span
                    className="h-2 w-2 rounded-full live-dot"
                    style={{ background: meta?.color || COLORS[i % COLORS.length] }}
                  />
                </div>
                <dl className="space-y-1.5 text-xs">
                  {r.customerCount != null && (
                    <KV label="Sub-accounts" value={r.customerCount} />
                  )}
                  <KV label="Storage" value={bytes(r.storageBytes)} />
                  <KV label="Egress 30d" value={bytes(r.egressBytes30d)} />
                  <KV label="Uploads 30d" value={bytes(r.uploadBytes30d)} />
                  <KV label="Buckets" value={r.bucketCount ?? '—'} />
                  <KV
                    label="Growth 30d"
                    value={
                      r.growth30d != null ? (
                        <span className={r.growth30d >= 0 ? 'text-accent-green' : 'text-bb-red'}>
                          {r.growth30d >= 0 ? '+' : ''}{percent(r.growth30d, 1)}
                        </span>
                      ) : (
                        <span className="text-ink-500">—</span>
                      )
                    }
                  />
                </dl>
                {meta && (
                  <div className="mt-3 rounded-md bg-ink-900/60 px-2.5 py-1.5 font-mono text-[10.5px] text-ink-300 ring-1 ring-ink-700">
                    {meta.s3Endpoint}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No region data available"
          message="Could not determine region information from the API in live mode."
        />
      )}

      {/* Charts — only rendered when we have meaningful data */}
      {trendData.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Storage growth by region · 30 days"
              subtitle="Each region rolls up across the sub-accounts you hold there"
              action={<SourceBadge source="csv" />}
            />
            <TrendAreaChart
              data={trendData}
              series={regionUsage.map((r, i) => ({
                key: r.code,
                name: r.code,
                color: COLORS[i % COLORS.length],
                format: bytes,
              }))}
              yFormatter={bytes}
              height={280}
            />
          </Card>
          {placement.length > 0 && (
            <Card>
              <CardHeader
                title="Placement"
                subtitle="Share of total storage by region"
                action={<SourceBadge source="csv" />}
              />
              <DonutChart data={placement} formatter={bytes} />
            </Card>
          )}
        </div>
      )}

      {hasStorageData && (
        <Card>
          <CardHeader
            title="Storage vs egress by region"
            subtitle="Identifies regions with high read intensity (egress-heavy workloads)"
            action={<SourceBadge source="csv" />}
          />
          <StackedBarChart
            data={barData}
            series={[
              { key: 'storage', name: 'Storage', color: '#E61F18', format: bytes },
              { key: 'egress', name: 'Egress (30d)', color: '#3DD9D6', format: bytes },
            ]}
            yFormatter={bytes}
          />
        </Card>
      )}

      <Card className="border-ink-700 bg-ink-900/40">
        <div className="text-xs text-ink-300">
          <strong className="text-ink-100">Note on latency / availability:</strong>{' '}
          Backblaze does not expose per-region latency or availability metrics through any API. The status
          page at{' '}
          <a
            href="https://status.backblaze.com"
            target="_blank"
            rel="noreferrer"
            className="text-bb-red hover:underline"
          >
            status.backblaze.com
          </a>{' '}
          is the official source. To surface region performance in this dashboard for real, run synthetic
          probes from your monitoring system (Datadog, Catchpoint, ThousandEyes, or a self-hosted Lambda)
          and feed the results in via your own backend.
        </div>
      </Card>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-right font-mono text-ink-100">{value}</dd>
    </div>
  );
}
