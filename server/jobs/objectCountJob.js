// =============================================================================
// objectCountJob — counts objects in every sub-account bucket and caches the
// results in SQLite so page loads are instant.
//
// Tables written:
//   object_counts  — one row per bucket; total file count + last-run timestamp.
//   file_index     — one row per file; name/size/type/uploaded_at for instant
//                    sort-by-anything queries without hitting the B2 API.
//
// Design:
//   - Runs once 15 seconds after server startup (non-blocking)
//   - Then every 24 hours via setInterval
//   - For each account in account_credentials:
//       1. b2_authorize_account with the stored (decrypted) key
//       2. b2_list_buckets for that account
//       3. Paginate b2_list_file_names for each bucket — collect count + metadata
//       4. Upsert object_counts; bulk-upsert file_index; prune stale index rows
//   - Accounts run in batches of 3 to avoid hammering the B2 API
//
// GET /api/master-b2/object-counts         — instant DB read, no B2 call
// GET /api/master-b2/file-index/:bucketId  — instant DB read, sort/filter/page
// =============================================================================

import { listCredentials, getCredential, getDecryptedApplicationKey } from '../credentials.js';
import { db } from '../db.js';

const JOB_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS  = 15_000;               // give the server a moment to fully start
const CONCURRENCY       = 3;                    // sub-accounts processed in parallel
const LIST_MAX_PER_PAGE = 1000;                 // b2_list_file_names maxFileCount

// Set to false to collect counts only (faster, lower DB pressure).
// When true the job also writes per-file metadata to the file_index table.
const INDEX_FILES       = true;

// ---------------------------------------------------------------------------
// DB helpers (better-sqlite3 is synchronous — no await needed)
// ---------------------------------------------------------------------------

const stmtUpsertCount = db.prepare(`
  INSERT INTO object_counts (bucket_id, account_id, bucket_name, object_count, total_bytes, counted_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(bucket_id) DO UPDATE SET
    account_id   = excluded.account_id,
    bucket_name  = excluded.bucket_name,
    object_count = excluded.object_count,
    total_bytes  = excluded.total_bytes,
    counted_at   = excluded.counted_at,
    updated_at   = excluded.updated_at
`);

function upsertCount(bucketId, accountId, bucketName, objectCount, totalBytes) {
  const now = new Date().toISOString();
  stmtUpsertCount.run(bucketId, accountId, bucketName || bucketId, objectCount, totalBytes || 0, now, now);
}

// file_index upsert — called inside a transaction per page to keep writes fast.
const stmtUpsertFile = db.prepare(`
  INSERT INTO file_index (bucket_id, file_name, file_id, size, uploaded_at, content_type, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(bucket_id, file_name) DO UPDATE SET
    file_id      = excluded.file_id,
    size         = excluded.size,
    uploaded_at  = excluded.uploaded_at,
    content_type = excluded.content_type,
    indexed_at   = excluded.indexed_at
`);

// Bulk-write a page of files inside a single transaction (much faster than individual inserts).
const upsertFilePage = db.transaction((bucketId, files, indexedAt) => {
  for (const f of files) {
    const uploadedAt = f.uploadTimestamp
      ? new Date(f.uploadTimestamp).toISOString()
      : null;
    stmtUpsertFile.run(
      bucketId,
      f.fileName,
      f.fileId,
      f.contentLength || 0,
      uploadedAt,
      f.contentType || null,
      indexedAt,
    );
  }
});

// After a full bucket walk, delete any rows that weren't touched this run —
// those files have been deleted from the bucket since the last index.
const stmtPruneStale = db.prepare(`
  DELETE FROM file_index
  WHERE bucket_id = ? AND indexed_at < ?
`);

// ---------------------------------------------------------------------------
// B2 API helpers (server-side — direct fetch, no CORS constraints)
// ---------------------------------------------------------------------------

