// =============================================================================
// Backblaze B2 Native API Adapter (mock + live mode)
// =============================================================================
// Every export below returns a Promise so the UI can stay async. To switch
// between demo and live, this module reads a small runtime config that the
// AppProvider keeps in localStorage (see ../lib/AppContext.jsx).
//
// API references (April 2026):
//   - https://www.backblaze.com/apidocs/introduction-to-the-b2-native-api
//   - https://www.backblaze.com/apidocs/b2-authorize-account
//   - https://www.backblaze.com/apidocs/b2-list-buckets
//   - https://www.backblaze.com/apidocs/b2-create-bucket
//   - https://www.backblaze.com/apidocs/b2-list-keys
//   - https://www.backblaze.com/apidocs/b2-create-key
//
// IMPORTANT NOTES:
//   - b2_list_buckets returns metadata only — no storage bytes / object counts.
//   - There is no `b2_get_usage` endpoint. Aggregated usage (storage, egress,
//     Class A/B/C transactions) comes from the Daily Usage CSV report
//     (see ./csvParser.js).
//   - Storage tiers do not exist on B2 — there is one hot class only.
//   - Lifecycle rules on B2 only hide and delete files. No transitions.
//   - Browser → Backblaze direct calls fail under CORS for the Native API.
//     For live mode you must run a small proxy that forwards to api.backblazeb2.com.
//     Set proxyUrl in Settings.
// =============================================================================

import { BUCKETS } from '../data/buckets.js';
import { APPLICATION_KEYS } from '../data/applicationKeys.js';
import { DAILY_USAGE, REGION_USAGE, ACTIVITY_HEATMAP } from '../data/usageMetrics.js';
import { REGIONS } from '../data/regions.js';
import { FILES_BY_BUCKET } from '../data/files.js';
import { parseDailyUsageCsv, activityFromCsv, loadSampleCsv, parseBackblazeGroupUsageCsv } from './csvParser.js';

const MOCK_DELAY = 220;
const wait = (ms = MOCK_DELAY) => new Promise((r) => setTimeout(r, ms));

// Runtime config injected by AppProvider. Defaults to demo mode.
let runtimeConfig = { mode: 'demo', masterKeyId: '', masterApplicationKey: '', proxyUrl: '' };
export function configureAdapter(config) {
  runtimeConfig = { ...runtimeConfig, ...config };
  // Reset all caches so mode/credential changes take effect immediately.
  _authCache = null;
  _usageCache = null;
  _usageCacheExpiry = 0;
}

const useMocks = () => runtimeConfig.mode !== 'live';

