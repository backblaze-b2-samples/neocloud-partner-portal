// Business cockpit — the money lens on the portfolio. Reuses the per-customer
// revenue/cogs/growth already computed by partnerApi (computeBilling) and the
// daily usage series, then frames them as MRR, gross profit, margin, and
// at-risk / upsell signals. Partner-staff view (lives in the partner Shell).
import React, { useEffect, useMemo, useState } from 'react';
import {
  Wallet, TrendingUp, Percent, Users, AlertTriangle, ArrowUpRight, RefreshCcw,
} from 'lucide-react';
import {
  PageHeader, MetricCard, Card, CardHeader, Tabs, HealthPill,
  Table, THead, TBody, TR, TH, TD, LoadingState, ErrorState,
} from '../components/ui.jsx';
import { TrendAreaChart, DonutChart, CHART_COLORS } from '../components/charts.jsx';
import { currency, percent, deltaSign, compactNumber } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';

// Build a daily revenue/cost series whose 30-day sums tie out to the real
// portfolio totals, but whose shapes differ (revenue tracks stored data, cost
// tracks egress + storage) so the margin line is illustrative, not flat.
function revenueCostSeries(usage, totalRevenue, totalCogs) {
  if (!usage || usage.length === 0) return [];
  const revW = usage.map((d) => (d.storageBytes || 0) + (d.egressBytes || 0) * 0.4);
  const costW = usage.map((d) => (d.storageBytes || 0) * 0.35 + (d.egressBytes || 0) * 0.9);
  const sumRev = revW.reduce((s, n) => s + n, 0) || 1;
  const sumCost = costW.reduce((s, n) => s + n, 0) || 1;
  return usage.map((d, i) => {
    const revenue = totalRevenue * (revW[i] / sumRev);
    const cost = totalCogs * (costW[i] / sumCost);
    return { date: d.date, revenue, cost, profit: revenue - cost };
  });
}

// Period-over-period delta on a series key (second half vs first half).
function periodDelta(series, key) {
  if (!series || series.length < 4) return null;
  const half = Math.floor(series.length / 2);
  const prev = series.slice(0, half).reduce((s, d) => s + (d[key] || 0), 0);
  const curr = series.slice(half).reduce((s, d) => s + (d[key] || 0), 0);
  if (prev === 0) return null;
  return (curr - prev) / prev;
}