async function authorizeSubAccount(accountId) {
  const cred = getCredential(accountId);
  if (!cred) throw new Error(`No credentials stored for accountId ${accountId}`);

  const applicationKey = getDecryptedApplicationKey(accountId);
  if (!applicationKey) throw new Error(`Could not decrypt key for accountId ${accountId}`);

  const basic = Buffer.from(`${cred.application_key_id}:${applicationKey}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`b2_authorize_account failed (${res.status}): ${err}`);
  }

  const body  = await res.json();
  const stApi = body?.apiInfo?.storageApi;
  return {
    authorizationToken: body.authorizationToken,
    apiUrl:             stApi?.apiUrl || body.apiUrl,
    accountId:          body.accountId,
  };
}

// Generic B2 Native API POST. b2_list_file_names/b2_list_buckets reject
// accountId in the body when submitted alongside other required params.
async function b2Post(auth, endpoint, body = {}, { injectAccountId = true } = {}) {
  const payload = injectAccountId
    ? { accountId: auth.accountId, ...body }
    : body;

  const res = await fetch(`${auth.apiUrl}/b2api/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization:  auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${err}`);
  }
  return res.json();
}

// Walk all current file versions in a bucket by paginating b2_list_file_names.
// Returns the total object count.  When INDEX_FILES is true, each page is also
// written to the file_index table in a single transaction before fetching the next.
//
// b2_list_file_names returns only the latest (non-hidden) version of each file,
// which is the right count for "how many objects are in this bucket".
async function walkBucket(auth, bucketId) {
  let count        = 0;
  let totalBytes   = 0;
  let nextFileName = undefined;
  const indexedAt  = new Date().toISOString(); // consistent timestamp for this run

  do {
    const opts = { bucketId, maxFileCount: LIST_MAX_PER_PAGE };
    if (nextFileName) opts.startFileName = nextFileName;

    const page    = await b2Post(auth, 'b2_list_file_names', opts, { injectAccountId: false });
    const files   = page.files || [];
    count        += files.length;
    for (const f of files) totalBytes += (f.contentLength || 0);
    nextFileName  = page.nextFileName || null;

    if (INDEX_FILES && files.length > 0) {
      upsertFilePage(bucketId, files, indexedAt);
    }
  } while (nextFileName);

  // Remove any rows from a previous run that no longer exist in the bucket.
  if (INDEX_FILES) {
    stmtPruneStale.run(bucketId, indexedAt);
  }

  return { count, totalBytes };
}

// ---------------------------------------------------------------------------
// Per-account counting
// ---------------------------------------------------------------------------

async function processAccount(storedCred) {
  const { account_id: accountId } = storedCred;
  let auth;
  try {
    auth = await authorizeSubAccount(accountId);
  } catch (e) {
    console.warn(`[objectCountJob] auth failed for ${accountId}: ${e.message}`);
    return { accountId, bucketsProcessed: 0, error: e.message };
  }

  let { buckets } = await b2Post(auth, 'b2_list_buckets', {});
  buckets = buckets || [];

  let bucketsProcessed = 0;
  for (const bucket of buckets) {
    try {
      const { count, totalBytes } = await walkBucket(auth, bucket.bucketId);
      upsertCount(bucket.bucketId, accountId, bucket.bucketName, count, totalBytes);
      bucketsProcessed++;
      console.log(
        `[objectCountJob] ${accountId}/${bucket.bucketName}: ${count.toLocaleString()} objects, ` +
        `${(totalBytes / 1e9).toFixed(2)} GB` +
        (INDEX_FILES ? ' (indexed)' : '')
      );
    } catch (e) {
      console.warn(`[objectCountJob] failed on ${accountId}/${bucket.bucketName}: ${e.message}`);
    }
  }

  return { accountId, bucketsProcessed };
}

// Exposed for the per-account refresh endpoint — runs the same per-account
// walk synchronously so the caller can wait for fresh counts/bytes.
export async function runForAccount(accountId) {
  const cred = listCredentials().find((c) => c.account_id === accountId);
  if (!cred) throw new Error(`No credentials stored for accountId ${accountId}`);
  return processAccount(cred);
}

// ---------------------------------------------------------------------------
// Main job entry point
// ---------------------------------------------------------------------------

export async function runObjectCountJob() {
  const jobStart = Date.now();
  console.log('[objectCountJob] starting...');

  const credentials = listCredentials();
  if (!credentials.length) {
    console.log('[objectCountJob] no stored credentials — nothing to count');
    return;
  }

  console.log(`[objectCountJob] processing ${credentials.length} sub-account(s) in batches of ${CONCURRENCY}`);

  let totalBuckets = 0;
  let totalErrors  = 0;

  // Process in batches to limit concurrent B2 connections.
  for (let i = 0; i < credentials.length; i += CONCURRENCY) {
    const batch   = credentials.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processAccount));
    for (const r of results) {
      if (r.error) totalErrors++;
      else totalBuckets += r.bucketsProcessed;
    }
  }

  const elapsedSec = ((Date.now() - jobStart) / 1000).toFixed(1);
  console.log(
    `[objectCountJob] done — ${totalBuckets} bucket(s) counted across ` +
    `${credentials.length} account(s) (${totalErrors} error(s)) in ${elapsedSec}s`
  );
}

// ---------------------------------------------------------------------------
// Scheduler — call once from server/index.js
// ---------------------------------------------------------------------------

export function scheduleObjectCountJob() {
  // Delayed startup run so it doesn't block the initial server boot.
  setTimeout(() => {
    runObjectCountJob().catch((e) =>
      console.error('[objectCountJob] startup run failed:', e.message)
    );
  }, STARTUP_DELAY_MS);

  // Recurring 24-hour interval.
  setInterval(() => {
    runObjectCountJob().catch((e) =>
      console.error('[objectCountJob] scheduled run failed:', e.message)
    );
  }, JOB_INTERVAL_MS);

  const delayMin = Math.round(STARTUP_DELAY_MS / 1000);
  console.log(`[objectCountJob] scheduled — first run in ${delayMin}s, then every 24h`);
}