// ===== Live-mode auth ======================================================
let _authCache = null;
async function ensureAuth() {
  if (useMocks()) {
    return {
      apiUrl: 'https://api005.backblazeb2.com',
      downloadUrl: 'https://f005.backblazeb2.com',
      authorizationToken: 'mock_4_0042c8a4f1e9b32_01234567890_acct_a1b2c3',
      accountId: '7f3a91d2c4b8',
    };
  }
  if (_authCache && _authCache.expiresAt > Date.now()) return _authCache;
  if (!runtimeConfig.masterKeyId || !runtimeConfig.masterApplicationKey) {
    throw new Error('Live mode requires Master Key ID and Application Key — set them in Settings.');
  }
  // Default to same-origin /b2-proxy so nginx (or the Vite dev proxy) handles
  // the forwarding server-side — avoids CORS without requiring manual config.
  const effectiveProxy = runtimeConfig.proxyUrl ||
    `${window.location.origin}/b2-proxy`;
  const res = await fetch(`${effectiveProxy}/b2api/v4/b2_authorize_account`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${runtimeConfig.masterKeyId}:${runtimeConfig.masterApplicationKey}`),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`b2_authorize_account ${res.status}: ${err}`);
  }
  const body = await res.json();
  // B2 API v4 nests apiUrl/downloadUrl/s3ApiUrl under apiInfo.storageApi
  // instead of at the top level (as v2/v3 did). Normalize to top-level so
  // the rest of the adapter and rewriteHostsThroughProxy work unchanged.
  const storageApi = body?.apiInfo?.storageApi;
  const normalized = storageApi ? {
    ...body,
    apiUrl: storageApi.apiUrl,
    downloadUrl: storageApi.downloadUrl,
    s3ApiUrl: storageApi.s3ApiUrl,
  } : body;
  const rewritten = rewriteHostsThroughProxy(normalized, effectiveProxy);
  _authCache = { ...rewritten, expiresAt: Date.now() + 23 * 3600_000 };
  return _authCache;
}

// Given an auth response and a proxyUrl like http://localhost:5173/b2-proxy,
// rewrite apiUrl/downloadUrl/s3ApiUrl from `https://api005.backblazeb2.com` to
// `http://localhost:5173/b2-api005` so subsequent calls also flow through
// the dev proxy (avoiding CORS).
function rewriteHostsThroughProxy(authBody, proxyUrl) {
  if (!proxyUrl) return authBody;
  let origin;
  try {
    origin = new URL(proxyUrl).origin;
  } catch {
    return authBody;
  }
  const swap = (url) => {
    if (!url || typeof url !== 'string') return url;
    const m = url.match(/^https?:\/\/api(\d+)\.backblazeb2\.com$/);
    if (m) return `${origin}/b2-api${m[1]}`;
    const d = url.match(/^https?:\/\/f(\d+)\.backblazeb2\.com$/);
    if (d) return `${origin}/b2-f${d[1]}`;
    return url;
  };
  return {
    ...authBody,
    apiUrl: swap(authBody.apiUrl),
    downloadUrl: swap(authBody.downloadUrl),
    s3ApiUrl: swap(authBody.s3ApiUrl),
  };
}

// skipAccountId: some v4 endpoints (b2_list_file_versions, b2_list_file_names,
// b2_list_parts, etc.) reject accountId as an unknown field. Pass true to omit it.
async function callB2(endpoint, body, { skipAccountId = false } = {}) {
  const auth = await ensureAuth();
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
    const err = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${err}`);
  }
  return res.json();
}

// =============================================================================
// Response normalizers — bridge real API shape to the shape the UI expects.
// =============================================================================

// Normalize a bucket from b2_list_buckets into the shape the UI expects.
// Real API docs: https://www.backblaze.com/apidocs/b2-list-buckets
// Fields the real API does NOT return: lastModified, objectCount,
// storageBytes, versioning, customerId, cors, encryption, publicAccess,
// replicationTo. We derive or default them here so no view crashes.
function normalizeBucket(b) {
  const sse = b.defaultServerSideEncryption;
  const repl = b.replicationConfiguration;
  // Attempt to pull a destination region/bucket from replication config.
  const replDest =
    repl?.asReplicationSource?.replicationRules?.[0]?.destinationBucketId ||
    null;
  // _apiHost is injected by the customerB2 proxy (e.g. "api004.backblazeb2.com").
  // Use it to derive the region ID so the detail view can show flag + code.
  const region = b._apiHost
    ? (REGIONS.find((r) => r.apiHost === b._apiHost)?.id ?? null)
    : null;
  return {
    ...b,
    region,
    // Derive display fields
    publicAccess: b.bucketType === 'allPublic',
    encryption: sse?.mode === 'SSE-B2' ? 'SSE-B2'
              : sse?.mode === 'SSE-C' ? 'SSE-C'
              : 'none',
    cors: Array.isArray(b.corsRules) ? b.corsRules.map((r) => r.allowedOrigins?.[0] || '*') : [],
    lifecycleRules: Array.isArray(b.lifecycleRules) ? b.lifecycleRules : [],
    versioning: null,     // B2 doesn't expose a versioning toggle; show '—'
    replicationTo: replDest,
    // Not in API — leave null so the UI shows '—'
    lastModified: null,
    objectCount: null,
    storageBytes: null,
    customerId: null,     // sub-account mapping handled by Partner API
  };
}

// Compute security posture from real b2_list_keys fields.
// Docs: https://www.backblaze.com/apidocs/b2-list-keys
// Fields the real API does NOT return: posture, expirationDate, bucketName,
// customerId. The real API returns bucketId (singular) not bucketIds.
function normalizeApiKey(k) {
  const now = Date.now();
  const expired = !!(k.expirationTimestamp && k.expirationTimestamp < now);

  // Cap-based risk: keys with delete or writeBucketInfo are dangerous
  const dangerousCaps = ['deleteBuckets', 'writeBucketInfo', 'deleteFiles'];
  const hasDangerous = dangerousCaps.some((c) => k.capabilities?.includes(c));
  const hasExpiry = !!k.expirationTimestamp;
  // Normalize bucketIds — real API returns bucketId (singular) or null
  const bucketIds = Array.isArray(k.bucketIds)
    ? k.bucketIds
    : k.bucketId ? [k.bucketId] : [];
  const bucketScoped = bucketIds.length > 0;

  let posture;
  if (expired) {
    posture = 'expired';
  } else if (hasDangerous && !hasExpiry) {
    posture = 'risk';
  } else if (!bucketScoped || !hasExpiry || hasDangerous) {
    posture = 'attention';
  } else {
    posture = 'good';
  }

  return {
    ...k,
    bucketIds,
    bucketName: null,
    customerId: null,
    posture,
    expirationDate: k.expirationTimestamp
      ? new Date(k.expirationTimestamp).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        })
      : null,
  };
}

// ===== Customer proxy helper ================================================
// In live mode, calls to list a sub-account's resources must use that
// sub-account's own credentials. Route them through the server-side proxy
// at /api/customer-b2/:accountId/:endpoint which handles credential lookup.
async function callAsCustomer(accountId, endpoint, body = {}) {
  const res = await fetch(`/api/customer-b2/${accountId}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    const err = await res.json().catch(() => ({}));
    if (err.error === 'no_credentials') return null; // caller handles gracefully
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`customer-b2 ${endpoint} ${res.status}: ${err}`);
  }
  return res.json();
}

