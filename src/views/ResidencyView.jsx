// Data residency — where each customer's data physically lives, as a global
// footprint map plus per-region breakdown and an (illustrative) residency
// policy check. Dependency-free: the map is a styled SVG constellation, not a
// geo library.
import React, { useEffect, useMemo, useState } from 'react';
import { Globe, MapPin, RefreshCcw, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  PageHeader, MetricCard, Card, CardHeader, Tag,
  Table, THead, TBody, TR, TH, TD, LoadingState, ErrorState,
} from '../components/ui.jsx';
import { bytes, percent, compactNumber } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';

// Constellation positions (not strict geography) on a 100×56 canvas —
// Americas left, Europe right — enough to read as a global footprint.
const POS = {
  'us-west-002':   { x: 16, y: 40 },
  'us-east-005':   { x: 32, y: 33 },
  'ca-east-006':   { x: 33, y: 20 },
  'eu-central-003': { x: 64, y: 26 },
};
const zoneOf = (regionId) => regionId?.startsWith('eu') ? 'EU' : regionId?.startsWith('ca') ? 'CA' : 'US';
// Demo policy: regulated-industry customers must keep data in the EU.
const REGULATED = /health|genom|gov|financ|bank|insur|legal|medic|patient/i;

export default function ResidencyView() {
  const { navigate } = useNav();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    setError(''); setData(null);
    Promise.all([b2.getRegionUsage(), partner.getCustomers()])
      .then(([{ regions }, { customers }]) => setData({ regions: regions || [], customers: (customers || []).filter((c) => c.active !== false) }))
      .catch((e) => setError(e?.message || String(e)));
  };
  useEffect(load, []);

  const view = useMemo(() => {
    if (!data) return null;
    const totalStorage = data.regions.reduce((s, r) => s + (r.storageBytes || 0), 0) || 1;
    const maxStorage = Math.max(...data.regions.map((r) => r.storageBytes || 0), 1);
    const nodes = data.regions.map((r) => ({
      ...r,
      pos: POS[r.regionId] || { x: 50, y: 28 },
      radius: 3 + 7 * Math.sqrt((r.storageBytes || 0) / maxStorage),
      share: (r.storageBytes || 0) / totalStorage,
    }));
    const policy = data.customers.map((c) => {
      const required = REGULATED.test(`${c.industry || ''} ${c.name || ''}`) ? 'EU' : zoneOf(c.region);
      const actual = zoneOf(c.region);
      return { ...c, requiredZone: required, actualZone: actual, compliant: required === actual };
    });
    const violations = policy.filter((p) => !p.compliant);
    return { nodes, totalStorage, policy, violations, regionCount: data.regions.length, customerCount: data.customers.length };
  }, [data]);

  if (error) return <ErrorState title="Could not load regions" message={error} onRetry={load} />;
  if (!view) return <LoadingState label="Mapping data residency" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Data residency"
        subtitle="Where your customers' data physically lives — a global footprint with per-region breakdown and residency-policy checks for data sovereignty."
        actions={
          <button onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"><RefreshCcw size={12} /> Refresh</button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Regions in use" value={view.regionCount} source="derived" accent="teal" icon={<Globe size={16} />} />
        <MetricCard label="Customers mapped" value={view.customerCount} source="derived" accent="violet" icon={<MapPin size={16} />} />
        <MetricCard label="Total footprint" value={bytes(view.totalStorage)} source="derived" accent="red" icon={<Globe size={16} />} />
        <MetricCard label="Policy violations" value={view.violations.length} source="derived" accent={view.violations.length ? 'red' : 'green'} icon={view.violations.length ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />} />
      </div>

      {/* Map */}
      <Card>
        <CardHeader title="Global footprint" subtitle="Node size = stored data in that region." icon={<Globe size={16} />} />
        <div className="relative overflow-hidden rounded-lg bg-ink-950/60 ring-1 ring-ink-800">
          <svg viewBox="0 0 100 56" className="h-[320px] w-full">
            {/* faint grid */}
            {[...Array(7)].map((_, i) => <line key={`h${i}`} x1="0" y1={i * 8 + 4} x2="100" y2={i * 8 + 4} stroke="#1F2638" strokeWidth="0.15" />)}
            {[...Array(11)].map((_, i) => <line key={`v${i}`} x1={i * 10} y1="0" x2={i * 10} y2="56" stroke="#1F2638" strokeWidth="0.15" />)}
            {/* links between regions */}
            {view.nodes.map((a, i) => view.nodes.slice(i + 1).map((b) => (
              <line key={`${a.regionId}-${b.regionId}`} x1={a.pos.x} y1={a.pos.y} x2={b.pos.x} y2={b.pos.y} stroke="#2A334B" strokeWidth="0.2" strokeDasharray="0.6 0.6" opacity="0.5" />
            )))}
            {/* region nodes */}
            {view.nodes.map((n) => (
              <g key={n.regionId}>
                <circle cx={n.pos.x} cy={n.pos.y} r={n.radius + 2.5} fill={n.color} opacity="0.12" />
                <circle cx={n.pos.x} cy={n.pos.y} r={n.radius} fill={n.color} opacity="0.85" />
                <circle cx={n.pos.x} cy={n.pos.y} r={n.radius} fill="none" stroke={n.color} strokeWidth="0.3" opacity="0.9" />
                <text x={n.pos.x} y={n.pos.y - n.radius - 1.5} textAnchor="middle" fontSize="2.6" fill="#E5E9F2" fontWeight="600">{n.flag} {n.code}</text>
                <text x={n.pos.x} y={n.pos.y - n.radius - 4} textAnchor="middle" fontSize="1.9" fill="#8A95B2">{bytes(n.storageBytes || 0)}</text>
              </g>
            ))}
          </svg>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {view.nodes.map((n) => (
            <div key={n.regionId} className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink-100"><span style={{ color: n.color }}>●</span> {n.flag} {n.code}</div>
              <div className="mt-1 text-[11px] text-ink-400">{n.city}</div>
              <div className="mt-2 text-sm font-semibold text-ink-100">{bytes(n.storageBytes || 0)}</div>
              <div className="text-[11px] text-ink-400">{percent(n.share, 0)} of footprint</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Residency policy */}
      <Card padding="p-0">
        <CardHeader
          title="Residency policy"
          subtitle="Demo policy: regulated-industry customers must keep data in the EU. Wire to your compliance system in production."
          className="px-5 pt-5"
          action={view.violations.length === 0 ? <Tag variant="success">All within policy</Tag> : <Tag variant="danger">{view.violations.length} violation{view.violations.length === 1 ? '' : 's'}</Tag>}
        />
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Customer</TH><TH>Industry</TH><TH>Data region</TH><TH>Required</TH><TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {[...view.policy].sort((a, b) => Number(a.compliant) - Number(b.compliant)).slice(0, 12).map((c) => (
              <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                <TD className="font-medium text-ink-100">{c.name}</TD>
                <TD className="text-ink-300">{c.industry || '—'}</TD>
                <TD className="text-ink-300">{c.region}</TD>
                <TD className="text-ink-300">{c.requiredZone}</TD>
                <TD>{c.compliant ? <Tag variant="success">Compliant</Tag> : <Tag variant="danger">Must move to {c.requiredZone}</Tag>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
