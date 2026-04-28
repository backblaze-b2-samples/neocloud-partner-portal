import React, { useEffect, useMemo, useState } from 'react';
import { Database, Lock, ShieldCheck, Eye, EyeOff, Copy, GitBranch, Layers, Filter, Boxes, Clock, Trash2, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge, Tag, MetricCard,
  Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import { DonutChart } from '../components/charts.jsx';
import * as b2 from '../api/b2Adapter.js';
import { CUSTOMERS } from '../data/customers.js';
import { REGIONS } from '../data/regions.js';
import { bytes, compactNumber } from '../lib/format.js';
import { useNav } from '../lib/nav.js';

const PAGE_SIZES = [10, 25, 50, 100];

export default function StorageView() {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [buckets, setBuckets] = useState([]);
  const [filterRegion, setFilterRegion] = useState('all');
  const [filterLifecycle, setFilterLifecycle] = useState('all');
  const [filterEncryption, setFilterEncryption] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  useEffect(() => {
    b2.listBuckets().then(({ buckets }) => {
      // API returns buckets in account-defined order; we sort by name for stable paging.
      const sorted = [...buckets].sort((a, b) => a.bucketName.localeCompare(b.bucketName));
      setBuckets(sorted);
      setLoading(false);
    });
  }, []);

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
  useEffect(() => { setPage(1); }, [filterRegion, filterLifecycle, filterEncryption, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);

  if (loading) return <LoadingState label="Listing buckets via b2_list_buckets" />;

  const totalStorage = buckets.reduce((s, b) => s + b.storageBytes, 0);
  const totalObjects = buckets.reduce((s, b) => s + b.objectCount, 0);

  // Object Lock distribution — a real B2 feature
  const lockTotals = buckets.reduce((acc, b) => {
    acc[b.fileLock] = (acc[b.fileLock] || 0) + b.storageBytes;
    return acc;
  }, {});
  const lockData = [
    { name: 'Compliance', value: lockTotals.compliance || 0, color: '#9B7CFF' },
    { name: 'Governance', value: lockTotals.governance || 0, color: '#3DD9D6' },
    { name: 'No lock', value: lockTotals.none || 0, color: '#5C6786' },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="Storage & buckets"
        subtitle="Bucket metadata (encryption, lifecycle, file lock, CORS) is returned by b2_list_buckets in real time. Storage bytes and object counts are NOT returned by the bucket-list endpoint — they are derived from the daily usage CSV report or computed by iterating files. Backblaze B2 is a single hot storage class; lifecycle rules only hide and delete files."
        actions={
          <div className="flex items-center gap-2 text-xs">
            <Tag>Native API + S3-compatible</Tag>
            <Tag variant="info">{buckets.length} buckets</Tag>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total storage" value={bytes(totalStorage)} source="csv" icon={<Database size={14} />} accent="red" />
        <MetricCard label="Object count" value={compactNumber(totalObjects)} source="csv" accent="violet" />
        <MetricCard label="Buckets" value={buckets.length} source="api" icon={<Boxes size={14} />} accent="teal" />
        <MetricCard
          label="Encrypted at rest"
          value={`${buckets.filter((b) => b.encryption !== 'none').length} / ${buckets.length}`}
          source="api"
          icon={<ShieldCheck size={14} />}
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader
            title="Object Lock distribution"
            subtitle="Share of stored bytes by file-lock retention mode (compliance / governance / none)"
            action={<SourceBadge source="api" />}
          />
          <DonutChart data={lockData} formatter={bytes} />
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
            <Stat label="Storage in view" value={bytes(filtered.reduce((s, b) => s + b.storageBytes, 0))} />
            <Stat label="Objects in view" value={compactNumber(filtered.reduce((s, b) => s + b.objectCount, 0))} />
            <Stat label="Public buckets" value={filtered.filter((b) => b.publicAccess).length} />
          </div>
        </Card>
      </div>

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Buckets</h3>
            <p className="mt-0.5 text-xs text-ink-300">Click a row to drill into files, lifecycle, and replication</p>
          </div>
          <div className="flex items-center gap-2">
            <SourceBadge source="api" />
            <SourceBadge source="csv" />
          </div>
        </div>

        {/* Note: b2_list_buckets returns ALL buckets in one call (no API pagination).
            We sort + paginate client-side for usability when an account has many buckets. */}
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
                <TR key={b.bucketId} onClick={() => navigate('bucket-detail', { bucketId: b.bucketId })}>
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
                  <TD className="text-ink-200">{region?.flag} {region?.code}</TD>
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
                      title={unencrypted ? 'No server-side encryption configured for this bucket' : `Server-side encryption: ${b.encryption}`}
                    >
                      <Lock size={10} className="mr-0.5" /> {b.encryption}
                    </Tag>
                  </TD>
                  <TD>
                    {b.fileLock === 'none' ? (
                      <span className="text-ink-400 text-xs">—</span>
                    ) : (
                      <Tag variant="violet">{b.fileLock}</Tag>
                    )}
                  </TD>
                  <TD className="text-ink-300 text-xs">{b.versioning}</TD>
                  <TD>
                    {b.lifecycleRules.length === 0 ? (
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

        {/* Pagination footer */}
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

function BucketDrillDown({ bucket }) {
  const region = REGIONS.find((r) => r.id === bucket.region);
  const customer = CUSTOMERS.find((c) => c.id === bucket.customerId);
  return (
    <Card>
      <CardHeader
        title={bucket.bucketName}
        subtitle={`Bucket ID ${bucket.bucketId} · Owner ${customer?.name}`}
        icon={<Database size={16} />}
        action={
          <button className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800">
            <Copy size={11} /> Copy bucket ID
          </button>
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PropertyCard
          icon={<Lock size={14} />}
          title="Encryption"
          value={bucket.encryption}
          desc={
            bucket.encryption === 'SSE-B2'
              ? 'Server-side encryption with B2-managed AES-256 keys'
              : bucket.encryption === 'SSE-C'
              ? 'Server-side encryption with customer-provided keys (SSE-C)'
              : 'No encryption configured'
          }
        />
        <PropertyCard
          icon={<ShieldCheck size={14} />}
          title="Object Lock"
          value={bucket.fileLock === 'none' ? 'Disabled' : `${bucket.fileLock} mode`}
          desc={
            bucket.fileLock === 'compliance'
              ? 'WORM compliance mode — objects cannot be deleted before retention expires'
              : bucket.fileLock === 'governance'
              ? 'Governance mode — locked unless bypassGovernance capability is granted'
              : 'No retention enforcement'
          }
        />
        <PropertyCard
          icon={<GitBranch size={14} />}
          title="Replication"
          value={bucket.replicationTo ? `→ ${REGIONS.find((r) => r.id === bucket.replicationTo)?.code}` : 'Single region'}
          desc={
            bucket.replicationTo
              ? 'Cloud Replication is configured to a different B2 account/region'
              : 'No cross-region replication configured'
          }
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card padding="p-4" className="bg-ink-900/60">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-ink-200 inline-flex items-center gap-1.5">
              <Layers size={14} /> Lifecycle rules
            </h4>
            <SourceBadge source="api" />
          </div>
          {bucket.lifecycleRules.length === 0 ? (
            <p className="text-xs text-ink-400">No lifecycle rules. Files persist until manually deleted.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {bucket.lifecycleRules.map((r, i) => (
                <li key={i} className="rounded-md bg-ink-850 p-2.5 ring-1 ring-ink-700">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-ink-100">prefix: {r.fileNamePrefix || '(all files)'}</div>
                    <Tag variant="info">native + S3 compatible</Tag>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-ink-300">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} className="text-accent-amber" />
                      hide after upload:
                      <span className="font-mono text-ink-100">{r.daysFromUploadingToHiding ? `${r.daysFromUploadingToHiding}d` : 'never (manual)'}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Trash2 size={11} className="text-bb-red" />
                      delete after hide:
                      <span className="font-mono text-ink-100">{r.daysFromHidingToDeleting ? `${r.daysFromHidingToDeleting}d` : '—'}</span>
                    </span>
                  </div>
                </li>
              ))}
              <li className="text-[10.5px] text-ink-400">
                Lifecycle rules on B2 only hide and delete files. There is no transition to a colder storage class.
              </li>
            </ul>
          )}
        </Card>
        <Card padding="p-4" className="bg-ink-900/60">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-medium text-ink-200">Access & networking</h4>
            <SourceBadge source="api" />
          </div>
          <dl className="space-y-2 text-xs">
            <KV label="Bucket type" value={bucket.bucketType} />
            <KV label="Region" value={`${region?.flag} ${region?.code}`} />
            <KV label="S3 endpoint" value={region?.s3Endpoint} mono />
            <KV label="Versioning" value={bucket.versioning} />
            <KV label="CORS origins" value={bucket.cors.length ? bucket.cors.join(', ') : 'none'} />
            <KV label="Last modified" value={new Date(bucket.lastModified).toLocaleString()} />
          </dl>
        </Card>
      </div>
    </Card>
  );
}

function PropertyCard({ icon, title, value, desc }) {
  return (
    <Card padding="p-4" className="bg-ink-900/60">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {icon}
        {title}
      </div>
      <div className="text-base font-semibold text-ink-100">{value}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{desc}</p>
    </Card>
  );
}

function KV({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className={"text-right text-ink-100 " + (mono ? "font-mono" : "")}>{value}</dd>
    </div>
  );
}