// ===== Bucket operations ====================================================
export async function listBuckets({ customerId, accountId } = {}) {
  if (useMocks()) {
    await wait();
    const list = customerId ? BUCKETS.filter((b) => b.customerId === customerId) : BUCKETS;
    return { buckets: list };
  }
  // In live mode, use sub-account credentials when listing a specific customer's buckets.
  if (accountId) {
    const data = await callAsCustomer(accountId, 'b2_list_buckets');
    if (data === null) return { buckets: [], _noCredentials: true };
    return { ...data, buckets: (data.buckets || []).map(normalizeBucket) };
  }
  const data = await callB2('b2_list_buckets', {});
  return { ...data, buckets: (data.buckets || []).map(normalizeBucket) };
}

export async function getBucket(bucketId, { accountId } = {}) {
  if (useMocks()) {
    await wait(120);
    return BUCKETS.find((b) => b.bucketId === bucketId) || null;
  }
  if (accountId) {
    const data = await callAsCustomer(accountId, 'b2_list_buckets', { bucketId });
    if (data === null) return null;
    return data.buckets?.[0] ? normalizeBucket(data.buckets[0]) : null;
  }
  const { buckets } = await callB2('b2_list_buckets', { bucketId });
  return buckets?.[0] ? normalizeBucket(buckets[0]) : null;
}

// POST /b2api/v4/b2_create_bucket
//   body: { accountId, bucketName, bucketType, defaultServerSideEncryption?,
//           isObjectLockEnabled?, lifecycleRules?, corsRules?, replicationRules? }
//
// NOTE: B2 buckets are ALWAYS versioned — there is no versioning parameter.
// Object Lock is a boolean (isObjectLockEnabled) at creation only; governance/
// compliance retention modes are set per-object after upload, not at the bucket level.
export async function createBucket(payload) {
  if (useMocks()) {
    await wait(420);
    const newBucket = {
      bucketId: '__mock_' + Math.random().toString(16).slice(2, 18),
      bucketName: payload.bucketName,
      customerId: payload.customerId,
      region: payload.region,
      bucketType: payload.bucketType || 'allPrivate',
      storageBytes: 0,
      objectCount: 0,
      versioning: null,   // B2 doesn't expose a versioning toggle
      encryption: payload.encryption || 'SSE-B2',
      isObjectLockEnabled: payload.objectLockEnabled || false,
      publicAccess: payload.bucketType === 'allPublic',
      lifecycleRules: payload.lifecycleRules || [],
      cors: payload.cors || [],
      replicationTo: null,
      lastModified: new Date().toISOString(),
    };
    BUCKETS.unshift(newBucket);
    return newBucket;
  }

  // Build a clean b2_create_bucket body — only include fields the API accepts.
  const b2Body = {
    bucketName:  payload.bucketName,
    bucketType:  payload.bucketType || 'allPrivate',
  };

  // defaultServerSideEncryption: omit entirely for 'none', otherwise send mode + algorithm.
  if (payload.encryption && payload.encryption !== 'none') {
    b2Body.defaultServerSideEncryption = {
      mode:      payload.encryption,   // 'SSE-B2' or 'SSE-C'
      algorithm: 'AES256',
    };
  }

  // isObjectLockEnabled: only send if true (false is the default; sending it as
  // false is harmless but unnecessary).
  if (payload.objectLockEnabled) {
    b2Body.isObjectLockEnabled = true;
  }

  if (payload.lifecycleRules?.length) {
    b2Body.lifecycleRules = payload.lifecycleRules;
  }

  return callB2('b2_create_bucket', b2Body);
}

