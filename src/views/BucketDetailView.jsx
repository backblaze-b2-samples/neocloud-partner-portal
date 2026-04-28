import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Database, Lock, ShieldCheck, Eye, EyeOff, Layers, Clock, Trash2,
  GitBranch, Globe, Copy, FileText, Folder, Search, ChevronLeft, ChevronRight,
  AlertTriangle, Info,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, Tabs,
  Table, THead, TBody, TR, TH, TD, LoadingState, EmptyState,
} from '../components/ui.jsx';
import { TrendAreaChart } from '../components/charts.jsx';
import { REGIONS } from '../data/regions.js';
import { CUSTOMERS } from '../data/customers.js';
import * as b2 from '../api/b2Adapter.js';
import { useNav } from '../lib/nav.js';
import { bytes, compactNumber, shortDate, relativeTime } from '../lib/format.js';

const TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'files',     label: 'Files' },
  { id: 'lifecycle', label: 'Lifecycle & retention' },
  { id: 'access',    label: 'Access & networking' },
];

export default function BucketDetailView({ bucketId, fromCustomer }) {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState(null);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    b2.getBucket(bucketId).then((b) => {
      setBucket(b);
      setLoading(false);
    });
  }, [bucketId]);

  if (loading) return <LoadingState label="Loading bucket detail" />;
  if (!bucket) return <EmptyState title="Bucket not found" message={`No bucket with id ${bucketId}`} />;

  const region = REGIONS.find((r) => r.id === bucket.region);
  const customer = CUSTOMERS.find((c) => c.id === bucket.customerId);
  const lockEnabled = !!bucket.fileLockConfiguration?.isFileLockEnabled;

  const tabsWithCounts = [
    TABS[0],
    { ...TABS[1], count: compactNumber(bucket.objectCount) },
    { ...TABS[2], count: bucket.lifecycleRules.length + (lockEnabled ? 1 : 0) },
    TABS[3],
  ];

  const back = fromCustomer
    ? { label: `Back to ${customer?.name}`, view: 'customer-detail', params: { customerId: customer?.id } }
    : { label: 'Back to Storage', view: 'storage' };

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate(back.view, back.params)}
        className="inline-flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100"
      >
        <ArrowLeft size={12} /> {back.label}
      </button>

      <PageHeader
        eyebrow={`Bucket · ${customer?.name}`}
        title={bucket.bucketName}
        subtitle={`Bucket ID ${bucket.bucketId} · Region ${region?.flag} ${region?.code} (${region?.city}) · Last modified ${shortDate(bucket.lastModified)}`}
        actions={
          <div className="flex items-center gap-2">
            {bucket.publicAccess
              ? <Tag variant="warn"><Eye size={11} className="mr-0.5" /> public</Tag>
              : <Tag><EyeOff size={11} className="mr-0.5" /> private</Tag>}
            <button
              onClick={() => navigator.clipboard?.writeText(bucket.bucketId)}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
            >
              <Copy size={11} /> Copy bucket ID
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <MetricCard label="Storage" value={bytes(bucket.storageBytes)} source="csv" icon={<Database size={14} />} accent="red" />
        <MetricCard label="Objects" value={compactNumber(bucket.objectCount)} source="csv" accent="violet" />
        <MetricCard label="Lifecycle rules" value={bucket.lifecycleRules.length} source="api" accent="amber" />
        <MetricCard label="Encryption" value={bucket.encryption} source="api" accent="teal" />
        <MetricCard
          label="Object Lock"
          value={lockEnabled
            ? (bucket.fileLockConfiguration?.defaultRetention?.mode || 'enabled')
            : 'Disabled'}
          source="api"
          accent="green"
        />
      </div>

      <Tabs tabs={tabsWithCounts} value={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab bucket={bucket} customer={customer} region={region} />}
      {tab === 'files' && <FilesTab bucket={bucket} />}
      {tab === 'lifecycle' && <LifecycleTab bucket={bucket} />}
      {tab === 'access' && <AccessTab bucket={bucket} region={region} />}
    </div>
  );
}

