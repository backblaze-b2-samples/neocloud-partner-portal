import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Database, Lock, ShieldCheck, Eye, EyeOff, Copy, GitBranch, Layers, Filter, Boxes, Clock, Trash2, ChevronLeft, ChevronRight, Info, Users } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge, Tag, MetricCard,
  Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import { DonutChart } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';
import { REGIONS } from '../data/regions.js';
import { bytes, compactNumber } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import { useApp } from '../lib/AppContext.jsx';

const PAGE_SIZES = [10, 25, 50, 100];

export default function StorageView() {
  const { navigate } = useNav();
  const { isLive } = useApp();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('all');
  const [buckets, setBuckets] = useState([]);
  const [filterRegion, setFilterRegion] = useState('all');
  const [filterLifecycle, setFilterLifecycle] = useState('all');
  const [filterEncryption, setFilterEncryption] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  // Load customer list once (for the account selector).
  useEffect(() => {
    if (!isLive) return; // demo mode: no sub-accounts to switch between
    partner.getCustomers().then(({ customers }) => setCustomers(customers)).catch(() => {});
  }, [isLive]);

  // Reload buckets whenever the selected account changes.
  const loadBuckets = useCallback(async () => {
    setLoading(true);
    try {
      let raw;
      if (selectedAccountId === 'master') {
        // Master account: use the B2 API (only has the reports bucket).
        const { buckets: apiBuckets } = await b2.listBuckets();
        raw = apiBuckets.map((b) => ({ ...b, storageBytes: b.storageBytes ?? 0, objectCount: b.objectCount ?? 0 }));
      } else {
        // Sub-account: derive bucket list + storage directly from the CSV.
        // This avoids needing stored credentials for every sub-account in the DB.
        const accountId = selectedAccountId === 'all' ? undefined : selectedAccountId;
        raw = await b2.getBucketsFromCsv({ accountId });
      }

      // Merge in object counts from the 24h background job cache.
      // getObjectCounts() is a fast DB read via /api/master-b2/object-counts.
      // We fire it in parallel with the bucket fetch (both start before await).
      const objectCounts = await b2.getObjectCounts();
      const withCounts = raw.map((bucket) => {
        const entry = objectCounts.get(bucket.bucketId);
        return entry?.count != null ? { ...bucket, objectCount: entry.count } : bucket;
      });

      const sorted = [...withCounts].sort((a, b) => a.bucketName.localeCompare(b.bucketName));
      setBuckets(sorted);
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => { loadBuckets(); }, [loadBuckets]);

  const filtered = useMemo(() => {
    return buckets.filter((b) => {
      if (filterRegion !== 'all' && b.region !== filterRegion) return false;
      if (filterLifecycle === 'with' && b.lifecycleRules.length === 0) return false;
      if (filterLifecycle === 'without' && b.lifecycleRules.length > 0) return false;
      if (filterEncryption === 'encrypted' && b.encryption === 'none') return false;
      if (filterEncryption === 'unencrypted' && b.encryption !== 'none') return false;
      return true;
    });
  }, [buckets, filterRegion, filterLifecycle, filterEncryption]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [filterRegion, filterLifecycle, filterEncryption, pageSize, selectedAccountId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);

  if (loading) return <LoadingState label="Listing buckets via b2_list_buckets" />;

  const totalStorage = buckets.reduce((s, b) => s + (b.storageBytes || 0), 0);
  // objectCount is null for CSV-derived buckets (not a CSV column) — only sum
  // when we have real API data, otherwise show '—' rather than a misleading 0.
  const hasObjectCounts = buckets.some((b) => b.objectCount != null);
  const totalObjects = hasObjectCounts
    ? buckets.reduce((s, b) => s + (b.objectCount || 0), 0)
    : null;
  const fromCsv = buckets.some((b) => b._fromCsv);

  const lockTotals = buckets.reduce((acc, b) => {
    if (b.storageBytes > 0) acc[b.fileLock || 'none'] = (acc[b.fileLock || 'none'] || 0) + b.storageBytes;
    return acc;
  }, {});
  const lockData = [
    { name: 'Compliance', value: lockTotals.compliance || 0, color: '#9B7CFF' },
    { name: 'Governance', value: lockTotals.governance || 0, color: '#3DD9D6' },
    { name: 'No lock',    value: lockTotals.none       || 0, color: '#5C6786' },
  ].filter((d) => d.value > 0);

  const selectedCustomer = customers.find((c) => c.accountId === selectedAccountId);
  const accountLabel = selectedAccountId === 'all'
    ? 'All sub-accounts'
    : selectedAccountId === 'master'
    ? 'Master account'
    : (selectedCustomer?.name || selectedAccountId);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Storage & buckets"
        subtitle="Bucket metadata (encryption, lifecycle, file lock, CORS) is returned by b2_list_buckets in real time. Storage bytes are derived from the daily usage CSV report — the bucket-list endpoint does not return them."
        actions={
          <div className="flex items-center gap-2">
            {isLive && customers.length > 0 && (
              <AccountSelector
                customers={customers}
                value={selectedAccountId}
                onChange={setSelectedAccountId}
              />
            )}
            <Tag>Native API + S3-compatible</Tag>
            <Tag variant="info">{buckets.length} buckets</Tag>
          </div>
        }
      />

      {selectedAccountId !== 'all' && selectedAccountId !== 'master' && selectedCustomer && (
        <div className="-mt-2 text-[11.5px] text-ink-400">
          Viewing sub-account <span className="font-mono text-ink-200">{selectedCustomer.accountId}</span> · {selectedCustomer.contactEmail || selectedCustomer.name}
        </div>
      )}

      {fromCsv && (
        <div className="flex items-start gap-3 rounded-lg border border-ink-700 bg-ink-850/40 px-4 py-3 text-[11.5px] text-ink-400">
          <Info size={13} className="mt-0.5 shrink-0 text-ink-300" />
          <span>
            Bucket list and storage are derived from the daily CSV report.
            <strong className="text-ink-200"> Buckets with zero activity are not included in the CSV</strong> — they will not appear here even if they exist.
            Object counts are fetched by a background job that runs every 24 hours — counts may be up to a day old.
            Switch to a specific sub-account or use the B2 console to see all buckets.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total storage" value={bytes(totalStorage)} source="csv" icon={<Database size={14} />} accent="red" />
        <MetricCard
          label="Object count"
          value={totalObjects != null ? compactNumber(totalObjects) : '—'}
          source="csv"
          icon={<Layers size={14} />}
          accent="violet"
        />
        <MetricCard label="Buckets" value={`${buckets.length}${fromCsv ? '+' : ''}`} source={fromCsv ? 'csv' : 'api'} icon={<Boxes size={14} />} accent="teal" />
        <MetricCard
          label="Encrypted at rest"
          value={fromCsv ? '—' : `${buckets.filter((b) => b.encryption !== 'none').length} / ${buckets.length}`}
          source="api"
          icon={<ShieldCheck size={14} />}
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader
            title="Object Lock distribution"
            subtitle="Share of stored bytes by file-lock retention mode"
            action={<SourceBadge source="api" />}
          />
          {lockData.length > 0
            ? <DonutChart data={lockData} formatter={bytes} />
            : <p className="py-8 text-center text-xs text-ink-400">No storage data available for lock distribution</p>
          }
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader
            title="Filters"
            subtitle="Narrow the bucket list by region or whether a lifecycle rule is configured"
            icon={<Filter size={16} />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <FilterGroup
              label="Region"
              value={filterRegion}
              onChange={setFilterRegion}
              options={[
                { id: 'all', label: 'All' },
                ...REGIONS.map((r) => ({ id: r.id, label: `${r.flag} ${r.code}` })),
              ]}
            />
            <FilterGroup
              label="Lifecycle"
              value={filterLifecycle}
              onChange={setFilterLifecycle}
              options={[
                { id: 'all', label: 'All' },
                { id: 'with', label: 'With rules' },
                { id: 'without', label: 'No rules' },
              ]}
            />
            <FilterGroup
              label="Encryption"
              value={filterEncryption}
              onChange={setFilterEncryption}
              options={[
                { id: 'all', label: 'All' },
                { id: 'encrypted', label: 'Encrypted' },
                { id: 'unencrypted', label: 'No encryption' },
              ]}
            />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Stat label="Showing" value={filtered.length} />
            <Stat label="Storage in view" value={bytes(filtered.reduce((s, b) => s + (b.storageBytes || 0), 0))} />
            <Stat label="Objects in view" value={hasObjectCounts ? compactNumber(filtered.reduce((s, b) => s + (b.objectCount || 0), 0)) : '—'} />
            <Stat label="Public buckets" value={filtered.filter((b) => b.publicAccess).length} />
          </div>
        </Card>
      </div>

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">
              Buckets · {accountLabel}
            </h3>
            <p className="mt-0.5 text-xs text-ink-300">Click a row to drill into files, lifecycle, and replication</p>
          </div>
          <div className="flex items-center gap-2">
            <SourceBadge source="api" />
            <SourceBadge source="csv" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 px-5 py-2.5 text-[11px] text-ink-300">
          <Info size={11} className="text-ink-400" />
          <span>
            <code className="text-ink-200">b2_list_buckets</code> returns all buckets in a single response — paging here is client-side for readability.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-ink-400">Page size</label>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-7 rounded-md border border-ink-700 bg-ink-900 px-2 text-[11px] text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <Table>
          <THead>
            <TR hover={false}>
              <TH>Bucket</TH>
              <TH>Region</TH>
              <TH>Type</TH>
              <TH>Encryption</TH>
              <TH>File lock</TH>
              <TH>Versioning</TH>
              <TH>Lifecycle</TH>
              <TH className="text-right">Size</TH>
              <TH className="text-right">Objects</TH>
            </TR>
          </THead>
          <TBody>
            {pageRows.map((b) => {
              const region = REGIONS.find((r) => r.id === b.region);
              const unencrypted = b.encryption === 'none';
              return (
                <TR key={b.bucketId} onClick={() => navigate('bucket-detail', {
                  bucketId: b.bucketId,
                  // Pass accountId for sub-account buckets so BucketDetailView uses
                  // the customer proxy (master credentials can't see sub-account buckets).
                  accountId: b.accountId || undefined,
                })}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <div className="grid h-7 w-7 place-items-center rounded-md bg-ink-800 text-ink-300 ring-1 ring-ink-700">
                        <Database size={12} />
                      </div>
                      <div>
                        <div className="font-mono text-[12.5px] text-ink-100">{b.bucketName}</div>
                        <div className="text-[10.5px] text-ink-400">
                          {b.bucketId.slice(0, 16)}…
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD className="text-ink-200">{region?.flag} {region?.code ?? '—'}</TD>
                  <TD>
                    {b.publicAccess ? (
                      <Tag variant="warn"><Eye size={10} className="mr-0.5" /> public</Tag>
                    ) : (
                      <Tag><EyeOff size={10} className="mr-0.5" /> private</Tag>
                    )}
                  </TD>
                  <TD>
                    <Tag
                      variant={unencrypted ? 'warn' : 'info'}
                      title={unencrypted ? 'No server-side encryption configured' : `Server-side encryption: ${b.encryption}`}
                    >
                      <Lock size={10} className="mr-0.5" /> {b.encryption}
                    </Tag>
                  </TD>
                  <TD>
                    {!b.fileLock || b.fileLock === 'none' ? (
                      <span className="text-ink-400 text-xs">—</span>
                    ) : (
                      <Tag variant="violet">{b.fileLock}</Tag>
                    )}
                  </TD>
                  <TD className="text-ink-300 text-xs">{b.versioning ?? '—'}</TD>
                  <TD>
                    {!b.lifecycleRules?.length ? (
                      <span className="text-ink-400 text-xs">none</span>
                    ) : (
                      <Tag variant="info">
                        {b.lifecycleRules.length} rule{b.lifecycleRules.length === 1 ? '' : 's'}
                      </Tag>
                    )}
                  </TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(b.storageBytes)}</TD>
                  <TD className="text-right font-mono text-ink-100">{compactNumber(b.objectCount)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>

        <div className="flex items-center justify-between border-t border-ink-700 px-5 py-3 text-[11px] text-ink-300">
          <div>
            Showing <span className="font-mono text-ink-100">{pageRows.length === 0 ? 0 : pageStart + 1}</span>–<span className="font-mono text-ink-100">{pageStart + pageRows.length}</span> of <span className="font-mono text-ink-100">{filtered.length}</span> buckets
            {filtered.length !== buckets.length && <span className="ml-1 text-ink-400">({buckets.length} total before filters)</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={currentPage === 1}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >« First</button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
            ><ChevronLeft size={11} /> Prev</button>
            <span className="px-2 font-mono">Page {currentPage} of {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >Next <ChevronRight size={11} /></button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={currentPage === totalPages}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >Last »</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// =============================================================================
// Account selector — switches between master account and customer sub-accounts
// =============================================================================
function AccountSelector({ customers, value, onChange }) {
  return (
    <div className="relative">
      <Users size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 cursor-pointer appearance-none rounded-md border border-ink-700 bg-ink-850 pl-7 pr-7 text-xs font-medium text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
      >
        <option value="all">All sub-accounts</option>
        <option value="master">Master account</option>
        {customers.length > 0 && <optgroup label="Filter by sub-account">
          {customers.map((c) => (
            <option key={c.accountId} value={c.accountId}>
              {c.name} ({c.accountId})
            </option>
          ))}
        </optgroup>}
      </select>
    </div>
  );
}

function FilterGroup({ label, value, onChange, options }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1">
      <span className="px-2 text-[10px] font-medium uppercase tracking-wider text-ink-400">{label}</span>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={
            'rounded-md px-2 py-1 text-[11px] font-medium transition ' +
            (value === o.id ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:text-ink-100')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md bg-ink-900/60 px-3 py-2 ring-1 ring-ink-700">
      <div className="text-[10.5px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-ink-100">{value}</div>
    </div>
  );
}
