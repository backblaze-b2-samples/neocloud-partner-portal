// =============================================================================
// Master-account B2 server-side proxy
// =============================================================================
// Operations that require downloading files from the B2 download URL
// (f###.backblazeb2.com) cannot be done reliably from the browser because:
//   1. Private buckets (like b2-reports-*) require an Authorization header.
//   2. Authorization headers trigger CORS preflight, and system buckets like
//      b2-reports-* don't have CORS rules configured to allow them.
//
// This router handles those operations server-side using the browser's
// pre-authorized B2 session.  The client (b2Adapter.js) calls ensureAuth()
// and passes the resulting token + original (non-proxied) B2 URLs in the
// POST body.  The server uses them directly — no re-authorization needed.
//
// Routes:
//   POST /api/master-b2/reports-csv
//     Finds the b2-reports-* bucket, lists CSV files in the date window,
//     downloads each one, and returns the combined rows as JSON.
//
// Client sends (JSON body):
//   authorizationToken  – from b2_authorize_account
//   apiUrl              – original B2 API URL, e.g. https://api005.backblazeb2.com
//   downloadUrl         – original B2 download URL, e.g. https://f005.backblazeb2.com
//   accountId           – B2 account ID
//   days                – how many days of data to return (1–90)
// =============================================================================

import { Router } from 'express';
import { requireAuth, requireNotDemo, requireCsrf, canAccessAccount } from '../middleware/requireAuth.js';
import { audit } from '../audit.js';
import { db } from '../db.js';
import { runForAccount as runObjectCountForAccount } from '../jobs/objectCountJob.js';
import { loadArchivedFilenames, saveToArchive, loadArchiveRows } from '../reportsArchive.js';

const router = Router();
router.use(requireAuth, requireNotDemo);

// ---------------------------------------------------------------------------
// Authorization helpers
//
// Partner staff (admin/manager/user/support) have a null accountId and may
// reach every sub-account. Customer roles carry an accountId and must be
// confined to it — object counts, bucket names and file names of one tenant
// must never be readable by another.
// ---------------------------------------------------------------------------

// Log + 403 for a cross-account attempt. Returns true so callers can
// `if (denyAccount(...)) return;`.
function denyAccount(req, res, route, accountId) {
  audit({
    actorId: req.session.user.id,
    action:  'authz.denied',
    details: { route, accountId },
    ip:      req.ip,
  });
  res.status(403).json({ error: 'Forbidden — accountId does not belong to this user' });
  return true;
}

