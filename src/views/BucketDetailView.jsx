import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Database, Lock, ShieldCheck, Eye, EyeOff, Layers, Clock, Trash2,
  GitBranch, Globe, Copy, FileText, Folder, Search, ChevronLeft, ChevronRight,
  AlertTriangle, Info, History, ChevronDown, ChevronUp, EyeOff as HideIcon,
  ScrollText, CheckCircle2, UploadCloud, Download,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, Tabs,
  Table, THead, TBody, TR, TH, TD, LoadingState, EmptyState, ErrorState,
} from '../components/ui.jsx';
import { TrendAreaChart } from '../components/charts.jsx';
import { FileUploadDialog, DeleteFileDialog } from '../components/bucketDialogs.jsx';
import { REGIONS } from '../data/regions.js';
import { CUSTOMERS } from '../data/customers.js';
import * as b2 from '../api/b2Adapter.js';
import { useNav } from '../lib/nav.js';
import { useApp } from '../lib/AppContext.jsx';
import { bytes, compactNumber, shortDate, relativeTime } from '../lib/format.js';

const TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'files',     label: 'Files' },
  { id: 'lifecycle', label: 'Lifecycle & retention' },
  { id: 'access',    label: 'Access & networking' },
];

export default function BucketDetailView({ bucketId, fromCustomer, accountId, customerName, customerRegion }) {
  const { navigate } = useNav();
  const { isCustomer, isCustomerAdmin } = useApp();
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState(null);
  // Populated by FilesTab after its first listing call completes.
  const [liveStats, setLiveStats] = useState(null); // { objectCount, storageBytes, isLastPage }

  const load = () => {
    setError(null);
    setLoading(true);
    Promise.all([
      b2.getBucket(bucketId, { accountId }),
      b2.listFileVersions({ bucketId, accountId, maxFileCount: 1000 }),
      b2.getObjectCounts(),
    ]).then(([b, fileResp, objectCounts]) => {
      const oc = objectCounts.get(bucketId);
      setBucket(b ? {
        ...b,
        objectCount:  oc?.count ?? b.objectCount ?? null,
        storageBytes: oc?.totalBytes ?? b.storageBytes ?? null,
      } : b);
      if (fileResp?.files) {
        const pageBytes = fileResp.files.reduce((s, f) => s + (f.contentLength || 0), 0);
        setLiveStats({
          objectCount: fileResp.files.length,
          storageBytes: pageBytes,
          isLastPage: !fileResp.nextFileName,
        });
      }
      setLoading(false);
    }).catch((e) => { setError(e?.message || String(e)); setLoading(false); });
  };

  useEffect(load, [bucketId]);

  if (error) return <ErrorState title="Could not load bucket" message={error} onRetry={load} />;
  if (loading) return <LoadingState label="Loading bucket detail" />;
  if (!bucket) return <EmptyState title="Bucket not found" message={`No bucket with id ${bucketId}`} />;

  // bucket.region is set when _apiHost was injected by the proxy (requires deploy).
  // Fall back to customerRegion passed through navigation params.
  const resolvedRegionId = bucket.region || customerRegion || null;
  const region = REGIONS.find((r) => r.id === resolvedRegionId);
  // File CRUD is gated to customer_admin / partner staff and needs the bucket's
  // accountId (to scope the proxy) and region (to sign S3 requests).
  const canManage = (isCustomerAdmin || !isCustomer) && !!accountId;
  // In live mode bucket.customerId is null — use customerName from nav params.
  // accountId IS the customer's id in live mode (see getCustomer in partnerApi.js),
  // so include it in the fallback so the "Back to <name>" link navigates correctly.
  const customer = CUSTOMERS.find((c) => c.id === bucket.customerId)
    || (customerName ? { id: accountId, name: customerName } : null);
  // normalizeBucket() derives a `fileLock` field ('none' | 'compliance' | 'governance' | 'enabled').
  // Prefer that over reading the raw nested fileLockConfiguration structure.
  const lockEnabled = bucket.fileLock && bucket.fileLock !== 'none';

  // Prefer live stats from file listing; fall back to bucket metadata (usually null in live mode).
  const displayObjectCount = liveStats?.objectCount ?? bucket.objectCount;
  const displayStorageBytes = liveStats?.storageBytes ?? bucket.storageBytes;
  const statsSource = liveStats ? 'api' : 'csv';
  const statsLabel = liveStats && !liveStats.isLastPage ? ' (page)' : '';

  const tabsWithCounts = [
    TABS[0],
    { ...TABS[1], count: compactNumber(displayObjectCount) },
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

      {bucket._noCredentials && (
        <div className="flex items-start gap-3 rounded-lg border border-accent-amber/30 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Limited view — sub-account credentials not stored.</span>{' '}
            Live bucket metadata, file listing, and logging status are unavailable for account{' '}
            <code className="text-ink-200">{bucket.accountId}</code>.
            To enable full drill-through, add this customer's credentials in the{' '}
            <strong>Customers</strong> section.
          </div>
        </div>
      )}

      <PageHeader
        eyebrow={`Bucket · ${customer?.name || bucket.accountId}`}
        title={bucket.bucketName}
        subtitle={`Bucket ID ${bucket.bucketId}${region ? ` · Region ${region.flag} ${region.code} (${region.city})` : ''}${bucket.lastModified ? ` · Last modified ${shortDate(bucket.lastModified)}` : ''}`}
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
        <MetricCard label={`Storage${statsLabel}`} value={bytes(displayStorageBytes)} source={statsSource} icon={<Database size={14} />} accent="red" />
        <MetricCard label={`Objects${statsLabel}`} value={compactNumber(displayObjectCount)} source={statsSource} accent="violet" />
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
      {tab === 'files' && <FilesTab bucket={bucket} accountId={accountId} regionId={resolvedRegionId} canManage={canManage} onStats={setLiveStats} />}
      {tab === 'lifecycle' && <LifecycleTab bucket={bucket} />}
      {tab === 'access' && <AccessTab bucket={bucket} region={region} accountId={accountId} />}
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
  { id: 'name-asc',  label: 'Name (A → Z)',          sortBy: 'name',       sortDir: 'asc'  },
  { id: 'name-desc', label: 'Name (Z → A)',          sortBy: 'name',       sortDir: 'desc' },
  { id: 'size-desc', label: 'Size (largest first)',  sortBy: 'size',       sortDir: 'desc' },
  { id: 'size-asc',  label: 'Size (smallest first)', sortBy: 'size',       sortDir: 'asc'  },
  { id: 'date-desc', label: 'Upload date (newest)',  sortBy: 'uploadedAt', sortDir: 'desc' },
  { id: 'date-asc',  label: 'Upload date (oldest)',  sortBy: 'uploadedAt', sortDir: 'asc'  },
];

// Translate a file_index row into the shape FileRow expects.
function indexRowToFile(f) {
  return {
    fileName:           f.fileName,
    fileId:             f.fileId,
    contentLength:      f.size,
    uploadTimestamp:    f.uploadedAt ? new Date(f.uploadedAt).getTime() : null,
    contentType:        f.contentType || '—',
    serverSideEncryption: null, // not stored in the index
    _fromIndex: true,
  };
}

function FilesTab({ bucket, accountId, regionId, canManage, onStats }) {
  const [draftPrefix, setDraftPrefix] = useState('');
  const [activePrefix, setActivePrefix] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [sortMode, setSortMode] = useState('name-asc');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteFileTarget, setDeleteFileTarget] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  // ── Index mode (background job has run) ────────────────────────────────
  // null = not yet detected; false = not indexed; true = indexed
  const [indexed, setIndexed] = useState(null);
  const [indexedAt, setIndexedAt] = useState(null);  // ISO timestamp
  const [totalFiles, setTotalFiles] = useState(null); // total matching rows
  const [indexPage, setIndexPage] = useState(1);

  // ── Live mode (cursor-based, B2 API fallback) ───────────────────────────
  const [cursorStack, setCursorStack] = useState([null]);
  const [nextCursor, setNextCursor] = useState(null);

  const currentCursor = cursorStack[cursorStack.length - 1];
  const livePage = cursorStack.length;
  const sortDef = SORT_MODES.find((s) => s.id === sortMode) || SORT_MODES[0];

  // Reset pagination when prefix, pageSize, or sort changes.
  // Also resets mode detection (indexed may change between buckets).
  useEffect(() => {
    setIndexPage(1);
    setCursorStack([null]);
  }, [bucket.bucketId, activePrefix, pageSize, sortMode]);

  // ── Data fetching ────────────────────────────────────────────────────────
  // Phase 1 (indexed === null): probe the index. Sets `indexed` true/false.
  // Phase 2: fetch from index or live depending on `indexed`.
  useEffect(() => {
    if (indexed === null) {
      // Probe: check if this bucket has been indexed yet.
      b2.getFileIndex(bucket.bucketId, { limit: 1 }).then((probe) => {
        setIndexed(probe.isComplete);
        setIndexedAt(probe.indexedAt);
        // Don't fetch yet — the state update will trigger the next effect run.
      });
      return;
    }

    setLoading(true);

    if (indexed) {
      // ── Index path: instant DB read, any sort order ──────────────────
      b2.getFileIndex(bucket.bucketId, {
        prefix:  activePrefix,
        limit:   pageSize,
        offset:  (indexPage - 1) * pageSize,
        sortBy:  sortDef.sortBy,
        sortDir: sortDef.sortDir,
      }).then((r) => {
        setFiles((r.files || []).map(indexRowToFile));
        setTotalFiles(r.total ?? null);
        setIndexedAt(r.indexedAt);
        setLoading(false);
        if (onStats && !activePrefix && indexPage === 1) {
          onStats({ objectCount: r.total ?? 0, storageBytes: null, isLastPage: true });
        }
      }).catch(() => { setFiles([]); setLoading(false); });
    } else {
      // ── Live path: cursor-based B2 API ───────────────────────────────
      b2.listFileVersions({
        bucketId:      bucket.bucketId,
        accountId,
        prefix:        activePrefix,
        startFileName: currentCursor || undefined,
        maxFileCount:  pageSize,
      }).then((r) => {
        setFiles(r.files || []);
        setNextCursor(r.nextFileName || null);
        setLoading(false);
        if (onStats && !activePrefix && !currentCursor) {
          const pageBytes = (r.files || []).reduce((s, f) => s + (f.contentLength || 0), 0);
          onStats({ objectCount: r.files?.length ?? 0, storageBytes: pageBytes, isLastPage: !r.nextFileName });
        }
      }).catch(() => { setFiles([]); setLoading(false); });
    }
  }, [bucket.bucketId, indexed, activePrefix, indexPage, currentCursor, pageSize, sortMode, reloadToken]);

  // ── Actions ──────────────────────────────────────────────────────────────
  function applyPrefix(p) {
    setActivePrefix(p);
    setIndexPage(1);
    setCursorStack([null]);
  }
  // Index pagination (offset-based)
  const totalIndexPages = totalFiles != null ? Math.ceil(totalFiles / pageSize) || 1 : null;
  function indexNextPage() { if (indexPage < totalIndexPages) setIndexPage((p) => p + 1); }
  function indexPrevPage() { if (indexPage > 1) setIndexPage((p) => p - 1); }
  function indexFirstPage() { setIndexPage(1); }
  function indexLastPage()  { if (totalIndexPages) setIndexPage(totalIndexPages); }
  // Live pagination (cursor-based)
  function nextPage()  { if (nextCursor) setCursorStack((s) => [...s, nextCursor]); }
  function prevPage()  { if (livePage > 1) setCursorStack((s) => s.slice(0, -1)); }
  function firstPage() { setCursorStack([null]); }

  // In live mode only name-asc is server-native; other sorts are client-side.
  const sortedFiles = useMemo(() => {
    if (indexed || sortMode === 'name-asc') return files; // index: server already sorted
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
  }, [files, sortMode, indexed]);

  const sortIsClientSide = !indexed && sortMode !== 'name-asc';
  // Indexed rows come from file_index.size; live API rows come from b2_list_file_names.contentLength.
  const totalBytes = files.reduce((s, f) => s + (f.size ?? f.contentLength ?? 0), 0);

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
      {/* Status banner — adapts based on whether the index has run */}
      {indexed ? (
        <Card className="border-teal-500/30 bg-teal-500/5" padding="p-3">
          <div className="flex items-start gap-3 text-[11.5px] text-ink-200">
            <Database size={14} className="mt-0.5 shrink-0 text-teal-400" />
            <div className="leading-relaxed">
              <strong className="text-ink-100">Served from local index.</strong>{' '}
              File metadata is stored in a SQLite index built by the 24-hour background job.
              All sort orders are server-native, prefix filters run in the DB, and pagination
              is instant — no B2 API calls at browse time.
              {indexedAt && (
                <span className="ml-1 text-ink-400">
                  Last indexed {relativeTime(new Date(indexedAt).getTime())}.
                </span>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="border-accent-amber/30 bg-accent-amber/5" padding="p-3">
          <div className="flex items-start gap-3 text-[11.5px] text-ink-200">
            <Info size={14} className="mt-0.5 shrink-0 text-accent-amber" />
            <div className="leading-relaxed">
              <strong className="text-ink-100">Listing at scale.</strong>{' '}
              <code className="text-ink-100">b2_list_file_names</code> returns files in lexicographic <strong>name order only</strong> with cursor-based forward pagination. Sorting by size or upload date is applied to the current page only — not viable for large buckets. Once the 24-hour background job has run for this bucket, all sorts become server-native and pagination becomes instant.
            </div>
          </div>
        </Card>
      )}

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

          {canManage && (
            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              <UploadCloud size={13} /> Upload
            </button>
          )}

          {/* Sort + page size */}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <label className="text-ink-400">Sort</label>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            >
              {SORT_MODES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}{indexed ? '' : s.sortBy === 'name' && s.sortDir === 'asc' ? ' · native' : ' · page only'}
                </option>
              ))}
            </select>

            <label className="text-ink-400">Page size</label>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 rounded-md border border-ink-700 bg-ink-900 px-2 text-xs text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <SourceBadge source={indexed ? 'db' : 'api'} />
          </div>
        </div>

        {sortIsClientSide && !loading && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent-amber/10 px-2.5 py-1 text-[11px] text-accent-amber ring-1 ring-inset ring-accent-amber/30">
            <AlertTriangle size={11} />
            Sort applies to <strong>current page only</strong> ({files.length} files). The full bucket may not be in this order.
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <MiniStat label="Files in page" value={files.length} />
          <MiniStat label="Bytes in page" value={bytes(totalBytes)} />
          <MiniStat label="Bucket total objects" value={compactNumber(indexed ? totalFiles : bucket.objectCount)} />
          {indexed
            ? <MiniStat label={`Page ${indexPage}`} value={totalIndexPages ? `of ${totalIndexPages}` : '…'} />
            : <MiniStat label={`Page ${livePage}`} value={nextCursor ? 'more available' : 'last page'} />}
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
        <LoadingState label="Listing files via b2_list_file_names" />
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
                <TH className="w-20 text-center">Versions</TH>
                <TH className="w-24 text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {sortedFiles.map((f) => (
                <FileRow
                  key={f.fileId}
                  f={f}
                  bucket={bucket}
                  regionId={regionId}
                  accountId={accountId}
                  canManage={canManage}
                  onDownload={() => b2.downloadFile({ accountId, bucket: bucket.bucketName, region: regionId, key: f.fileName })}
                  onDelete={() => setDeleteFileTarget(f)}
                />
              ))}
            </TBody>
          </Table>

          {/* Pagination footer */}
          <div className="flex items-center justify-between border-t border-ink-700 px-5 py-3 text-[11px] text-ink-300">
            <div>
              Showing {sortedFiles.length} files
              {activePrefix && <> under <code className="text-ink-100">{activePrefix}</code></>}
              {sortIsClientSide && <span className="ml-2 text-accent-amber">· sorted client-side (page only)</span>}
              {indexed && totalFiles != null && <span className="ml-2 text-teal-400">· {totalFiles.toLocaleString()} total in index</span>}
            </div>
            {indexed ? (
              <div className="flex items-center gap-1">
                <button onClick={indexFirstPage} disabled={indexPage === 1}
                  className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  « First
                </button>
                <button onClick={indexPrevPage} disabled={indexPage === 1}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  <ChevronLeft size={11} /> Prev
                </button>
                <span className="px-2 font-mono">
                  Page {indexPage}{totalIndexPages ? ` / ${totalIndexPages}` : ''}
                </span>
                <button onClick={indexNextPage} disabled={totalIndexPages != null && indexPage >= totalIndexPages}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  Next <ChevronRight size={11} />
                </button>
                <button onClick={indexLastPage} disabled={totalIndexPages != null && indexPage >= totalIndexPages}
                  className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  Last »
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button onClick={firstPage} disabled={livePage === 1}
                  className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  « First
                </button>
                <button onClick={prevPage} disabled={livePage === 1}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  <ChevronLeft size={11} /> Prev
                </button>
                <span className="px-2 font-mono">Page {livePage}</span>
                <button onClick={nextPage} disabled={!nextCursor}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  Next <ChevronRight size={11} />
                </button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Gated file CRUD */}
      {canManage && uploadOpen && (
        <FileUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onUploaded={reload}
          accountId={accountId}
          bucket={bucket}
          region={regionId}
          activePrefix={activePrefix}
        />
      )}
      {canManage && deleteFileTarget && (
        <DeleteFileDialog
          open={!!deleteFileTarget}
          onClose={() => setDeleteFileTarget(null)}
          onDeleted={() => { setDeleteFileTarget(null); reload(); }}
          file={deleteFileTarget}
          bucket={bucket}
          region={regionId}
          accountId={accountId}
        />
      )}
    </div>
  );
}

