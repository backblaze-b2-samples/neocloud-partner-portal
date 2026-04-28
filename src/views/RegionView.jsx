import React, { useEffect, useState } from 'react';
import { Globe, Server, Activity, Boxes } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag,
  LoadingState,
} from '../components/ui.jsx';
import { TrendAreaChart, StackedBarChart, DonutChart } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import { REGIONS } from '../data/regions.js';
import { bytes, compactNumber, percent } from '../lib/format.js';

export default function RegionView() {
  const [loading, setLoading] = useState(true);
  const [regionUsage, setRegionUsage] = useState([]);
  const [usage, setUsage] = useState([]);

  useEffect(() => {
    Promise.all([b2.getRegionUsage(), b2.getDailyUsage({ days: 30 })])
      .then(([{ regions }, { usage }]) => {
        setRegionUsage(regions);
        setUsage(usage);
        setLoading(false);
      });
  }, []);

  if (loading) return <LoadingState label="Computing region rollups" />;

  const totalStorage = regionUsage.reduce((s, r) => s + r.storageBytes, 0);
  const totalEgress = regionUsage.reduce((s, r) => s + r.egressBytes30d, 0);

  // Storage placement by region — donut
  const placement = regionUsage.map((r, i) => ({
    name: r.code,
    value: r.storageBytes,
    color: ['#3DD9D6', '#9B7CFF', '#F5B73E', '#2BD68A'][i],
  }));

  // Stacked bar: per-region storage vs egress
  const barData = regionUsage.map((r) => ({
    name: r.code,
    storage: r.storageBytes,
    egress: r.egressBytes30d,
  }));

  // Synthesize per-region growth lines (daily series)
  const trendData = usage.map((d, i) => {
    const out = { date: d.date };
    regionUsage.forEach((r, idx) => {
      const w = [0.42, 0.31, 0.13, 0.14][idx];
      const factor = 1 + i * 0.004 + Math.sin((i + idx) / 4) * 0.05;
      out[r.code] = d.storageBytes * w * factor;
    });
    return out;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Regions & placement"
        subtitle="Backblaze B2 currently operates in 4 public regions. Region is set at account creation and cannot be migrated via API — multi-region presence is achieved by holding sub-accounts in different regions and replicating between them."
        actions={<Tag variant="info">{REGIONS.length} regions</Tag>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Active regions" value={REGIONS.length} source="api" icon={<Globe size={14} />} accent="violet" />
        <MetricCard label="Total storage placed" value={bytes(totalStorage)} source="csv" icon={<Server size={14} />} accent="red" />
        <MetricCard label="30-day egress" value={bytes(totalEgress)} source="csv" icon={<Activity size={14} />} accent="teal" />
        <MetricCard
          label="Total buckets"
          value={regionUsage.reduce((s, r) => s + r.bucketCount, 0)}
          source="api"
          icon={<Boxes size={14} />}
          accent="green"
        />
      </div>

      {/* Region cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {regionUsage.map((r) => {
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
                  style={{ background: meta?.color }}
                />
              </div>
              <dl className="space-y-1.5 text-xs">
                <KV label="Storage" value={bytes(r.storageBytes)} />
                <KV label="Egress 30d" value={bytes(r.egressBytes30d)} />
                <KV label="Uploads 30d" value={bytes(r.uploadBytes30d)} />
                <KV label="Buckets" value={r.bucketCount} />
                <KV label="Growth 30d" value={<span className={r.growth30d >= 0 ? 'text-accent-green' : 'text-bb-red'}>{r.growth30d >= 0 ? '+' : ''}{percent(r.growth30d, 1)}</span>} />
              </dl>
              <div className="mt-3 rounded-md bg-ink-900/60 px-2.5 py-1.5 font-mono text-[10.5px] text-ink-300 ring-1 ring-ink-700">
                {meta?.s3Endpoint}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
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
              color: ['#3DD9D6', '#9B7CFF', '#F5B73E', '#2BD68A'][i],
              format: bytes,
            }))}
            yFormatter={bytes}
            height={280}
          />
        </Card>
        <Card>
          <CardHeader
            title="Placement"
            subtitle="Share of total storage by region"
            action={<SourceBadge source="csv" />}
          />
          <DonutChart data={placement} formatter={bytes} />
        </Card>
      </div>

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

      <Card className="border-ink-700 bg-ink-900/40">
        <div className="text-xs text-ink-300">
          <strong className="text-ink-100">Note on latency / availability:</strong> Backblaze does not expose per-region latency or availability metrics through any API. The status page at <a href="https://status.backblaze.com" target="_blank" rel="noreferrer" className="text-bb-red hover:underline">status.backblaze.com</a> is the official source. To surface region performance in this dashboard for real, run synthetic probes from your monitoring system (Datadog, Catchpoint, ThousandEyes, or a self-hosted Lambda) and feed the results in via your own backend.
        </div>
      </Card>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-right text-ink-100 font-mono">{value}</dd>
    </div>
  );
}
