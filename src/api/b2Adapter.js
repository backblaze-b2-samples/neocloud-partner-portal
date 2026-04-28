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
import { parseDailyUsageCsv, activityFromCsv, loadSampleCsv } from './csvParser.js';

const MOCK_DELAY = 220;
const wait = (ms = MOCK_DELAY) => new Promise((r) => setTimeout(r, ms));

// Runtime config injected by AppProvider. Defaults to demo mode.
let runtimeConfig = { mode: 'demo', masterKeyId: '', masterApplicationKey: '', proxyUrl: '' };
export function configureAdapter(config) {
  runtimeConfig = { ...runtimeConfig, ...config };
  // Reset cached auth when creds change so the next call re-authorizes.
  _authCache = null;
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
  const base = runtimeConfig.proxyUrl || 'https://api.backblazeb2.com';
  const res = await fetch(`${base}/b2api/v4/b2_authorize_account`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${runtimeConfig.masterKeyId}:${runtimeConfig.masterApplicationKey}`),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`b2_authorize_account ${res.status}: ${err}`);
  }
  const body = await res.json();
  // Rewrite region-specific apiUrl / downloadUrl through our proxy origin if
  // the user set one. The bundled Vite dev proxy declares /b2-api00[2-9]
  // routes that forward to the corresponding api00X.backblazeb2.com host.
  const rewritten = rewriteHostsThroughProxy(body, runtimeConfig.proxyUrl);
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

async function callB2(endpoint, body) {
  const auth = await ensureAuth();
  const res = await fetch(`${auth.apiUrl}/b2api/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ accountId: auth.accountId, ...body }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${err}`);
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
  const body = accountId ? { accountId } : {};
  return callB2('b2_list_buckets', body);
}

export async function getBucket(bucketId) {
  if (useMocks()) {
    await wait(120);
    return BUCKETS.find((b) => b.bucketId === bucketId) || null;
  }
  const { buckets } = await callB2('b2_list_buckets', { bucketId });
  return buckets[0] || null;
}

// POST /b2api/v4/b2_create_bucket
//   body: { accountId, bucketName, bucketType, bucketInfo?, lifecycleRules?, defaultServerSideEncryption? }
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
      versioning: payload.versioning || 'disabled',
      encryption: payload.encryption || 'SSE-B2',
      fileLock: payload.fileLock || 'none',
      publicAccess: payload.bucketType === 'allPublic',
      lifecycleRules: payload.lifecycleRules || [],
      cors: payload.cors || [],
      replicationTo: null,
      lastModified: new Date().toISOString(),
    };
    BUCKETS.unshift(newBucket);
    return newBucket;
  }
  return callB2('b2_create_bucket', payload);
}

// ===== Application keys =====================================================
export async function listApplicationKeys({ customerId, maxKeyCount = 100 } = {}) {
  if (useMocks()) {
    await wait();
    const list = customerId
      ? APPLICATION_KEYS.filter((k) => k.customerId === customerId)
      : APPLICATION_KEYS;
    return { keys: list, nextApplicationKeyId: null };
  }
  return callB2('b2_list_keys', { maxKeyCount });
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
export async function listFileVersions({ bucketId, prefix = '', startFileName, maxFileCount = 50 } = {}) {
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
  return callB2('b2_list_file_versions', { bucketId, prefix, startFileName, maxFileCount });
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
  // Live path: list + fetch log files from the destination bucket.
  // Requires a backend proxy because of CORS — outline only:
  //   1. listFileVersions({ bucketId: destBucketId, prefix: <date prefix> })
  //   2. for each file: GET via downloadUrl with auth token, then parseAccessLog()
  throw new Error('Live access-log fetch not implemented — wire your destination-bucket reader here');
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

// ===== Usage / metrics ======================================================
// CSV-DERIVED. There is no JSON usage API on B2.
export async function getDailyUsage({ days = 30 } = {}) {
  await wait();
  return { usage: DAILY_USAGE.slice(-days) };
}

export async function getRegionUsage() {
  await wait();
  return { regions: REGION_USAGE };
}

export async function getActivityHeatmap() {
  await wait();
  return { cells: ACTIVITY_HEATMAP };
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
      const hasProxy = !!runtimeConfig.proxyUrl;
      const hint = hasProxy
        ? `CORS / network error talking to ${runtimeConfig.proxyUrl}. Check the proxy is running and forwards to https://api.backblazeb2.com.`
        : 'No CORS proxy is configured. Backblaze\'s Native API does not send CORS headers, so direct browser → B2 calls fail. Set "CORS proxy URL" in Settings to http://localhost:5173/b2-proxy (provided by the bundled Vite dev proxy) and try again.';
      return { ok: false, mode: 'live', message: hint };
    }
    return { ok: false, mode: 'live', message: raw };
  }
}