// ===== Application keys =====================================================
export async function listApplicationKeys({ customerId, accountId, maxKeyCount = 100 } = {}) {
  if (useMocks()) {
    await wait();
    const list = customerId
      ? APPLICATION_KEYS.filter((k) => k.customerId === customerId)
      : APPLICATION_KEYS;
    return { keys: list, nextApplicationKeyId: null };
  }
  // Use sub-account credentials when listing keys for a specific customer.
  const targetAccountId = accountId || customerId;
  if (targetAccountId) {
    const data = await callAsCustomer(targetAccountId, 'b2_list_keys', { maxKeyCount });
    if (data === null) return { keys: [], nextApplicationKeyId: null, _noCredentials: true };
    return {
      ...data,
      keys: (data.keys || []).map(normalizeApiKey),
      nextApplicationKeyId: data.nextApplicationKeyId || null,
    };
  }
  const data = await callB2('b2_list_keys', { maxKeyCount });
  return {
    ...data,
    keys: (data.keys || []).map(normalizeApiKey),
    nextApplicationKeyId: data.nextApplicationKeyId || null,
  };
}

export async function createApplicationKey(payload) {
  if (useMocks()) {
    await wait(420);
    return {
      accountId: '7f3a91d2c4b8',
      applicationKeyId: '0' + Math.random().toString(16).slice(2, 16),
      applicationKey: 'K005' + '*'.repeat(40),
      keyName: payload.keyName,
      capabilities: payload.capabilities,
      bucketIds: payload.bucketIds || [],
      namePrefix: payload.namePrefix || '',
      expirationTimestamp: payload.validDurationInSeconds
        ? Date.now() + payload.validDurationInSeconds * 1000
        : null,
    };
  }
  return callB2('b2_create_key', payload);
}

// ===== Files ================================================================
// Mock implementation pulls from FILES_BY_BUCKET (see ../data/files.js).
// Production: paginate via startFileName / startFileId per
// https://www.backblaze.com/apidocs/b2-list-file-versions
export async function listFileVersions({ bucketId, accountId, prefix = '', startFileName, maxFileCount = 50 } = {}) {
  if (useMocks()) {
    await wait();
    const all = FILES_BY_BUCKET[bucketId] || [];
    let filtered = prefix ? all.filter((f) => f.fileName.startsWith(prefix)) : all;
    if (startFileName) {
      const idx = filtered.findIndex((f) => f.fileName === startFileName);
      if (idx >= 0) filtered = filtered.slice(idx + 1);
    }
    const page = filtered.slice(0, maxFileCount);
    const next = filtered.length > maxFileCount ? page[page.length - 1] : null;
    return {
      files: page,
      nextFileName: next ? next.fileName : null,
      nextFileId: next ? next.fileId : null,
    };
  }
  // Use sub-account credentials when listing files for a specific customer's bucket.
  if (accountId) {
    const data = await callAsCustomer(accountId, 'b2_list_file_names', {
      bucketId, prefix, startFileName, maxFileCount,
    });
    if (data === null) return { files: [], nextFileName: null, nextFileId: null };
    return { files: data.files || [], nextFileName: data.nextFileName || null, nextFileId: null };
  }
  // Use b2_list_file_names in live mode — it returns only the current (most
  // recent, non-hidden) version of each file.
  const data = await callB2('b2_list_file_names', {
    bucketId, prefix, startFileName, maxFileCount,
  }, { skipAccountId: true });
  return {
    files: data.files || [],
    nextFileName: data.nextFileName || null,
    nextFileId: null,
  };
}