// Guard for operations that span every sub-account (the full-fleet job).
// No per-account check can express "all accounts", so these are staff-only.
function requirePartnerStaff(req, res, next) {
  if (req.session?.user?.accountId) {
    audit({
      actorId: req.session.user.id,
      action:  'authz.denied',
      details: { route: req.originalUrl?.split('?')[0], reason: 'partner_staff_only' },
      ip:      req.ip,
    });
    return res.status(403).json({ error: 'Forbidden — partner staff only' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Server-side cache — shared across all browser sessions on this server.
//
// Keyed by accountId so different partner accounts don't share data.
// Stores the full raw row set (all dates, all regions) so any `days` window
// can be satisfied by slicing the cache rather than re-fetching from B2.
//
// TTL: 1 hour.  Refresh: first request after expiry re-fetches everything
// and updates the cache.  In-flight: only one fetch runs per accountId at
// a time — subsequent requests wait for the first to finish.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS   = 20 * 60 * 1000; // 20 minutes — keeps daily CSV reports fresh
const _cache         = new Map();       // accountId → { rows, bucketName, filesScanned, fetchedAt }
const _inflight      = new Map();       // accountId → Promise (deduplicate concurrent requests)

function getCached(accountId) {
  const entry = _cache.get(accountId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { _cache.delete(accountId); return null; }
  return entry;
}

function setCached(accountId, rows, bucketName, filesScanned) {
  _cache.set(accountId, { rows, bucketName, filesScanned, fetchedAt: Date.now() });
}

// Generic B2 Native API POST helper (server-side — no CORS constraints).
// skipAccountId: b2_list_file_names, b2_list_file_versions, b2_list_parts, etc.
// reject accountId as an unknown field in API v4. Pass skipAccountId: true for those.
async function callB2(auth, endpoint, body = {}, { skipAccountId = false } = {}) {
  const payload = skipAccountId
    ? body
    : { accountId: auth.accountId, ...body };
  const res = await fetch(`${auth.apiUrl}/b2api/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${txt}`);
  }
  return res.json();
}

// Download a B2 file by its fileId, using the auth download URL + token.
// Returns the response text.
async function downloadFile(auth, fileId) {
  const url = `${auth.downloadUrl}/b2api/v4/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    headers: { Authorization: auth.authorizationToken },
  });
  if (!res.ok) {
    throw new Error(`b2_download_file_by_id ${res.status} for fileId=${fileId}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// POST /api/master-b2/reports-csv
// ---------------------------------------------------------------------------
// Returns the last `days` days of usage rows from the b2-reports-* bucket.
//
// The browser passes its existing auth session (obtained via ensureAuth() in
// b2Adapter.js) so the server never needs to re-authorize.  Required body
// fields:
//   authorizationToken  – from b2_authorize_account
//   apiUrl              – original (non-proxied) B2 API URL, e.g. https://api005.backblazeb2.com
//   downloadUrl         – original (non-proxied) B2 download URL
//   accountId           – B2 account ID
//   days                – number of days to fetch (1–90, default 30)
// ---------------------------------------------------------------------------
router.post('/reports-csv', async (req, res) => {
  const { authorizationToken, apiUrl, downloadUrl, accountId, days: daysRaw } = req.body || {};
  // We always fetch the maximum 90-day window and store it in the cache so any
  // shorter `days` request can be satisfied without a new B2 round-trip.
  const days = Math.max(1, Math.min(90, Number(daysRaw) || 30));

  if (!authorizationToken || !apiUrl || !downloadUrl || !accountId) {
    return res.status(400).json({ error: 'authorizationToken, apiUrl, downloadUrl, and accountId are required' });
  }
  if (!canAccessAccount(req.session.user, accountId)) {
    return void denyAccount(req, res, 'master-b2/reports-csv', accountId);
  }

  // ── Serve from cache if fresh ────────────────────────────────────────────
  const hit = getCached(accountId);
  if (hit) {
    const ageMin = Math.round((Date.now() - hit.fetchedAt) / 60_000);
    console.log(`[master-b2] cache hit for ${accountId} (age ${ageMin}min, ${hit.rows.length} rows)`);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = hit.rows.filter((r) => !r._date || r._date >= cutoff);
    return res.json({ rows, bucketName: hit.bucketName, filesScanned: hit.filesScanned, fromCache: true });
  }

  // ── Deduplicate concurrent requests for the same account ─────────────────
  // If a fetch is already in-flight, wait for it rather than making a second
  // identical request to B2.
  if (_inflight.has(accountId)) {
    console.log(`[master-b2] waiting for in-flight fetch for ${accountId}`);
    try {
      const result = await _inflight.get(accountId);
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const rows = result.rows.filter((r) => !r._date || r._date >= cutoff);
      return res.json({ rows, bucketName: result.bucketName, filesScanned: result.filesScanned, fromCache: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Fetch fresh data from B2 ──────────────────────────────────────────────
  const fetchPromise = (async () => {
    const auth = { authorizationToken, apiUrl, downloadUrl, accountId };

    // Find the reports bucket (type "snapshot" / "Restricted" in the UI).
    const { buckets: allBuckets } = await callB2(auth, 'b2_list_buckets', { bucketTypes: ['all'] });
    const expectedName = `b2-reports-${auth.accountId}`;
    const reportsBucket =
      allBuckets.find((b) => b.bucketName === expectedName) ||
      allBuckets.find((b) => b.bucketName.startsWith('b2-reports-'));

    if (!reportsBucket) {
      const names = allBuckets.map((b) => b.bucketName).join(', ');
      const err = new Error(`no_reports_bucket`);
      err.detail = `Expected "${expectedName}" but found: [${names}]. Enable daily reports at https://secure.backblaze.com/reports.htm`;
      err.status = 404;
      throw err;
    }

    // List ALL CSV files in the bucket (up to 90 days) so the cache covers
    // all possible `days` values without needing a second fetch.
    const maxCutoff = new Date(Date.now() - 90 * 86_400_000);

    let fileList = [];
    let nextFileName = undefined;
    do {
      const opts = { bucketId: reportsBucket.bucketId, maxFileCount: 1000 };
      if (nextFileName) opts.startFileName = nextFileName;
      const page = await callB2(auth, 'b2_list_file_names', opts, { skipAccountId: true });
      fileList = fileList.concat(page.files || []);
      nextFileName = page.nextFileName || null;
    } while (nextFileName);

    const today = new Date();
    const csvFiles = fileList.filter((f) => {
      const m = f.fileName.match(/^(\d{4}-\d{2}-\d{2})\/[^/]+\.csv$/i);
      if (!m) return false;
      const d = new Date(m[1]);
      return d >= maxCutoff && d <= today;
    });

    // Only download files that are not already saved locally.
    // B2 retains reports indefinitely; the archive is the performance layer —
    // once a file is on disk we never need to fetch it from B2 again.
    const alreadyArchived = loadArchivedFilenames();
    const toFetch = csvFiles.filter((f) => !alreadyArchived.has(f.fileName));

    console.log(`[master-b2] "${reportsBucket.bucketName}": ${csvFiles.length} CSVs in window, ${alreadyArchived.size} already on disk, fetching ${toFetch.length} new from B2`);

    // Download new files and save them to the local archive.
    await Promise.all(
      toFetch.map(async (f) => {
        try {
          const text = await downloadFile(auth, f.fileId);
          saveToArchive(f.fileName, text);
        } catch (e) {
          console.warn(`[master-b2] failed to download ${f.fileName}: ${e.message}`);
        }
      })
    );

    // Read everything from the archive — it is now the single source of truth.
    const allRows = loadArchiveRows(maxCutoff);

    return { rows: allRows, bucketName: reportsBucket.bucketName, filesScanned: csvFiles.length, newFilesDownloaded: toFetch.length };
  })();

  _inflight.set(accountId, fetchPromise);

  try {
    const result = await fetchPromise;
    setCached(accountId, result.rows, result.bucketName, result.filesScanned);

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = result.rows.filter((r) => !r._date || r._date >= cutoff);
    res.json({ rows, bucketName: result.bucketName, filesScanned: result.filesScanned, fromCache: false });
  } catch (e) {
    console.error('[master-b2] reports-csv error:', e.message);
    if (e.status === 404) {
      res.status(404).json({ error: 'no_reports_bucket', detail: e.detail });
    } else {
      res.status(500).json({ error: e.message });
    }
  } finally {
    _inflight.delete(accountId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/master-b2/object-counts
// Returns rows from the object_counts table as JSON, scoped to what the
// caller may see: partner staff get every sub-account, a customer user gets
// only their own (bucket names and counts are tenant data).
// Written by the 24-hour background job; this read is instant (no B2 call).
// Response: { counts: [{ bucketId, accountId, bucketName, objectCount, countedAt }], jobRanAt: ISO|null }
// ---------------------------------------------------------------------------

const stmtAllCounts  = db.prepare(`SELECT bucket_id, account_id, bucket_name, object_count, total_bytes, index_status, counted_at FROM object_counts`);
const stmtLatestRun  = db.prepare(`SELECT MAX(counted_at) AS latest FROM object_counts`);
const stmtCountsForAccount = db.prepare(`SELECT bucket_id, account_id, bucket_name, object_count, total_bytes, index_status, counted_at FROM object_counts WHERE account_id = ?`);
const stmtLatestRunForAccount = db.prepare(`SELECT MAX(counted_at) AS latest FROM object_counts WHERE account_id = ?`);

router.get('/object-counts', requireAuth, (req, res) => {
  // null for partner staff → unscoped; set for customer roles → own rows only.
  const scope = req.session.user.accountId || null;
  const rows     = scope ? stmtCountsForAccount.all(scope) : stmtAllCounts.all();
  const { latest } = scope ? stmtLatestRunForAccount.get(scope) : stmtLatestRun.get();
  const counts   = rows.map((r) => ({
    bucketId:    r.bucket_id,
    accountId:   r.account_id,
    bucketName:  r.bucket_name,
    objectCount: r.object_count,
    totalBytes:  r.total_bytes || 0,
    // 'skipped_too_large' => this bucket was never fully walked; objectCount
    // and totalBytes are 0 and must not be read as real figures.
    indexStatus: r.index_status || 'indexed',
    countedAt:   r.counted_at,
  }));
  res.json({ counts, jobRanAt: latest || null });
});

// POST /api/master-b2/sync-account/:accountId
// Run the object-count job for a single sub-account on demand. Used by the
// "Refresh" button on the customer detail view to update counts + bytes
// without waiting for the next 24-hour scheduled run.
router.post('/sync-account/:accountId', requireAuth, requireCsrf, async (req, res) => {
  const { accountId } = req.params;
  if (!canAccessAccount(req.session.user, accountId)) {
    return void denyAccount(req, res, 'master-b2/sync-account', accountId);
  }
  try {
    const { runForAccount } = await import('../jobs/objectCountJob.js');
    const result = await runForAccount(accountId);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.warn(`[masterB2] sync-account ${accountId} failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/master-b2/sync-all
// Run the object-count job for every sub-account. Used by the dashboard
// "Sync" button. Synchronous — the response waits for the walk to complete
// across all accounts (with the job's internal batch-of-3 concurrency).
// Partner-staff only — it walks every tenant's buckets.
router.post('/sync-all', requireAuth, requireCsrf, requirePartnerStaff, async (_req, res) => {
  try {
    const { runObjectCountJob } = await import('../jobs/objectCountJob.js');
    await runObjectCountJob();
    res.json({ ok: true });
  } catch (e) {
    console.warn('[masterB2] sync-all failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/master-b2/object-counts/refresh/:accountId
// Run the object-count job on-demand for one sub-account. Used by the admin
// "Refresh counts" button so the operator doesn't wait for the next 24h tick.
// Returns 404 if the account has no stored credentials.
// Returns { ok: true, bucketsProcessed, elapsedMs } on success.
// ---------------------------------------------------------------------------
router.post('/object-counts/refresh/:accountId', requireAuth, requireCsrf, async (req, res) => {
  const { accountId } = req.params;
  if (!canAccessAccount(req.session.user, accountId)) {
    return void denyAccount(req, res, 'master-b2/object-counts/refresh', accountId);
  }
  try {
    const result = await runObjectCountForAccount(accountId);
    if (result.error) {
      return res.status(502).json({ error: result.error, ...result });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/No stored credentials/i.test(err.message)) {
      return res.status(404).json({ error: 'no_credentials', message: err.message });
    }
    console.error(`[masterB2] refresh object-counts failed for ${accountId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/master-b2/file-index/:bucketId
//
// Returns paginated file metadata from the file_index SQLite table.
// Written by the 24-hour background job; no B2 API call at request time.
//
// Query params:
//   prefix    – filter to files whose name starts with this string
//   limit     – rows per page (default 100, max 1000)
//   offset    – skip this many rows (for keyset-free pagination)
//   sortBy    – 'name' | 'size' | 'uploadedAt'  (default 'name')
//   sortDir   – 'asc' | 'desc'                  (default 'asc')
//
// Response: { files, total, indexedAt, isComplete }
//   files       – array of { fileName, fileId, size, uploadedAt, contentType }
//   total       – total matching rows (for pagination UI)
//   indexedAt   – ISO timestamp of the most recent index run for this bucket
//   isComplete  – true if any rows exist for this bucket (false = not yet indexed)
// ---------------------------------------------------------------------------

const VALID_SORT_COLS = { name: 'file_name', size: 'size', uploadedAt: 'uploaded_at' };

// Prepared statements for the common case (no prefix, default sort).
// Dynamic queries are built on the fly via string templates (safe — params are whitelisted).
const stmtIndexCount     = db.prepare(`SELECT COUNT(*) AS n FROM file_index WHERE bucket_id = ?`);
const stmtIndexCountPfx  = db.prepare(`SELECT COUNT(*) AS n FROM file_index WHERE bucket_id = ? AND file_name LIKE ? ESCAPE '\\'`);
const stmtIndexedAt      = db.prepare(`SELECT MAX(indexed_at) AS ts FROM file_index WHERE bucket_id = ?`);
// file_index has no account_id of its own — object_counts is the bucket→account
// join the same job writes, so use it to decide who may read these file names.
const stmtBucketOwner    = db.prepare(`SELECT account_id FROM object_counts WHERE bucket_id = ?`);

router.get('/file-index/:bucketId', requireAuth, (req, res) => {
  const { bucketId } = req.params;
  // An unknown bucketId resolves to undefined, which only partner staff can
  // pass — that stops a customer probing bucket ids they don't own.
  const owner = stmtBucketOwner.get(bucketId)?.account_id;
  if (!canAccessAccount(req.session.user, owner)) {
    return void denyAccount(req, res, 'master-b2/file-index', owner || bucketId);
  }
  const limit   = Math.min(Math.max(1, parseInt(req.query.limit)  || 100), 1000);
  const offset  = Math.max(0, parseInt(req.query.offset) || 0);
  const sortBy  = VALID_SORT_COLS[req.query.sortBy] || 'file_name';
  const sortDir = req.query.sortDir === 'desc' ? 'DESC' : 'ASC';
  const prefix  = req.query.prefix || '';

  // Escape LIKE wildcards in the prefix so user input is safe.
  const likePattern = prefix
    ? prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
    : null;

  const { ts: indexedAt } = stmtIndexedAt.get(bucketId);
  const isComplete = !!indexedAt;

  const total = likePattern
    ? stmtIndexCountPfx.get(bucketId, likePattern).n
    : stmtIndexCount.get(bucketId).n;

  // Build the SELECT dynamically — sortBy/sortDir are whitelisted above.
  const whereClause = likePattern
    ? `WHERE bucket_id = ? AND file_name LIKE ? ESCAPE '\\'`
    : `WHERE bucket_id = ?`;
  const params = likePattern
    ? [bucketId, likePattern, limit, offset]
    : [bucketId, limit, offset];

  const rows = db.prepare(
    `SELECT file_name, file_id, size, uploaded_at, content_type
     FROM file_index
     ${whereClause}
     ORDER BY ${sortBy} ${sortDir}
     LIMIT ? OFFSET ?`
  ).all(...params);

  const files = rows.map((r) => ({
    fileName:    r.file_name,
    fileId:      r.file_id,
    size:        r.size,
    uploadedAt:  r.uploaded_at,
    contentType: r.content_type,
  }));

  res.json({ files, total, indexedAt: indexedAt || null, isComplete });
});

export default router;