export default function CockpitView() {
  const { navigate } = useNav();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('risk');

  const load = () => {
    setError(''); setData(null);
    Promise.all([partner.getCustomers(), b2.getDailyUsage({ days: 30 })])
      .then(([{ customers }, { usage }]) => setData({ customers: customers || [], usage: usage || [] }))
      .catch((e) => setError(e?.message || String(e)));
  };
  useEffect(load, []);

  const view = useMemo(() => {
    if (!data) return null;
    const customers = data.customers.filter((c) => c.active !== false);
    const totals = customers.reduce(
      (a, c) => { a.revenue += c.revenue30d || 0; a.cogs += c.cogs30d || 0; return a; },
      { revenue: 0, cogs: 0 },
    );
    const grossProfit = totals.revenue - totals.cogs;
    const margin = totals.revenue > 0 ? grossProfit / totals.revenue : 0;
    const arpc = customers.length ? totals.revenue / customers.length : 0;
    const series = revenueCostSeries(data.usage, totals.revenue, totals.cogs);

    // revenue by reseller tier
    const tierMap = customers.reduce((acc, c) => {
      const k = c.plan || 'Unassigned';
      (acc[k] ||= { name: k, value: 0 });
      acc[k].value += c.revenue30d || 0;
      return acc;
    }, {});
    const byTier = Object.values(tierMap).sort((a, b) => b.value - a.value);
    byTier.forEach((t, i) => { t.color = CHART_COLORS[i % CHART_COLORS.length]; });

    const withProfit = customers.map((c) => ({ ...c, profit: (c.revenue30d || 0) - (c.cogs30d || 0) }));
    const leaders = [...withProfit].sort((a, b) => b.profit - a.profit).slice(0, 6);
    const atRisk = withProfit
      .filter((c) => c.health === 'risk' || c.health === 'attention' || (c.growth != null && c.growth < 0.02))
      .sort((a, b) => (a.growth ?? 0) - (b.growth ?? 0))
      .slice(0, 8);
    const upsell = withProfit
      .filter((c) => c.health === 'healthy' && c.growth != null && c.growth >= 0.12)
      .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0))
      .slice(0, 8);

    return {
      customers, totals, grossProfit, margin, arpc, series, byTier,
      leaders, atRisk, upsell,
      revDelta: periodDelta(series, 'revenue'),
      profitDelta: periodDelta(series, 'profit'),
    };
  }, [data]);

  if (error) return <ErrorState title="Could not load cockpit" message={error} onRetry={load} />;
  if (!view) return <LoadingState label="Crunching the numbers" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Business cockpit"
        subtitle="Your reseller P&L at a glance — monthly recurring revenue, gross margin, and the customers driving (or draining) profit."
        actions={
          <button onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800">
            <RefreshCcw size={12} /> Refresh
          </button>
        }
      />

      {/* Hero — the money row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="MRR" value={currency(view.totals.revenue, { compact: true })} delta={view.revDelta} deltaLabel="vs prev 15d" source="derived" accent="green" icon={<Wallet size={16} />} />
        <MetricCard label="Gross profit / mo" value={currency(view.grossProfit, { compact: true })} delta={view.profitDelta} deltaLabel="vs prev 15d" source="derived" accent="teal" icon={<TrendingUp size={16} />} />
        <MetricCard label="Gross margin" value={percent(view.margin, 1)} unit="revenue − B2 cost" source="derived" accent="violet" icon={<Percent size={16} />} />
        <MetricCard label="Avg revenue / customer" value={currency(view.arpc, { compact: true })} unit={`${view.customers.length} active`} source="derived" accent="amber" icon={<Users size={16} />} />
      </div>

      {/* Revenue vs cost trend + revenue mix */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Revenue vs Backblaze cost" subtitle="Modeled daily from usage; 30-day totals tie to MRR + COGS." icon={<TrendingUp size={16} />} />
          <TrendAreaChart
            data={view.series}
            xKey="date"
            height={240}
            yFormatter={(n) => currency(n, { compact: true })}
            series={[
              { key: 'revenue', name: 'Revenue', color: '#2BD68A', format: (n) => currency(n) },
              { key: 'cost', name: 'Backblaze cost', color: '#E61F18', format: (n) => currency(n) },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Revenue by tier" subtitle="Where the MRR comes from." icon={<Wallet size={16} />} />
          {view.byTier.length === 0 ? (
            <p className="text-xs text-ink-400">No revenue yet.</p>
          ) : (
            <DonutChart data={view.byTier} dataKey="value" nameKey="name" formatter={(n) => currency(n, { compact: true })} height={220} />
          )}
        </Card>
      </div>

      {/* Profit leaders */}
      <Card padding="p-0">
        <CardHeader title="Profit leaders" subtitle="Top customers by monthly gross profit." className="px-5 pt-5" />
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Customer</TH><TH>Plan</TH><TH className="text-right">Revenue</TH>
              <TH className="text-right">B2 cost</TH><TH className="text-right">Gross profit</TH>
              <TH className="text-right">Margin</TH><TH>Health</TH>
            </TR>
          </THead>
          <TBody>
            {view.leaders.map((c) => {
              const m = (c.revenue30d || 0) > 0 ? c.profit / c.revenue30d : 0;
              return (
                <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                  <TD className="font-medium text-ink-100">{c.name}</TD>
                  <TD className="text-ink-300">{c.plan || '—'}</TD>
                  <TD className="text-right">{currency(c.revenue30d || 0, { compact: true })}</TD>
                  <TD className="text-right text-ink-300">{currency(c.cogs30d || 0, { compact: true })}</TD>
                  <TD className="text-right font-medium text-accent-green">{currency(c.profit, { compact: true })}</TD>
                  <TD className="text-right">{percent(m, 0)}</TD>
                  <TD><HealthPill status={c.health || 'healthy'} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      {/* At-risk / upsell signals */}
      <Card padding="p-0">
        <div className="flex items-center justify-between gap-3 px-5 pt-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-100">
            {tab === 'risk' ? <AlertTriangle size={15} className="text-accent-amber" /> : <ArrowUpRight size={15} className="text-accent-green" />}
            Revenue signals
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'risk', label: 'At risk', count: view.atRisk.length },
              { id: 'upsell', label: 'Upsell', count: view.upsell.length },
            ]}
          />
        </div>
        <p className="px-5 pb-2 pt-1 text-xs text-ink-400">
          {tab === 'risk'
            ? 'Declining or unhealthy accounts — revenue you could lose. Reach out before they churn.'
            : 'Fast-growing healthy accounts — candidates for a higher tier or expanded commitment.'}
        </p>
        {(tab === 'risk' ? view.atRisk : view.upsell).length === 0 ? (
          <div className="px-5 pb-5 text-xs text-ink-400">Nothing flagged right now.</div>
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Customer</TH><TH>Plan</TH><TH className="text-right">Revenue / mo</TH>
                <TH className="text-right">Growth</TH><TH>Health</TH>
              </TR>
            </THead>
            <TBody>
              {(tab === 'risk' ? view.atRisk : view.upsell).map((c) => {
                const g = c.growth ?? 0;
                return (
                  <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                    <TD className="font-medium text-ink-100">{c.name}</TD>
                    <TD className="text-ink-300">{c.plan || '—'}</TD>
                    <TD className="text-right">{currency(c.revenue30d || 0, { compact: true })}</TD>
                    <TD className={'text-right font-medium ' + (g >= 0 ? 'text-accent-green' : 'text-bb-red')}>
                      {deltaSign(g)}{percent(g, 1)}
                    </TD>
                    <TD><HealthPill status={c.health || 'healthy'} /></TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