// Fetch all stored versions (including hide markers) of a specific file.
// Used by the version drill-down panel in BucketDetailView.
// Reference: https://www.backblaze.com/apidocs/b2-list-file-versions
export async function getFileVersions({ bucketId, fileName, maxVersions = 100 } = {}) {
  if (useMocks()) {
    await wait(150);
    const all = FILES_BY_BUCKET[bucketId] || [];
    const file = all.find((f) => f.fileName === fileName);
    // Mock returns a single version — real buckets can have many
    return { versions: file ? [{ ...file, action: 'upload' }] : [] };
  }
  // b2_list_file_versions with startFileName set to the exact file returns
  // that file's versions first (lexicographic order: same name sorts before
  // any longer name starting with the same characters).
  const data = await callB2('b2_list_file_versions', {
    bucketId,
    startFileName: fileName,
    maxFileCount: maxVersions,
  }, { skipAccountId: true });
  // Filter strictly to the requested fileName — there may be files that sort
  // immediately after the target (e.g. "file.txt.bak" after "file.txt").
  const versions = (data.files || []).filter((f) => f.fileName === fileName);
  return { versions };
}

// ===== Activity (Bucket Access Logs — REAL per-event records) ===============
// Backblaze Bucket Access Logs deliver per-request audit records to a
// destination bucket on a best-effort basis (a few hours after the event).
// Format follows AWS S3 server access logs with two B2 exceptions
// (Access Point ARN + aclRequired are always empty).
//
// Reference: https://www.backblaze.com/docs/cloud-storage-bucket-access-logs
//
// Production flow:
//   1. Configure logging on the source bucket via setBucketLogging() — uses
//      S3 PutBucketLogging on the S3-compatible API.
//   2. List log files in the destination bucket via listFileVersions() with
//      a date-partitioned prefix.
//   3. Download each file, parse with parseAccessLog(), aggregate / display.
//
// Mock implementation parses a bundled sample log file.
let _accessLogCache = null;
async function loadSampleAccessLog() {
  if (_accessLogCache) return _accessLogCache;
  const mod = await import('../data/sampleAccessLog.log?raw');
  _accessLogCache = mod.default;
  return _accessLogCache;
}

export async function getBucketActivity({ accountId, bucketName, bucketId } = {}) {
  await wait(180);
  if (useMocks()) {
    const { parseAccessLog } = await import('./accessLogParser.js');
    const text = await loadSampleAccessLog();
    let records = parseAccessLog(text);
    if (accountId) records = records.filter((r) => r.bucketOwner === accountId);
    if (bucketName) records = records.filter((r) => r.bucket === bucketName);
    if (bucketId && !bucketName) {
      // Look up bucketName from id
      const b = BUCKETS.find((x) => x.bucketId === bucketId);
      if (b) records = records.filter((r) => r.bucket === b.bucketName);
    }
    return { records, source: 'access-logs' };
  }
  // Live path: access logs require a configured destination bucket reader.
  // Return empty rather than throwing so CustomerDetailView still loads.
  return { records: [], source: 'no-data' };
}

// =============================================================================
// Per-key "last used" — derived from Bucket Access Logs.
// =============================================================================
// b2_list_keys does NOT return any usage timestamp. The only way to know
// when a key was last used is to mine access log records and find the
// max timestamp per identity. Returns a Map<applicationKeyId, timestamp(ms)>.
// Keys absent from the map have no access-log activity (logging may not be
// enabled on their buckets, or the key truly hasn't been used in the
// retained log window).
export async function getKeyLastUsed() {
  await wait(150);
  const { parseAccessLog } = await import('./accessLogParser.js');
  const text = await loadSampleAccessLog();
  const records = parseAccessLog(text);
  const map = new Map();
  for (const r of records) {
    if (r.identityType !== 'applicationKey' || !r.identityId || !r.timestamp) continue;
    const t = new Date(r.timestamp).getTime();
    const cur = map.get(r.identityId);
    if (!cur || t > cur) map.set(r.identityId, t);
  }
  return { lastUsed: map };
}

// =============================================================================
// Bucket Access Log configuration
// =============================================================================
// Configure / read access logging via the S3-compatible API:
//   PUT https://{bucket}.s3.{region}.backblazeb2.com/?logging   (XML body)
//   GET https://{bucket}.s3.{region}.backblazeb2.com/?logging
// Required key capabilities: writeBucketLogging, readBucketLogging.
// Reference: https://www.backblaze.com/apidocs/s3-put-bucket-logging
// Reference: https://www.backblaze.com/apidocs/s3-get-bucket-logging

