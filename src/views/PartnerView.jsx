import React, { useEffect, useState } from 'react';
import { Users, ChevronRight, Plus, Info } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge, HealthPill, Tabs, Tag,
  Table, THead, TBody, TR, TH, TD, LoadingState, MetricCard, EmptyState,
} from '../components/ui.jsx';
import { CreateCustomerDialog } from '../components/dialogs.jsx';
import { REGIONS } from '../data/regions.js';
import * as partner from '../api/partnerApi.js';
import { useNav } from '../lib/nav.js';
import { bytes, currency, percent } from '../lib/format.js';

const TABS = [
  { id: 'all', label: 'All customers' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'attention', label: 'Watch list' },
  { id: 'risk', label: 'At risk' },
];

const HEALTH_DEFINITIONS = {
  healthy:   'Growing usage, current keys, paying invoices on time.',
  attention: 'Slowing growth (under 10% / 30d) OR a key recently expired or stale. Worth a check-in.',
  risk:      'Declining usage, expired master-equivalent key, or unresolved security finding. Engage CSM.',
};

export default function PartnerView() {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [tab, setTab] = useState('all');
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => partner.getCustomers().then(({ customers }) => {
    setCustomers(customers);
    setLoading(false);
  });
  useEffect(() => { refresh(); }, []);

  if (loading) return <LoadingState label="Listing group members via Partner API v3" />;

  const filtered = tab === 'all' ? customers : customers.filter((c) => c.health === tab);
  const counts = customers.reduce((acc, c) => {
    acc.healthy += c.health === 'healthy' ? 1 : 0;
    acc.attention += c.health === 'attention' ? 1 : 0;
    acc.risk += c.health === 'risk' ? 1 : 0;
    return acc;
  }, { healthy: 0, attention: 0, risk: 0 });

  const tabsWithCounts = [
    { ...TABS[0], count: customers.length },
    { ...TABS[1], count: counts.healthy },
    { ...TABS[2], count: counts.attention },
    { ...TABS[3], count: counts.risk },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Customers"
        title="Sub-accounts & customer hierarchy"
        subtitle="Each row is a B2 sub-account that rolls up under one of your partner Groups. Click into a customer to see their buckets, application keys, lifecycle rules, recent activity, and billing."
        actions={
          <div className="flex items-center gap-2">
            <Tag variant="info">{customers.length} members</Tag>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              <Plus size={12} /> New customer
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Customers" value={customers.length} source="partner" icon={<Users size={14} />} accent="violet" />
        <MetricCard
          label="Aggregate storage"
          value={bytes(customers.reduce((a, c) => a + c.storageBytes, 0))}
          source="csv"
          accent="red"
        />
        <MetricCard
          label="Aggregate revenue (30d)"
          value={currency(customers.reduce((a, c) => a + c.revenue30d, 0), { compact: true })}
          source="derived"
          accent="green"
        />
        <MetricCard
          label="Avg margin"
          value={percent(
            customers.reduce((a, c) => a + (c.revenue30d - c.cogs30d) / c.revenue30d, 0) / customers.length,
            1
          )}
          source="derived"
          accent="teal"
        />
      </div>

      {/* Health legend */}
      <Card padding="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Info size={14} className="mt-0.5 text-ink-400" />
            <div>
              <div className="text-xs font-semibold text-ink-100">Health definitions</div>
              <p className="mt-0.5 text-[11px] text-ink-400">Customer health is a derived signal — combines usage trend, key posture, and billing status. Definitions:</p>
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <HealthDef status="healthy" />
          <HealthDef status="attention" />
          <HealthDef status="risk" />
        </div>
      </Card>

      <Card padding="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 px-5 py-4">
          <Tabs tabs={tabsWithCounts} value={tab} onChange={setTab} />
          <SourceBadge source="partner" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Customer</TH>
              <TH>Group</TH>
              <TH>Region</TH>
              <TH>Plan</TH>
              <TH className="text-right">Storage</TH>
              <TH className="text-right">Egress (30d)</TH>
              <TH className="text-right">Revenue (30d)</TH>
              <TH className="text-right">Growth</TH>
              <TH>Health</TH>
              <TH></TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((c) => {
              const region = REGIONS.find((r) => r.id === c.region);
              return (
                <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                  <TD>
                    <div className="font-medium text-ink-100">{c.name}</div>
                    <div className="text-[11px] text-ink-400">{c.industry}</div>
                  </TD>
                  <TD className="text-[11px] font-mono text-ink-300">{c.groupId}</TD>
                  <TD>
                    <span className="inline-flex items-center gap-1 text-ink-200">
                      <span>{region?.flag}</span> {region?.code}
                    </span>
                  </TD>
                  <TD className="text-ink-300">{c.plan}</TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(c.storageBytes)}</TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(c.egressBytes30d)}</TD>
                  <TD className="text-right font-mono text-ink-100">{currency(c.revenue30d, { compact: true })}</TD>
                  <TD className={"text-right font-mono " + (c.growth >= 0 ? "text-accent-green" : "text-bb-red")}>
                    {c.growth >= 0 ? '+' : ''}{percent(c.growth, 1)}
                  </TD>
                  <TD title={HEALTH_DEFINITIONS[c.health]}><HealthPill status={c.health} /></TD>
                  <TD className="text-right text-ink-400"><ChevronRight size={14} /></TD>
                </TR>
              );
            })}
            {filtered.length === 0 && (
              <TR hover={false}><TD className="py-8 text-center text-ink-400" colSpan={10}>
                <EmptyState title="No customers in this segment" message="Try a different filter." />
              </TD></TR>
            )}
          </TBody>
        </Table>
      </Card>

      <CreateCustomerDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refresh}
      />
    </div>
  );
}

function HealthDef({ status }) {
  const label = { healthy: 'Healthy', attention: 'Watch list', risk: 'At risk' }[status];
  return (
    <div className="rounded-md bg-ink-900/60 p-2.5 ring-1 ring-ink-700">
      <div className="mb-1 flex items-center gap-1.5">
        <HealthPill status={status} />
        <span className="text-[11px] font-semibold text-ink-100">{label}</span>
      </div>
      <p className="text-[10.5px] leading-relaxed text-ink-400">{HEALTH_DEFINITIONS[status]}</p>
    </div>
  );
}