// ============================================================================
// FileRow — a single file row with an expandable version history panel
// ============================================================================
function FileRow({ f, bucket, regionId, accountId, canManage, onDownload, onDelete }) {
  const bucketId = bucket.bucketId;
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState(null); // null = not loaded yet
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  function toggleVersions() {
    if (!expanded && versions === null) {
      setVersionsLoading(true);
      b2.getFileVersions({ bucketId, fileName: f.fileName })
        .then(({ versions: v }) => { setVersions(v); setVersionsLoading(false); })
        .catch(() => { setVersions([]); setVersionsLoading(false); });
    }
    setExpanded((e) => !e);
  }

  async function handleDownload() {
    setDownloading(true);
    try { await onDownload(); } finally { setDownloading(false); }
  }

  const versionCount = versions?.length ?? null;

  return (
    <>
      <TR hover={false}>
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
          {f._fromIndex
            ? <Tag variant="default"><Lock size={10} className="mr-0.5" /> —</Tag>
            : <Tag variant={f.serverSideEncryption?.mode ? 'info' : 'warn'}>
                <Lock size={10} className="mr-0.5" /> {f.serverSideEncryption?.mode || 'none'}
              </Tag>
          }
        </TD>
        <TD className="font-mono text-[10.5px] text-ink-400">{f.fileId.slice(0, 24)}…</TD>
        <TD className="text-center">
          <button
            onClick={toggleVersions}
            title={expanded ? 'Hide version history' : 'Show version history'}
            className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[10.5px] text-ink-300 hover:border-ink-500 hover:text-ink-100"
          >
            <History size={11} />
            {versionCount !== null ? (
              <span className={versionCount > 1 ? 'text-accent-amber font-semibold' : ''}>{versionCount}</span>
            ) : (
              <span className="text-ink-500">—</span>
            )}
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
        </TD>
        <TD className="text-right">
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={handleDownload}
              disabled={downloading || !regionId}
              title={regionId ? 'Download' : 'Region unknown — open from the Storage list'}
              className="grid h-7 w-7 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:text-ink-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={12} className={downloading ? 'animate-pulse' : ''} />
            </button>
            {canManage && (
              <button
                onClick={onDelete}
                title="Delete file"
                className="grid h-7 w-7 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:text-bb-red"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </TD>
      </TR>
      {expanded && (
        <tr className="bg-ink-900/60">
          <td colSpan={8} className="px-6 py-3">
            {versionsLoading ? (
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <span className="animate-spin">⟳</span> Loading versions…
              </div>
            ) : versions?.length === 0 ? (
              <div className="text-[11px] text-ink-400">No version history found.</div>
            ) : (
              <div className="space-y-1">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                  Version history · {versions?.length} version{versions?.length !== 1 ? 's' : ''} stored
                  <span className="ml-2 font-normal normal-case text-ink-500">
                    · b2_list_file_versions — oldest versions incur storage cost until deleted
                  </span>
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-ink-500">
                      <th className="pb-1 pr-4 font-medium">File ID</th>
                      <th className="pb-1 pr-4 font-medium">Action</th>
                      <th className="pb-1 pr-4 font-medium text-right">Size</th>
                      <th className="pb-1 pr-4 font-medium text-right">Uploaded</th>
                      <th className="pb-1 font-medium">Encryption</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions?.map((v, i) => {
                      const isHide = v.action === 'hide';
                      const isCurrent = i === 0;
                      return (
                        <tr key={v.fileId} className={isHide ? 'opacity-50' : ''}>
                          <td className="py-0.5 pr-4 font-mono text-ink-400">{v.fileId?.slice(0, 28)}…</td>
                          <td className="py-0.5 pr-4">
                            {isCurrent && !isHide
                              ? <span className="rounded-full bg-accent-green/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-accent-green ring-1 ring-inset ring-accent-green/30">current</span>
                              : isHide
                              ? <span className="rounded-full bg-bb-red/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-bb-red ring-1 ring-inset ring-bb-red/30">hide marker</span>
                              : <span className="rounded-full bg-ink-700 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-ink-400">old version</span>
                            }
                          </td>
                          <td className="py-0.5 pr-4 text-right font-mono text-ink-300">
                            {isHide ? '—' : bytes(v.contentLength)}
                          </td>
                          <td className="py-0.5 pr-4 text-right text-ink-300">
                            {relativeTime(v.uploadTimestamp)}
                          </td>
                          <td className="py-0.5 text-ink-400">
                            {v.serverSideEncryption?.mode || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
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
function AccessTab({ bucket, region, accountId }) {
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

      {/* Access Logs — full width */}
      <div className="lg:col-span-2">
        <AccessLogsPanel bucket={bucket} region={region} accountId={accountId} />
      </div>
    </div>
  );
}

// ============================================================================
// AccessLogsPanel — configure S3 PutBucketLogging / GetBucketLogging
// Ref: https://www.backblaze.com/docs/cloud-storage-bucket-access-logs
// ============================================================================
function AccessLogsPanel({ bucket, region, accountId }) {
  const [loading, setLoading]   = useState(true);
  const [config, setConfig]     = useState(null);  // { enabled, targetBucket, targetPrefix }
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState(null);
  const [noCredentials, setNoCredentials] = useState(false);

  // Edit state
  const [editEnabled, setEditEnabled]           = useState(false);
  const [editTargetBucket, setEditTargetBucket] = useState('');
  const [editTargetPrefix, setEditTargetPrefix] = useState('');

  const bucketRegion = region?.id || bucket.region;

  useEffect(() => {
    if (!bucketRegion || !accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    b2.getBucketLogging({
      bucketId: bucket.bucketId,
      bucketName: bucket.bucketName,
      bucketRegion,
      accountId,
    })
      .then((cfg) => {
        if (cfg._noCredentials) { setNoCredentials(true); setLoading(false); return; }
        setConfig(cfg);
        setEditEnabled(cfg.enabled);
        setEditTargetBucket(cfg.targetBucket || '');
        setEditTargetPrefix(cfg.targetPrefix || '');
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err.message || err));
        setLoading(false);
      });
  }, [bucket.bucketId, bucketRegion, accountId]);

  async function save() {
    if (editEnabled && !editTargetBucket.trim()) {
      setError('Target bucket name is required when enabling logging.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await b2.setBucketLogging({
        bucketId:     bucket.bucketId,
        bucketName:   bucket.bucketName,
        bucketRegion,
        accountId,
        enabled:      editEnabled,
        targetBucket: editTargetBucket.trim() || null,
        targetPrefix: editTargetPrefix.trim(),
      });
      setConfig({ enabled: result.enabled, targetBucket: result.targetBucket, targetPrefix: result.targetPrefix });
      setSaved(true);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSaving(false);
    }
  }

  const dirty = config && (
    editEnabled     !== config.enabled     ||
    editTargetBucket !== (config.targetBucket || '') ||
    editTargetPrefix !== (config.targetPrefix || '')
  );

  return (
    <Card>
      <CardHeader
        title="Bucket access logs"
        subtitle="Per-request audit records delivered to a destination B2 bucket via S3 PutBucketLogging."
        icon={<ScrollText size={16} />}
        action={<SourceBadge source="api" />}
      />

      {loading && <div className="py-4 text-xs text-ink-400">Loading logging configuration…</div>}

      {noCredentials && !loading && (
        <div className="flex items-start gap-2 rounded-md border border-accent-amber/30 bg-accent-amber/5 p-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>No sub-account credentials stored for this customer. Save credentials in the customer detail view to enable log configuration.</span>
        </div>
      )}

      {!bucketRegion && !loading && (
        <div className="flex items-start gap-2 rounded-md border border-accent-amber/30 bg-accent-amber/5 p-3 text-xs text-accent-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>Bucket region unknown — cannot determine the S3 logging endpoint. Deploy the latest server build so <code>_apiHost</code> is injected by the customer proxy.</span>
        </div>
      )}

      {config && !loading && (
        <div className="space-y-4">
          {/* Current status summary */}
          <div className="flex items-center gap-2 text-xs">
            {config.enabled ? (
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-green/15 px-2 py-0.5 text-[11px] font-semibold text-accent-green ring-1 ring-inset ring-accent-green/30">
                  <CheckCircle2 size={10} /> Enabled
                </span>
                <span className="text-ink-300">
                  → <span className="font-mono text-ink-100">{config.targetBucket}</span>
                  {config.targetPrefix && <span className="text-ink-400"> / {config.targetPrefix}</span>}
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-700 px-2 py-0.5 text-[11px] text-ink-400">
                Disabled
              </span>
            )}
          </div>

          {/* Edit form */}
          <div className="space-y-3 rounded-md border border-ink-700 bg-ink-900/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Configure logging</p>

            <label className="flex items-center gap-2 text-xs text-ink-200">
              <input
                type="checkbox"
                checked={editEnabled}
                onChange={(e) => setEditEnabled(e.target.checked)}
                className="accent-bb-red"
              />
              Enable access logs for this bucket
            </label>

            {editEnabled && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-ink-200">Target bucket <span className="text-bb-red">*</span></div>
                  <input
                    type="text"
                    value={editTargetBucket}
                    onChange={(e) => setEditTargetBucket(e.target.value)}
                    placeholder={`${bucket.bucketName}-access-logs`}
                    className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
                  />
                  <p className="mt-1 text-[10.5px] text-ink-400">Destination bucket for log files. Can be the same bucket or a different one in your account.</p>
                </label>
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-ink-200">Log prefix <span className="text-ink-500">(optional)</span></div>
                  <input
                    type="text"
                    value={editTargetPrefix}
                    onChange={(e) => setEditTargetPrefix(e.target.value)}
                    placeholder={`logs/${bucket.bucketName}/`}
                    className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
                  />
                  <p className="mt-1 text-[10.5px] text-ink-400">
                    Prefix added to each log file key. B2 appends <code className="text-ink-300">accountId/region/bucket/YYYY/MM/DD/</code> automatically.
                  </p>
                </label>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-bb-red/30 bg-bb-red/5 px-3 py-2 text-xs text-bb-red">{error}</div>
            )}
            {saved && !error && (
              <div className="flex items-center gap-1.5 text-xs text-accent-green">
                <CheckCircle2 size={12} /> Logging configuration saved.
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={saving || !dirty}
                className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <span className="text-[10.5px] text-ink-500">Calls S3 PutBucketLogging · requires <code>writeBucketLogging</code> capability</span>
            </div>
          </div>

          {/* Delivery notes */}
          <div className="rounded-md bg-ink-900/40 p-3 text-[11px] leading-relaxed text-ink-400 ring-1 ring-ink-700">
            <strong className="text-ink-200">Delivery notes:</strong> Logs are delivered on a best-effort basis, typically within a few hours of the request. Delivery is not guaranteed — records may be incomplete or contain duplicates. Do not use for billing accounting. The application key reading this bucket must have the <code className="text-ink-300">readBucketLogging</code> capability to retrieve the configuration, and <code className="text-ink-300">writeBucketLogging</code> to change it.
          </div>
        </div>
      )}
    </Card>
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