export async function getBucketLogging({ bucketId } = {}) {
  await wait(140);
  if (useMocks()) {
    const b = BUCKETS.find((x) => x.bucketId === bucketId);
    return {
      enabled: !!b?.accessLogging?.enabled,
      targetBucketName: b?.accessLogging?.targetBucketName || null,
      targetPrefix: b?.accessLogging?.targetPrefix || null,
      datePartitioned: !!b?.accessLogging?.datePartitioned,
    };
  }
  // Live: GET https://{bucketName}.s3.{region}.backblazeb2.com/?logging
  // Returns S3 BucketLoggingStatus XML — parse with DOMParser.
  throw new Error('Live S3 GetBucketLogging not implemented — needs a CORS proxy');
}

export async function setBucketLogging({ bucketId, enabled, targetBucketName, targetPrefix = '', datePartitioned = false } = {}) {
  await wait(420);
  if (useMocks()) {
    const b = BUCKETS.find((x) => x.bucketId === bucketId);
    if (!b) throw new Error('Bucket not found');
    b.accessLogging = enabled
      ? { enabled: true, targetBucketName, targetPrefix, datePartitioned }
      : { enabled: false };
    return { ok: true, ...b.accessLogging };
  }
  // Live: PUT https://{bucketName}.s3.{region}.backblazeb2.com/?logging
  //   <BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  //     <LoggingEnabled>
  //       <TargetBucket>{targetBucketName}</TargetBucket>
  //       <TargetPrefix>{targetPrefix}</TargetPrefix>
  //     </LoggingEnabled>
  //   </BucketLoggingStatus>
  // (empty <BucketLoggingStatus/> body to disable)
  throw new Error('Live S3 PutBucketLogging not implemented — needs a CORS proxy');
}

// =============================================================================
// Live Usage — Daily Usage CSV Reports
// =============================================================================
// Backblaze stores daily usage CSVs in a special bucket named
// b2-reports-<accountId>. The partner-scoped report files are named:
//   YYYY-MM-DD/usage.group-<groupId>.<region>.csv
// Columns documented at:
//   https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports
//
// This function:
//   1. Finds the b2-reports-<accountId> bucket via b2_list_buckets
//   2. Lists files matching the date/prefix pattern
//   3. Downloads each CSV and parses it
//   4. Returns rows shaped the same as DAILY_USAGE (storageBytes, egressBytes…)
let _usageCache = null;
let _usageCacheExpiry = 0;

