import React, { useEffect, useState } from 'react';
import { FolderTree, Users, ChevronRight, Plus, ArrowLeft, Save, Loader2, X } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, HealthPill,
  Table, THead, TBody, TR, TH, TD, LoadingState, EmptyState, ErrorState,
} from '../components/ui.jsx';
import { CreateCustomerDialog } from '../components/dialogs.jsx';
import { REGIONS } from '../data/regions.js';
import { B2_LIST_PRICE } from '../data/resellerPlans.js';
import { api } from '../lib/apiClient.js';
import { useApp } from '../lib/AppContext.jsx';
import * as partner from '../api/partnerApi.js';
import { bytes, currency, percent, shortDate } from '../lib/format.js';
import { useNav } from '../lib/nav.js';

export default function GroupsView({ groupId }) {
  if (groupId) return <GroupDetail groupId={groupId} />;
  return <GroupsList />;
}

function GroupsList() {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]);
  const [groupCosts, setGroupCosts] = useState(new Map());
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    setLoading(true);
    Promise.all([partner.listGroups(), partner.getCustomers(), partner.getGroupCosts()])
      .then(([{ groups }, { customers }, costs]) => {
        setGroups(groups);
        setAllCustomers(customers);
        setGroupCosts(costs);
      })
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (error) return <ErrorState title="Could not load groups" message={error} onRetry={load} />;
  if (loading) return <LoadingState label="Listing groups via b2_list_groups" />;

  function rollupForGroup(g) {
    const members = allCustomers.filter((c) => c.groupId === g.groupId);
    return {
      members: members.length,
      storage: members.reduce((s, c) => s + (c.storageBytes ?? 0), 0),
      egress: members.reduce((s, c) => s + (c.egressBytes30d ?? 0), 0),
      revenue: members.reduce((s, c) => s + (c.revenue30d ?? 0), 0),
    };
  }

  const totals = allCustomers.reduce((acc, c) => {
    acc.storage += (c.storageBytes ?? 0);
    acc.revenue += (c.revenue30d ?? 0);
    return acc;
  }, { storage: 0, revenue: 0 });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Partner Groups"
        subtitle="Groups are the partner-level container that holds customer sub-accounts. One partner can manage up to 500 Groups, each with up to 5,000 sub-accounts. Backblaze rolls up billing per Group, so this is the unit of revenue and ops separation."
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
          >
            <Plus size={12} /> New customer
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Active groups" value={groups.length} source="partner" icon={<FolderTree size={14} />} accent="violet" />
        <MetricCard label="Total customers" value={allCustomers.length} source="partner" icon={<Users size={14} />} accent="teal" />
        <MetricCard label="Aggregate storage" value={bytes(totals.storage)} source="csv" accent="red" />
        <MetricCard label="Aggregate revenue (30d)" value={currency(totals.revenue, { compact: true })} source="derived" accent="green" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((g) => {
          const r = rollupForGroup(g);
          return (
            <button
              key={g.groupId}
              onClick={() => navigate('groups', { groupId: g.groupId })}
              className="group rounded-xl border border-ink-700 bg-ink-850/80 p-5 text-left shadow-card transition hover:border-ink-600 hover:bg-ink-850"
              style={{ boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px -12px rgba(0,0,0,0.6), inset 4px 0 0 ${g.accent}55` }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-semibold text-ink-100">{g.groupName}</h3>
                  <p className="mt-0.5 text-xs text-ink-400">{g.description}</p>
                </div>
                <ChevronRight size={16} className="text-ink-500 group-hover:text-bb-red" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <Stat label="Members" value={r.members} mono />
                <Stat label="Storage" value={bytes(r.storage)} mono />
                <Stat
                  label="Cost / TB"
                  value={groupCosts.has(g.groupId)
                    ? currency(groupCosts.get(g.groupId))
                    : `${currency(B2_LIST_PRICE.storagePerTb)} list`}
                  mono
                  accent={groupCosts.has(g.groupId) ? 'text-ink-100' : 'text-ink-500'}
                />
                <Stat label="Revenue (30d)" value={currency(r.revenue, { compact: true })} mono accent="text-accent-green" />
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-ink-400">
                <span className="font-mono">{g.groupId}</span>
                <span>created {shortDate(new Date(g.createdTimestamp))}</span>
              </div>
            </button>
          );
        })}
      </div>

      <CreateCustomerDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(newCust) => {
          // Optimistic insert into the flat customers list so per-group
          // member counts update immediately; refresh reconciles after.
          const row = partner.customerRowFromCreated(newCust);
          if (row) {
            setAllCustomers((prev) => [row, ...prev.filter((c) => c.accountId !== row.accountId)]);
          }
          partner.getCustomers().then(({ customers }) => setAllCustomers(customers));
          partner.listGroups().then(({ groups }) => setGroups(groups));
        }}
      />
    </div>
  );
}

function GroupDetail({ groupId }) {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [costPerTb, setCostPerTb] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    setLoading(true);
    Promise.all([partner.getGroup(groupId), partner.getCustomers({ groupId }), partner.getGroupCosts()])
      .then(([g, { customers }, costs]) => {
        setGroup(g);
        setMembers(customers);
        setCostPerTb(costs.has(String(groupId)) ? costs.get(String(groupId)) : null);
      })
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [groupId]);

  if (error) return <ErrorState title="Could not load group" message={error} onRetry={load} />;
  if (loading) return <LoadingState label="Loading group members" />;
  if (!group) {
    return (
      <EmptyState
        title="Group not found"
        message={`No group with id ${groupId}`}
        action={<button onClick={() => navigate('groups')} className="rounded-md bg-bb-red px-3 py-1.5 text-xs text-white">Back to Groups</button>}
      />
    );
  }

  const totals = members.reduce((a, c) => {
    a.storage += c.storageBytes;
    a.egress += c.egressBytes30d;
    a.revenue += c.revenue30d;
    a.cogs += c.cogs30d;
    return a;
  }, { storage: 0, egress: 0, revenue: 0, cogs: 0 });

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('groups')}
        className="inline-flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100"
      >
        <ArrowLeft size={12} /> Back to Groups
      </button>
      <PageHeader
        eyebrow="Group"
        title={group.groupName}
        subtitle={group.description + ' · group ID ' + group.groupId}
        actions={
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
          >
            <Plus size={12} /> New customer
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Members" value={members.length} source="partner" icon={<Users size={14} />} accent="violet" />
        <MetricCard label="Storage" value={bytes(totals.storage)} source="csv" accent="red" />
        <MetricCard label="Egress (30d)" value={bytes(totals.egress)} source="csv" accent="teal" />
        <MetricCard
          label="Margin (30d)"
          value={totals.revenue > 0 ? percent((totals.revenue - totals.cogs) / totals.revenue, 1) : '—'}
          source="derived"
          accent="green"
        />
      </div>

      <GroupCostCard
        groupId={group.groupId}
        costPerTb={costPerTb}
        storageBytes={totals.storage}
        onSaved={load}
      />

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Members</h3>
            <p className="mt-0.5 text-xs text-ink-300">Click a customer to drill into their buckets, keys, and lifecycle rules.</p>
          </div>
          <SourceBadge source="partner" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Customer</TH>
              <TH>Region</TH>
              <TH>Plan</TH>
              <TH className="text-right">Storage</TH>
              <TH className="text-right">Revenue (30d)</TH>
              <TH>Health</TH>
              <TH></TH>
            </TR>
          </THead>
          <TBody>
            {members.map((c) => {
              const region = REGIONS.find((r) => r.id === c.region);
              return (
                <TR key={c.id} onClick={() => navigate('customer-detail', { customerId: c.id })}>
                  <TD>
                    <div className="font-medium text-ink-100">{c.name}</div>
                    {c.industry && <div className="text-[11px] text-ink-400">{c.industry}</div>}
                  </TD>
                  <TD className="text-ink-200">{region?.flag} {region?.code}</TD>
                  <TD className="text-ink-300">{c.plan}</TD>
                  <TD className="text-right font-mono">{bytes(c.storageBytes)}</TD>
                  <TD className="text-right font-mono">{currency(c.revenue30d, { compact: true })}</TD>
                  <TD><HealthPill status={c.health} /></TD>
                  <TD className="text-right text-ink-400"><ChevronRight size={14} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <CreateCustomerDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        defaultGroupId={groupId}
        onCreated={(newCust) => {
          const row = partner.customerRowFromCreated(newCust);
          if (row) {
            setMembers((prev) => [row, ...prev.filter((c) => c.accountId !== row.accountId)]);
          }
          partner.getCustomers({ groupId }).then(({ customers }) => setMembers(customers));
        }}
      />
    </div>
  );
}

// The partner's own purchase rate for this group — the COGS half of margin.
// The reseller plan holds the other half, what they charge. A group with no
// negotiated rate falls back to B2 list, which for a partner storing petabytes
// overstates cost and understates margin, so say so plainly rather than showing
// a number that looks settled.
function GroupCostCard({ groupId, costPerTb, storageBytes, onSaved }) {
  const { isAdmin } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue]     = useState(costPerTb != null ? String(costPerTb) : '');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    setValue(costPerTb != null ? String(costPerTb) : '');
    setEditing(false);
  }, [costPerTb, groupId]);

  const effective = costPerTb ?? B2_LIST_PRICE.storagePerTb;
  const monthly   = (storageBytes / 1e12) * effective;

  const save = async () => {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) { setError('Enter a non-negative number.'); return; }
    setSaving(true);
    setError('');
    try {
      await api.put(`/api/admin/group-costs/${encodeURIComponent(groupId)}`, { costPerTb: n });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e?.body?.error || 'Could not save cost.');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError('');
    try {
      await api.delete(`/api/admin/group-costs/${encodeURIComponent(groupId)}`);
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e?.body?.error || 'Could not clear cost.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-100">Your cost for this group</h3>
          <p className="mt-0.5 text-[11.5px] text-ink-400">
            What you pay Backblaze to store, per TB per month. Reseller plans set what you
            charge; the gap is your margin.
          </p>
        </div>

        {!editing ? (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-lg text-ink-100">{currency(effective)}<span className="text-xs text-ink-400">/TB</span></div>
              <div className="text-[10.5px] text-ink-400">
                {costPerTb != null
                  ? `≈ ${currency(monthly, { compact: true })}/mo at current storage`
                  : 'B2 list price — no negotiated rate set'}
              </div>
            </div>
            {isAdmin && (
              <button
                onClick={() => setEditing(true)}
                className="rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[11px] text-ink-200 hover:bg-ink-800"
              >
                {costPerTb != null ? 'Edit' : 'Set cost'}
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-ink-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-label="Cost per TB"
                className="h-8 w-28 rounded border border-ink-700 bg-ink-900 px-2 text-right font-mono text-xs text-ink-100"
              />
              <span className="text-xs text-ink-400">/TB</span>
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded border border-bb-red/30 bg-bb-red px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-bb-redDim"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
            </button>
            {costPerTb != null && (
              <button
                onClick={clear}
                disabled={saving}
                title="Revert this group to B2 list price"
                className="rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[11px] text-ink-300 hover:text-ink-100"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => { setEditing(false); setError(''); setValue(costPerTb != null ? String(costPerTb) : ''); }}
              disabled={saving}
              className="rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-[11px] text-ink-300 hover:text-ink-100"
            >
              <X size={11} />
            </button>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-[11px] text-bb-red">{error}</p>}
    </Card>
  );
}

function Stat({ label, value, mono, accent }) {
  return (
    <div className="rounded-md bg-ink-900/60 px-3 py-2 ring-1 ring-ink-700">
      <div className="text-[10.5px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={"mt-0.5 text-sm " + (mono ? "font-mono " : "") + (accent || 'text-ink-100')}>{value}</div>
    </div>
  );
}