// ============================================================================
function OverviewTab({ bucket, customer, region }) {
  const days = 30;
  const data = Array.from({ length: days }, (_, i) => {
    const d = new Date('2026-04-25T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days - i - 1));
    const factor = 0.92 + Math.sin((i + bucket.bucketName.length) / 4) * 0.10 + i * 0.003;
    return {
      date: d.toISOString().slice(0, 10),
      storageBytes: Math.round(bucket.storageBytes * factor),
      egressBytes: Math.round((bucket.storageBytes / 30) * 0.18 * (1 + Math.sin(i / 3) * 0.4)),
    };
  });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Bucket usage · 30 days" subtitle="Storage average and daily egress" action={<SourceBadge source="csv" />} />
        <TrendAreaChart
          data={data}
          series={[
            { key: 'storageBytes', name: 'Storage', color: '#E61F18', format: bytes },
            { key: 'egressBytes', name: 'Egress', color: '#3DD9D6', format: bytes },
          ]}
          yFormatter={bytes}
          height={240}
        />
      </Card>
      <Card>
        <CardHeader title="Bucket facts" />
        <dl className="space-y-1.5 text-xs">
          <KV label="Owner" value={customer?.name || '—'} />
          <KV label="Plan" value={customer?.plan} />
          <KV label="Bucket type" value={bucket.bucketType} />
          <KV label="Versioning" value={bucket.versioning} />
          <KV label="Region" value={`${region?.flag} ${region?.code}`} />
          <KV label="S3 endpoint" value={region?.s3Endpoint} mono />
          <KV label="CORS origins" value={bucket.cors.length ? bucket.cors.join(', ') : 'none'} />
          {bucket.replicationTo && (
            <KV label="Replication" value={`→ ${REGIONS.find((r) => r.id === bucket.replicationTo)?.code}`} />
          )}
        </dl>
      </Card>
    </div>
  );
}

// ============================================================================
// FilesTab — real cursor pagination + scale-honest sort
// ============================================================================
const PAGE_SIZES = [50, 100, 250, 1000];
const SORT_MODES = [
  { id: 'name-asc',  label: 'Name (A → Z)',     api: true },
  { id: 'name-desc', label: 'Name (Z → A)',     api: false },
  { id: 'size-desc', label: 'Size (largest first)',  api: false },
  { id: 'size-asc',  label: 'Size (smallest first)', api: false },
  { id: 'date-desc', label: 'Upload date (newest)',  api: false },
  { id: 'date-asc',  label: 'Upload date (oldest)',  api: false },
];