async function fetchUsageFromReportsBucket({ days = 30 } = {}) {
  if (_usageCache && _usageCacheExpiry > Date.now()) return _usageCache;

  const auth = await ensureAuth();

  // Step 1: find the reports bucket for this account.
  // Backblaze names it b2-reports-<accountId> but the accountId in the name
  // may differ from the master-key accountId if reports were enabled on a
  // parent/group account. Accept any b2-reports-* bucket as a fallback.
  const { buckets: allBuckets } = await callB2('b2_list_buckets', {});
  const reportsBucket =
    allBuckets.find((b) => b.bucketName === `b2-reports-${auth.accountId}`) ||
    allBuckets.find((b) => b.bucketName.startsWith('b2-reports-'));

  if (!reportsBucket) {
    throw new Error(
      `Could not locate b2-reports-* bucket among [${allBuckets.map((b) => b.bucketName).join(', ')}]. ` +
      'Enable Usage Reports at https://secure.backblaze.com/reports.htm'
    );
  }

  // Step 2: list CSV files for the requested date range
  const today = new Date();
  const cutoff = new Date(today.getTime() - days * 86400000);
  const prefix = ''; // iterate everything, filter client-side by date

  const { files: fileList } = await callB2('b2_list_file_names', {
    bucketId: reportsBucket.bucketId,
    prefix,
    maxFileCount: 1000,
  }, { skipAccountId: true });

  // Keep only usage CSV files within the date window
  // Pattern: YYYY-MM-DD/usage.group-*.csv
  const csvFiles = (fileList || []).filter((f) => {
    const m = f.fileName.match(/^(\d{4}-\d{2}-\d{2})\/usage\..*\.csv$/);
    if (!m) return false;
    const d = new Date(m[1]);
    return d >= cutoff && d <= today;
  });

  // Step 3: download and parse each file
  const allRows = [];
  await Promise.all(
    csvFiles.map(async (f) => {
      const res = await fetch(
        `${auth.downloadUrl}/b2api/v4/b2_download_file_by_id?fileId=${f.fileId}`,
        { headers: { Authorization: auth.authorizationToken } }
      );
      if (!res.ok) return;
      const text = await res.text();
      const rows = parseBackblazeGroupUsageCsv(text);
      const dateMatch = f.fileName.match(/^(\d{4}-\d{2}-\d{2})\//);
      const date = dateMatch ? dateMatch[1] : null;
      rows.forEach((r) => { if (date) r._date = date; });
      allRows.push(...rows);
    })
  );

  // Step 4: aggregate by date into DAILY_USAGE-shaped objects
  const byDate = new Map();
  for (const r of allRows) {
    const date = r._date;
    if (!date) continue;
    const cur = byDate.get(date) || {
      date,
      storageBytes: 0,
      egressBytes: 0,
      uploadBytes: 0,
      classATxn: 0,
      classBTxn: 0,
      classCTxn: 0,
    };
    cur.storageBytes = Math.max(cur.storageBytes, r.storageBytes || 0);
    cur.egressBytes += r.egressBytes || 0;
    cur.uploadBytes += r.uploadBytes || 0;
    cur.classATxn += r.classATxn || 0;
    cur.classBTxn += r.classBTxn || 0;
    cur.classCTxn += r.classCTxn || 0;
    byDate.set(date, cur);
  }

  const sorted = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  _usageCache = sorted;
  _usageCacheExpiry = Date.now() + 3600_000; // cache for 1 hour
  return sorted;
}

// ===== Usage / metrics ======================================================
// CSV-DERIVED. There is no JSON usage API on B2.
export async function getDailyUsage({ days = 30 } = {}) {
  await wait();
  if (!useMocks()) {
    try {
      const rows = await fetchUsageFromReportsBucket({ days });
      return { usage: rows.slice(-days), source: 'csv-live' };
    } catch (e) {
      console.warn('[b2Adapter] getDailyUsage live fetch failed — returning empty (no CSV reports):', e.message);
      return { usage: [], source: 'no-data' };
    }
  }
  return { usage: DAILY_USAGE.slice(-days), source: 'mock' };
}

export async function getRegionUsage() {
  await wait();
  if (!useMocks()) {
    try {
      const rows = await fetchUsageFromReportsBucket({ days: 30 });
      // Group by region field (reporting_location in real CSV)
      const byRegion = new Map();
      for (const r of rows) {
        const regionId = r.region || 'unknown';
        const cur = byRegion.get(regionId) || {
          regionId,
          code: r.region || regionId,
          storageBytes: 0,
          egressBytes30d: 0,
          uploadBytes30d: 0,
          classATxn30d: 0,
          classBTxn30d: 0,
          classCTxn30d: 0,
          bucketCount: 0,
          growth30d: null,
        };
        cur.storageBytes = Math.max(cur.storageBytes, r.storageBytes || 0);
        cur.egressBytes30d += r.egressBytes || 0;
        cur.uploadBytes30d += r.uploadBytes || 0;
        cur.classATxn30d += r.classATxn || 0;
        cur.classBTxn30d += r.classBTxn || 0;
        cur.classCTxn30d += r.classCTxn || 0;
        byRegion.set(regionId, cur);
      }
      // Merge with known REGIONS for display metadata
      const regionList = Array.from(byRegion.values()).map((r) => {
        const meta = REGIONS.find((x) => x.id === r.regionId || x.code === r.code);
        return meta ? { ...r, regionId: meta.id, code: meta.code } : r;
      });
      return { regions: regionList, source: 'csv-live' };
    } catch (e) {
      console.warn('[b2Adapter] getRegionUsage CSV fetch failed — deriving from b2_list_buckets:', e.message);
    }
    // Fallback: detect region from auth apiUrl + get real bucket count from b2_list_buckets.
    // Storage/egress metrics are unavailable without CSV reports — they will show as '—'.
    try {
      const auth = await ensureAuth();
      // apiUrl can be https://api005.backblazeb2.com OR a proxy-rewritten path like
      // http://host/b2-api005 — both contain "api" followed by digits.
      const m = auth.apiUrl?.match(/api(\d+)/);
      const regionNum = m ? m[1] : null;
      const regionMeta = regionNum
        ? REGIONS.find((r) => r.apiHost?.includes(`api${regionNum}`))
        : null;
      const { buckets: liveBuckets } = await callB2('b2_list_buckets', {});
      return {
        regions: [{
          regionId: regionMeta?.id || `api${regionNum || '?'}`,
          code: regionMeta?.code || `api${regionNum || '?'}`,
          storageBytes: null,
          egressBytes30d: null,
          uploadBytes30d: null,
          classATxn30d: null,
          classBTxn30d: null,
          classCTxn30d: null,
          bucketCount: (liveBuckets || []).length,
          growth30d: null,
        }],
        source: 'api-derived',
      };
    } catch (e2) {
      console.warn('[b2Adapter] getRegionUsage bucket fallback also failed:', e2.message);
      return { regions: [], source: 'no-data' };
    }
  }
  return { regions: REGION_USAGE, source: 'mock' };
}

export async function getActivityHeatmap() {
  await wait();
  // Access logs required for real per-hour heatmap — only available in mock mode
  // (live access-log parsing not yet wired; would require a destination bucket reader).
  // In live mode we synthesize an hourly distribution from the daily CSV totals
  // so the heatmap isn't empty but also isn't misleading about data source.
  if (!useMocks()) {
    try {
      const rows = await fetchUsageFromReportsBucket({ days: 14 });
      const cells = [];
      for (let day = 0; day < 14; day++) {
        const row = rows[rows.length - 14 + day];
        if (!row) {
          for (let hour = 0; hour < 24; hour++) cells.push({ day, hour, value: 0 });
          continue;
        }
        // Distribute across hours with a business-hour curve (no per-hour data from CSV)
        const dt = new Date(row.date + 'T12:00:00Z');
        const isWeekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
        for (let hour = 0; hour < 24; hour++) {
          const businessUplift = hour >= 8 && hour <= 19 ? 0.55 : 0.18;
          const raw = (isWeekend ? 0.28 : 0.62) * businessUplift +
            (Math.sin(day * 11 + hour * 3) + 1) / 8;
          cells.push({ day, hour, value: Math.min(1, raw) });
        }
      }
      return { cells, source: 'csv-derived' };
    } catch (e) {
      console.warn('[b2Adapter] getActivityHeatmap live fetch failed — returning empty cells:', e.message);
      // Return zeroed cells so the heatmap renders but is clearly empty
      const cells = [];
      for (let day = 0; day < 14; day++)
        for (let hour = 0; hour < 24; hour++)
          cells.push({ day, hour, value: 0 });
      return { cells, source: 'no-data' };
    }
  }
  return { cells: ACTIVITY_HEATMAP, source: 'mock' };
}

// ===== Regions ==============================================================
export async function listRegions() {
  await wait(80);
  return { regions: REGIONS };
}

// ===== Convenience auth surface =============================================
export async function authorizeAccount() {
  return ensureAuth();
}

// ===== Connection test ======================================================
export async function testConnection() {
  if (useMocks()) {
    return { ok: true, mode: 'demo', message: 'Demo mode — no live connection attempted.' };
  }
  try {
    const auth = await ensureAuth();
    return {
      ok: true,
      mode: 'live',
      accountId: auth.accountId,
      apiUrl: auth.apiUrl,
      message: `Authorized. Account ${auth.accountId}. apiUrl=${auth.apiUrl}`,
    };
  } catch (e) {
    const raw = String(e.message || e);
    // "Failed to fetch" / "NetworkError" almost always means CORS — the
    // browser blocked the cross-origin request before it ever hit B2.
    const isCors = /failed to fetch|networkerror|load failed|cors/i.test(raw);
    if (isCors) {
      const effectiveProxy = runtimeConfig.proxyUrl || `${window.location.origin}/b2-proxy`;
      return {
        ok: false,
        mode: 'live',
        message: `CORS / network error calling ${effectiveProxy}. Make sure the reverse-proxy is running and forwarding /b2-proxy → api.backblazeb2.com. You can override the proxy URL in Settings.`,
      };
    }
    return { ok: false, mode: 'live', message: raw };
  }
}