function FilesTab({ bucket }) {
  const [draftPrefix, setDraftPrefix] = useState('');
  const [activePrefix, setActivePrefix] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [sortMode, setSortMode] = useState('name-asc');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  // cursorStack[i] is the startFileName for page i+1. First page is null.
  const [cursorStack, setCursorStack] = useState([null]);
  const [nextCursor, setNextCursor] = useState(null);

  const currentCursor = cursorStack[cursorStack.length - 1];
  const pageNumber = cursorStack.length;

  useEffect(() => {
    setLoading(true);
    b2.listFileVersions({
      bucketId: bucket.bucketId,
      prefix: activePrefix,
      startFileName: currentCursor || undefined,
      maxFileCount: pageSize,
    }).then((r) => {
      setFiles(r.files);
      setNextCursor(r.nextFileName);
      setLoading(false);
    });
  }, [bucket.bucketId, activePrefix, currentCursor, pageSize]);

  function applyPrefix(p) {
    setActivePrefix(p);
    setCursorStack([null]);
  }
  function nextPage() { if (nextCursor) setCursorStack((s) => [...s, nextCursor]); }
  function prevPage() { if (pageNumber > 1) setCursorStack((s) => s.slice(0, -1)); }
  function firstPage() { setCursorStack([null]); }

  const sortedFiles = useMemo(() => {
    if (sortMode === 'name-asc') return files;
    const sorted = [...files];
    const cmp = {
      'name-desc': (a, b) => b.fileName.localeCompare(a.fileName),
      'size-desc': (a, b) => (b.contentLength || 0) - (a.contentLength || 0),
      'size-asc':  (a, b) => (a.contentLength || 0) - (b.contentLength || 0),
      'date-desc': (a, b) => (b.uploadTimestamp || 0) - (a.uploadTimestamp || 0),
      'date-asc':  (a, b) => (a.uploadTimestamp || 0) - (b.uploadTimestamp || 0),
    }[sortMode];
    if (cmp) sorted.sort(cmp);
    return sorted;
  }, [files, sortMode]);

  const sortIsApiNative = sortMode === 'name-asc';
  const totalBytes = files.reduce((s, f) => s + (f.contentLength || 0), 0);

  // Folder grouping (top-level prefixes from the loaded page)
  const folders = useMemo(() => {
    const m = new Map();
    files.forEach((f) => {
      const parts = f.fileName.split('/');
      if (parts.length > 1) {
        const folder = parts[0] + '/';
        const cur = m.get(folder) || { name: folder, count: 0, size: 0 };
        cur.count += 1;
        cur.size += f.contentLength || 0;
        m.set(folder, cur);
      }
    });
    return Array.from(m.values());
  }, [files]);

  return (
    <div className="space-y-4">
      {/* Scale notice — honest about the API's listing limits */}
      <Card className="border-accent-amber/30 bg-accent-amber/5" padding="p-3">
        <div className="flex items-start gap-3 text-[11.5px] text-ink-200">
          <Info size={14} className="mt-0.5 shrink-0 text-accent-amber" />
          <div className="leading-relaxed">
            <strong className="text-ink-100">Listing at scale.</strong>{' '}
            <code className="text-ink-100">b2_list_file_versions</code> returns files in lexicographic <strong>name order only</strong> with cursor-based forward pagination (<code>startFileName</code> / <code>nextFileName</code>). Sorting by size or upload date requires loading all pages and sorting client-side — not viable for buckets with millions of files. For real inventory needs, run a periodic background job that walks the bucket and writes to your own index, then keep it fresh with <a href="https://www.backblaze.com/docs/cloud-storage-event-notifications" target="_blank" rel="noreferrer" className="text-bb-red hover:underline">Event Notifications</a>. Each list call is a Class C transaction — small cost per page but it adds up over millions of files.
          </div>
        </div>
      </Card>

      {/* Controls */}
      <Card padding="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <form
            onSubmit={(e) => { e.preventDefault(); applyPrefix(draftPrefix); }}
            className="flex items-center gap-2"
          >
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                type="text"
                value={draftPrefix}
                onChange={(e) => setDraftPrefix(e.target.value)}
                placeholder="Filter by prefix (e.g. checkpoints/)"
                className="h-8 w-72 rounded-md border border-ink-700 bg-ink-900 pl-8 pr-3 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              Apply
            </button>
            {activePrefix && (
              <button
                type="button"
                onClick={() => { setDraftPrefix(''); applyPrefix(''); }}
                className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-ink-300 hover:text-ink-100"
              >
                Clear
              </button>
            )}
          </form>

          {/* Sort */}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <label className="text-ink-400">Sort</label>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            >
              {SORT_MODES.map((s) => (
                <option key={s.id} value={s.id}>{s.label} {s.api ? '· native' : '· current page'}</option>
              ))}
            </select>

            <label className="text-ink-400">Page size</label>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setCursorStack([null]); }}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <SourceBadge source="api" />
          </div>
        </div>

        {!sortIsApiNative && !loading && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent-amber/10 px-2.5 py-1 text-[11px] text-accent-amber ring-1 ring-inset ring-accent-amber/30">
            <AlertTriangle size={11} />
            Sort applies to <strong>current page only</strong> ({files.length} files). The full bucket may not be in this order.
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <MiniStat label="Files in page" value={files.length} />
          <MiniStat label="Bytes in page" value={bytes(totalBytes)} />
          <MiniStat label="Bucket total objects" value={compactNumber(bucket.objectCount)} note="csv" />
          <MiniStat label={`Page ${pageNumber}`} value={nextCursor ? 'more available' : 'last page'} />
        </div>
      </Card>

      {/* Folders */}
      {folders.length > 0 && (
        <Card padding="p-4">
          <h4 className="mb-2 text-xs font-semibold text-ink-200">Top-level folders (from this page)</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {folders.map((f) => (
              <button
                key={f.name}
                onClick={() => { setDraftPrefix(f.name); applyPrefix(f.name); }}
                className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2 text-left text-xs hover:border-ink-600 hover:bg-ink-850"
              >
                <Folder size={14} className="text-accent-amber" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-ink-100">{f.name}</div>
                  <div className="text-[10.5px] text-ink-400">{f.count} files · {bytes(f.size)}</div>
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Table */}
      {loading ? (
        <LoadingState label="Listing files via b2_list_file_versions" />
      ) : sortedFiles.length === 0 ? (
        <EmptyState
          title="No files match"
          message={activePrefix ? `No files with prefix "${activePrefix}". Try clearing the filter.` : 'This bucket is empty.'}
        />
      ) : (
        <Card padding="p-0">
          <Table>
            <THead>
              <TR hover={false}>
                <TH>File name</TH>
                <TH>Type</TH>
                <TH className="text-right">Size</TH>
                <TH className="text-right">Uploaded</TH>
                <TH>Encryption</TH>
                <TH>File ID</TH>
              </TR>
            </THead>
            <TBody>
              {sortedFiles.map((f) => (
                <TR key={f.fileId} hover={false}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <FileText size={12} className="text-ink-400" />
                      <span className="font-mono text-[12px] text-ink-100">{f.fileName}</span>
                    </div>
                  </TD>
                  <TD className="text-[11px] text-ink-300">{f.contentType}</TD>
                  <TD className="text-right font-mono text-ink-100">{bytes(f.contentLength)}</TD>
                  <TD className="text-right text-[11px] text-ink-300">{relativeTime(f.uploadTimestamp)}</TD>
                  <TD>
                    <Tag variant={f.serverSideEncryption?.mode ? 'info' : 'warn'}>
                      <Lock size={10} className="mr-0.5" /> {f.serverSideEncryption?.mode || 'none'}
                    </Tag>
                  </TD>
                  <TD className="font-mono text-[10.5px] text-ink-400">{f.fileId.slice(0, 24)}…</TD>
                </TR>
              ))}
            </TBody>
          </Table>

          {/* Pagination footer */}
          <div className="flex items-center justify-between border-t border-ink-700 px-5 py-3 text-[11px] text-ink-300">
            <div>
              Showing {sortedFiles.length} files {activePrefix && <>under <code className="text-ink-100">{activePrefix}</code></>}
              {!sortIsApiNative && <span className="ml-2 text-accent-amber">· sorted client-side (page only)</span>}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={firstPage}
                disabled={pageNumber === 1}
                className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                « First
              </button>
              <button
                onClick={prevPage}
                disabled={pageNumber === 1}
                className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={11} /> Prev
              </button>
              <span className="px-2 font-mono">Page {pageNumber}</span>
              <button
                onClick={nextPage}
                disabled={!nextCursor}
                className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={11} />
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function MiniStat({ label, value, note }) {
  return (
    <div className="rounded-md bg-ink-900/60 px-3 py-2 ring-1 ring-ink-700">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-400">
        {label}
        {note && <span className="rounded bg-ink-700 px-1 text-[8.5px] uppercase tracking-wider text-ink-300">{note}</span>}
      </div>
      <div className="mt-0.5 font-mono text-sm text-ink-100">{value}</div>
    </div>
  );
}

// ============================================================================
function LifecycleTab({ bucket }) {
  const lock = bucket.fileLockConfiguration || { isFileLockEnabled: false, defaultRetention: null };
  const def = lock.defaultRetention;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Lifecycle rules"
          subtitle="Lifecycle rules on B2 only hide and delete files. There is no transition to a colder storage class."
          icon={<Layers size={16} />}
          action={<SourceBadge source="api" />}
        />
        {bucket.lifecycleRules.length === 0 ? (
          <EmptyState title="No lifecycle rules" message="Files in this bucket will persist until manually deleted." />
        ) : (
          <ul className="space-y-3">
            {bucket.lifecycleRules.map((r, i) => (
              <li key={i} className="rounded-lg bg-ink-900/60 p-4 ring-1 ring-ink-700">
                <div className="mb-2 flex items-center justify-between">
                  <div className="font-mono text-sm text-ink-100">prefix: {r.fileNamePrefix || '(all files in bucket)'}</div>
                  <Tag variant="info">native + S3 compatible</Tag>
                </div>
                <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                  <RuleStat
                    icon={<Clock size={14} className="text-accent-amber" />}
                    title="Days from upload to hide"
                    value={r.daysFromUploadingToHiding}
                    desc="Days after upload before the file is hidden from listing operations."
                  />
                  <RuleStat
                    icon={<Trash2 size={14} className="text-bb-red" />}
                    title="Days from hide to delete"
                    value={r.daysFromHidingToDeleting}
                    desc="Days after hide before the file is permanently deleted."
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Object Lock & retention"
          subtitle="Configuration returned by b2_list_buckets → fileLockConfiguration"
          icon={<ShieldCheck size={16} />}
          action={<SourceBadge source="api" />}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RuleStat
            title="isFileLockEnabled"
            value={lock.isFileLockEnabled ? 'true' : 'false'}
            desc={lock.isFileLockEnabled
              ? 'Enabled at bucket creation — cannot be disabled later.'
              : 'Object Lock is disabled and cannot be enabled on an existing bucket.'}
          />
          <RuleStat
            title="defaultRetention.mode"
            value={def?.mode || '—'}
            desc={
              !def ? 'No default retention applied; per-object retention can still be set.'
              : def.mode === 'compliance' ? 'WORM. Cannot be deleted before retention expires, even by master key.'
              : def.mode === 'governance' ? 'Locked unless the key has bypassGovernance capability.'
              : ''
            }
          />
          <RuleStat
            title="defaultRetention.period"
            value={def?.period ? `${def.period.duration} ${def.period.unit}` : '—'}
            desc={def?.period ? 'Applied to each new object at upload time. Per-object retention can override this.' : 'No default retention period set.'}
          />
        </div>

        <div className="mt-4 rounded-md bg-ink-900/60 p-3 text-[11.5px] leading-relaxed text-ink-300 ring-1 ring-ink-700">
          <strong className="text-ink-100">What's NOT shown above:</strong> per-object <code>retainUntilTimestamp</code> (the actual retention end date) and <code>legalHold</code> are object-scoped, not bucket-scoped. They aren't returned by <code>b2_list_file_versions</code> — fetching them requires <code>b2_get_file_info</code> per file. The bucket level only exposes the <em>default</em> mode and period applied to new objects at upload time. Retention starts at upload, not at any explicit "start date" — duration counts from the upload timestamp.
        </div>
      </Card>
    </div>
  );
}

function RuleStat({ icon, title, value, desc }) {
  return (
    <div className="rounded-md bg-ink-850 p-3 ring-1 ring-ink-700">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-300">
        {icon} {title}
      </div>
      <div className="mt-1 font-mono text-base text-ink-100">{value === null || value === undefined || value === '' ? '—' : (typeof value === 'number' ? `${value} days` : value)}</div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink-400">{desc}</p>
    </div>
  );
}

// ============================================================================
function AccessTab({ bucket, region }) {
  const codeAuth = `Authorization: <auth_token>
GET https://${region?.s3Endpoint}/${bucket.bucketName}/<key>`;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Access type" subtitle={bucket.publicAccess ? 'Public read' : 'Private — requires authorization'} icon={bucket.publicAccess ? <Eye size={16} /> : <EyeOff size={16} />} />
        <p className="text-xs text-ink-300">
          {bucket.publicAccess
            ? 'Anonymous downloads are allowed. Use for CDN origins, public assets, etc.'
            : 'All operations require a valid application key with the appropriate capability (readFiles for downloads).'}
        </p>
      </Card>
      <Card>
        <CardHeader title="Encryption" icon={<Lock size={16} />} />
        <p className="text-xs text-ink-300">
          {bucket.encryption === 'SSE-B2' && 'SSE-B2 — Backblaze manages the AES-256 encryption keys. No key management required.'}
          {bucket.encryption === 'SSE-C' && 'SSE-C — clients provide their own encryption keys per request. Backblaze never stores your key.'}
          {bucket.encryption === 'none' && 'No server-side encryption. Configure SSE-B2 or SSE-C for data-at-rest protection.'}
        </p>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="S3 endpoint usage" subtitle="Use the bucket via the S3-compatible API" icon={<Globe size={16} />} />
        <pre className="overflow-x-auto rounded-md bg-ink-950/80 p-3 text-[12px] text-ink-200 ring-1 ring-ink-700">{codeAuth}</pre>
      </Card>
      <Card>
        <CardHeader title="CORS origins" />
        {bucket.cors.length === 0 ? (
          <p className="text-xs text-ink-400">No CORS origins configured. Browser-based clients won't be able to make cross-origin requests to this bucket.</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs text-ink-200">
            {bucket.cors.map((o) => <li key={o}>{o}</li>)}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Replication" icon={<GitBranch size={16} />} />
        {bucket.replicationTo ? (
          <p className="text-xs text-ink-200">
            Replicating to <span className="font-mono text-accent-violet">{REGIONS.find((r) => r.id === bucket.replicationTo)?.code}</span>.
            <span className="block mt-1 text-[10.5px] text-ink-400">Cloud Replication is configured between accounts/regions for disaster-recovery and read-locality.</span>
          </p>
        ) : (
          <p className="text-xs text-ink-400">No cross-region replication configured.</p>
        )}
      </Card>
    </div>
  );
}

function KV({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className={"text-right text-ink-100 " + (mono ? "font-mono break-all" : "")}>{value || '—'}</dd>
    </div>
  );
}
