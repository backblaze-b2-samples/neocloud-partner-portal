// =============================================================================
// /api/customer-b2 — server-side B2 proxy for per-customer sub-account calls.
//
// The master key can only see its own buckets/keys. To list a sub-account's
// resources you must authenticate AS that sub-account. This route:
//   1. Looks up the stored (encrypted) credentials for the requested accountId
//   2. Calls b2_authorize_account with those credentials (result cached 1 hour)
//   3. Forwards the requested B2 Native API call using the sub-account token
//   4. Returns the B2 response verbatim
//
// POST /api/customer-b2/:accountId/:endpoint
//   Requires: valid session (requireAuth)
//   Body: JSON forwarded to B2 (accountId injected automatically)
//   Returns: JSON from B2
//
// Endpoint allowlist prevents this from becoming a general B2 relay.
// =============================================================================

import express from 'express';
import { createHmac, createHash } from 'crypto';
import { Readable } from 'node:stream';
import { requireAuth, requireNotDemo, requireCsrf, canAccessAccount } from '../middleware/requireAuth.js';
import { getCredential, getDecryptedApplicationKey } from '../credentials.js';
import { audit } from '../audit.js';
import { traceCollector } from '../lib/apiTrace.js';
import { REGIONS } from '../../src/data/regions.js';

// B2 bucket name rules: 6–63 chars, lowercase a-z, 0-9, hyphen, no leading/trailing
// hyphen, no consecutive hyphens (the spec also forbids names starting with "b2-",
// but those are valid Backblaze system buckets and may legitimately appear here).
const BUCKET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])$/;
const ALLOWED_REGIONS = new Set(REGIONS.map((r) => r.id));

function rejectInvalidAccountAccess(req, res) {
  if (canAccessAccount(req.session.user, req.params.accountId)) return null;
  audit({
    actorId: req.session.user.id,
    action:  'authz.denied',
    details: { route: 'customer-b2', accountId: req.params.accountId, method: req.method },
    ip:      req.ip,
  });
  res.status(403).json({ error: 'Forbidden — accountId does not belong to this user' });
  return true;
}

// =============================================================================
// Minimal AWS SigV4 signer — used for B2 S3-compatible API calls.
// Backblaze S3 endpoints accept the B2 application_key_id / application_key
// as S3 Access Key ID / Secret Access Key for Signature V4 signing.
// =============================================================================
function sha256hex(data) {
  return createHash('sha256').update(data || '').digest('hex');
}
function hmacSha256(key, data, enc) {
  return createHmac('sha256', key).update(data).digest(enc || null);
}

/**
 * Build Authorization + x-amz-* headers for an S3-compatible request.
 *
 * @param {string} method    HTTP method (GET, PUT, …)
 * @param {string} host      Virtual-hosted host, e.g. "my-bucket.s3.us-west-002.backblazeb2.com"
 * @param {string} path      URL path without query string, e.g. "/"
 * @param {string} query     Query string WITHOUT leading "?", e.g. "logging"
 * @param {string} region    B2 region id, e.g. "us-west-002"
 * @param {string} keyId     application_key_id (S3 access key)
 * @param {string} secret    application_key   (S3 secret key)
 * @param {string} [body]    Request body (empty string for GET)
 * @param {object} [opts]    { payloadHash, contentType } — payloadHash overrides
 *                           the body hash (use 'UNSIGNED-PAYLOAD' for streamed
 *                           uploads); contentType sets a non-XML Content-Type.
 */
function s3AuthHeaders(method, host, path, query, region, keyId, secret, body = '', opts = {}) {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');           // YYYYMMDD
  const amzDate  = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z'); // YYYYMMDDTHHmmssZ
  const payloadHash = opts.payloadHash || sha256hex(body);

  const canonHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n') + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonRequest = [method, path, query, canonHeaders, signedHeaders, payloadHash].join('\n');

  const credScope  = `${dateStamp}/${region}/s3/aws4_request`;
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256hex(canonRequest)].join('\n');

  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256('AWS4' + secret, dateStamp), region), 's3'),
    'aws4_request',
  );
  const signature  = hmacSha256(signingKey, strToSign, 'hex');

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(opts.contentType ? { 'Content-Type': opts.contentType } : (body ? { 'Content-Type': 'application/xml' } : {})),
  };
}

/**
 * Parse the XML body returned by S3 GetBucketLogging into a plain object.
 * Returns { enabled, targetBucket, targetPrefix }.
 */
function parseLoggingXml(xml) {
  const enabled = xml.includes('<LoggingEnabled>');
  const targetBucket = xml.match(/<TargetBucket>(.*?)<\/TargetBucket>/s)?.[1]?.trim() || null;
  const targetPrefix = xml.match(/<TargetPrefix>(.*?)<\/TargetPrefix>/s)?.[1]?.trim() || '';
  return { enabled, targetBucket, targetPrefix };
}

/**
 * Build the XML body for S3 PutBucketLogging.
 * Pass enabled=false to disable (sends empty BucketLoggingStatus).
 */
function buildLoggingXml(enabled, targetBucket, targetPrefix = '') {
  if (!enabled) return '<BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>';
  return `<BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <LoggingEnabled>
    <TargetBucket>${targetBucket}</TargetBucket>
    <TargetPrefix>${targetPrefix}</TargetPrefix>
  </LoggingEnabled>
</BucketLoggingStatus>`;
}

const router = express.Router();
router.use(requireAuth, requireNotDemo);

const ALLOWED_ENDPOINTS = new Set([
  // reads
  'b2_list_buckets',
  'b2_list_keys',
  'b2_list_file_names',
  'b2_list_file_versions',
  'b2_get_file_info',
  // writes (gated to customer_admin / partner staff by requireCustomerWrite)
  'b2_create_bucket',
  'b2_update_bucket',
  'b2_delete_bucket',
  'b2_create_key',
  'b2_delete_key',
  'b2_delete_file_version',
  'b2_hide_file',
]);

// State-changing endpoints: audited, and require write access (a
// customer_readonly user can read but never mutate — see requireCustomerWrite).
const MUTATING = new Set([
  'b2_create_bucket',
  'b2_update_bucket',
  'b2_delete_bucket',
  'b2_create_key',
  'b2_delete_key',
  'b2_delete_file_version',
  'b2_hide_file',
]);

// Write access = partner staff (accountId null) OR customer_admin.
// customer_readonly is explicitly excluded.
function canWrite(user) {
  return !!user && (!user.accountId || user.role === 'customer_admin');
}

// Endpoints that are semantically reads even though B2's API uses POST.
// During read-only impersonation these must still work so the staff agent
// can see the customer's data.
const READ_ENDPOINTS = new Set([
  'b2_list_buckets',
  'b2_list_keys',
  'b2_list_file_names',
  'b2_list_file_versions',
  'b2_get_file_info',
]);

// Pre-CSRF middleware: flag reads so requireCsrf's impersonation gate lets
// them through.
function allowReadDuringImpersonation(req, _res, next) {
  if (READ_ENDPOINTS.has(req.params.endpoint)) req.allowDuringImpersonation = true;
  next();
}

// Auth token cache: accountId → { token, apiUrl, expiresAt }
const _authCache = new Map();

async function getSubAccountAuth(accountId) {
  const cached = _authCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const cred = getCredential(accountId);
  if (!cred) throw new Error(`No stored credentials for accountId ${accountId}`);

  const applicationKey = getDecryptedApplicationKey(accountId);
  if (!applicationKey) throw new Error(`Could not decrypt key for accountId ${accountId}`);

  const basic = Buffer.from(`${cred.application_key_id}:${applicationKey}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`b2_authorize_account for ${accountId} failed ${res.status}: ${err}`);
  }

  const body = await res.json();
  const storageApi = body?.apiInfo?.storageApi;
  const apiUrl = storageApi?.apiUrl || body.apiUrl;
  const authorizationToken = body.authorizationToken;
  const entry = { token: authorizationToken, apiUrl, accountId: body.accountId, expiresAt: Date.now() + 3600_000 };
  _authCache.set(accountId, entry);
  return entry;
}

router.post('/:accountId/:endpoint', allowReadDuringImpersonation, requireCsrf, async (req, res, next) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId, endpoint } = req.params;

  // s3_logging is a single path segment, so it matches this generic route, but
  // it's served by its own handler below (an S3 PutBucketLogging call, not a
  // b2_ native endpoint). Hand off rather than reject it as "not allowed".
  if (endpoint === 's3_logging') return next();

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: `Endpoint '${endpoint}' not allowed via customer proxy.` });
  }

  // Read-only customers may list/read but never mutate.
  if (MUTATING.has(endpoint) && !canWrite(req.session.user)) {
    audit({
      actorId: req.session.user.id,
      action:  'authz.denied',
      details: { route: 'customer-b2', accountId, endpoint, reason: 'read_only' },
      ip:      req.ip,
    });
    return res.status(403).json({ error: 'read_only', message: 'Read-only access — bucket, file, and key changes require an account admin.' });
  }

  let auth;
  try {
    auth = await getSubAccountAuth(accountId);
  } catch (err) {
    // No credentials stored for this customer yet
    if (err.message.includes('No stored credentials')) {
      return res.status(404).json({ error: 'no_credentials', message: err.message });
    }
    console.error(`[customerB2] auth failed for ${accountId}:`, err.message);
    return res.status(502).json({ error: err.message });
  }

  const targetUrl = `${auth.apiUrl}/b2api/v4/${endpoint}`;
  // Only inject accountId for endpoints that require it; file-listing endpoints don't accept it.
  const NEEDS_ACCOUNT_ID = new Set(['b2_list_buckets', 'b2_list_keys', 'b2_create_bucket', 'b2_create_key', 'b2_update_bucket', 'b2_delete_bucket']);
  const body = NEEDS_ACCOUNT_ID.has(endpoint)
    ? { accountId: auth.accountId, ...req.body }
    : { ...req.body };

  const trace = traceCollector(req);
  try {
    const t0 = Date.now();
    const b2Res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: auth.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await b2Res.text();
    let parsedForTrace;
    try { parsedForTrace = JSON.parse(text); } catch { /* non-JSON */ }
    trace.add({
      label: endpoint, method: 'POST', url: targetUrl,
      requestHeaders: { Authorization: auth.token, 'Content-Type': 'application/json' },
      requestBody: body, status: b2Res.status, durationMs: Date.now() - t0,
      responseBody: b2Res.ok ? parsedForTrace : undefined,
      error: b2Res.ok ? undefined : text,
    });

    // Audit mutating endpoints (the MUTATING set is module-level). Read-only
    // listings fire on every page load and would flood the table.
    if (b2Res.ok && MUTATING.has(endpoint)) {
      audit({
        actorId: req.session.user.id,
        action:  `customer_b2.${endpoint}`,
        details: {
          accountId,
          bucketName: req.body?.bucketName ?? null,
          bucketId: req.body?.bucketId ?? null,
          applicationKeyId: req.body?.applicationKeyId ?? null,
          keyName: req.body?.keyName ?? null,
          fileName: req.body?.fileName ?? null,
          fileId: req.body?.fileId ?? null,
        },
        ip:      req.ip,
      });
    }

    // For bucket-shaped responses, inject _apiHost so the client can derive
    // region. The sub-account's apiUrl encodes the region (api003=eu-central,
    // api004=us-west, api005=us-east, api006=ca-east). b2_list_buckets returns
    // { buckets: [...] }; b2_create_bucket returns a single bucket object.
    if ((endpoint === 'b2_list_buckets' || endpoint === 'b2_create_bucket') && b2Res.ok) {
      try {
        const parsed = JSON.parse(text);
        const m = auth.apiUrl?.match(/api(\d+)\.backblazeb2\.com/);
        const apiHost = m ? `api${m[1]}.backblazeb2.com` : null;
        if (apiHost) {
          if (Array.isArray(parsed.buckets)) {
            parsed.buckets = parsed.buckets.map((b) => ({ ...b, _apiHost: apiHost }));
          } else if (parsed.bucketId) {
            parsed._apiHost = apiHost;
          }
        }
        return res.status(b2Res.status).json(trace.decorate(parsed));
      } catch (_) { /* fall through to raw send */ }
    }

    // When training mode asked for the underlying calls, return JSON (with the
    // _apiCalls array) instead of the raw passthrough text.
    if (trace.on && parsedForTrace !== undefined) {
      return res.status(b2Res.status).json(trace.decorate(parsedForTrace));
    }
    res.status(b2Res.status).set('Content-Type', 'application/json').send(text);
  } catch (err) {
    console.error(`[customerB2] fetch failed for ${accountId}/${endpoint}:`, err.message);
    res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
});

// =============================================================================
// S3 Bucket Logging — GET / PUT
// These call the S3-compatible API (not the B2 native API) using SigV4.
// Route: /api/customer-b2/:accountId/s3_logging
//   GET  ?bucketName=xxx&bucketRegion=us-west-002   → { enabled, targetBucket, targetPrefix }
//   POST { bucketName, bucketRegion, enabled, targetBucket, targetPrefix }  → { ok }
// =============================================================================

router.get('/:accountId/s3_logging', async (req, res) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId } = req.params;
  const { bucketName, bucketRegion } = req.query;

  if (!BUCKET_NAME_RE.test(String(bucketName || ''))) {
    return res.status(400).json({ error: 'bucketName missing or malformed' });
  }
  if (!ALLOWED_REGIONS.has(String(bucketRegion))) {
    return res.status(400).json({ error: `bucketRegion must be one of: ${[...ALLOWED_REGIONS].join(', ')}` });
  }

  let keyId, secret;
  try {
    const cred = getCredential(accountId);
    if (!cred) throw new Error('No stored credentials');
    secret = getDecryptedApplicationKey(accountId);
    if (!secret) throw new Error('Could not decrypt key');
    keyId = cred.application_key_id;
  } catch (err) {
    return res.status(404).json({ error: 'no_credentials', message: err.message });
  }

  const host = `${bucketName}.s3.${bucketRegion}.backblazeb2.com`;
  const headers = s3AuthHeaders('GET', host, '/', 'logging', bucketRegion, keyId, secret);

  try {
    const s3Res = await fetch(`https://${host}/?logging`, {
      method: 'GET',
      headers: { Host: host, ...headers },
    });
    const xml = await s3Res.text();
    if (!s3Res.ok) {
      console.error(`[customerB2] s3_get_bucket_logging ${accountId}/${bucketName}: ${s3Res.status} ${xml}`);
      return res.status(s3Res.status).json({ error: `S3 GetBucketLogging failed: ${s3Res.status}`, detail: xml });
    }
    res.json(parseLoggingXml(xml));
  } catch (err) {
    console.error('[customerB2] s3_get_bucket_logging fetch error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/:accountId/s3_logging', requireCsrf, async (req, res) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId } = req.params;
  // PutBucketLogging is a mutation — same write gate as the b2_* mutations and
  // the file routes. customer_readonly may GET logging status but not change it.
  if (!canWrite(req.session.user)) return denyReadOnly(req, res, accountId, 's3_logging');
  const { bucketName, bucketRegion, enabled, targetBucket, targetPrefix = '' } = req.body;

  if (!BUCKET_NAME_RE.test(String(bucketName || ''))) {
    return res.status(400).json({ error: 'bucketName missing or malformed' });
  }
  if (!ALLOWED_REGIONS.has(String(bucketRegion))) {
    return res.status(400).json({ error: `bucketRegion must be one of: ${[...ALLOWED_REGIONS].join(', ')}` });
  }
  if (enabled && !BUCKET_NAME_RE.test(String(targetBucket || ''))) {
    return res.status(400).json({ error: 'targetBucket required (and must be a valid B2 bucket name) when enabling logging' });
  }

  let keyId, secret;
  try {
    const cred = getCredential(accountId);
    if (!cred) throw new Error('No stored credentials');
    secret = getDecryptedApplicationKey(accountId);
    if (!secret) throw new Error('Could not decrypt key');
    keyId = cred.application_key_id;
  } catch (err) {
    return res.status(404).json({ error: 'no_credentials', message: err.message });
  }

  const body = buildLoggingXml(enabled, targetBucket, targetPrefix);
  const host  = `${bucketName}.s3.${bucketRegion}.backblazeb2.com`;
  const headers = s3AuthHeaders('PUT', host, '/', 'logging', bucketRegion, keyId, secret, body);

  try {
    const s3Res = await fetch(`https://${host}/?logging`, {
      method: 'PUT',
      headers: { Host: host, ...headers },
      body,
    });
    if (!s3Res.ok) {
      const errText = await s3Res.text();
      console.error(`[customerB2] s3_put_bucket_logging ${accountId}/${bucketName}: ${s3Res.status} ${errText}`);
      return res.status(s3Res.status).json({ error: `S3 PutBucketLogging failed: ${s3Res.status}`, detail: errText });
    }
    audit({
      actorId: req.session.user.id,
      action:  enabled ? 'customer_b2.s3_logging_enabled' : 'customer_b2.s3_logging_disabled',
      details: { accountId, bucketName, targetBucket: targetBucket || null, targetPrefix },
      ip:      req.ip,
    });
    res.json({ ok: true, enabled: !!enabled, targetBucket: targetBucket || null, targetPrefix });
  } catch (err) {
    console.error('[customerB2] s3_put_bucket_logging fetch error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// =============================================================================
// File operations — upload / download / delete via the S3-compatible API.
// Streamed through the proxy (the browser can't reach private B2 buckets under
// CORS). Multi-segment paths (/file/...) never collide with the generic
// /:accountId/:endpoint route. Writes require customer_admin / partner staff.
// =============================================================================

// Reject path traversal / control chars; B2 object keys may contain '/'.
function validFileKey(k) {
  if (typeof k !== "string" || k.length === 0 || k.length > 1024) return false;
  if (k.startsWith("/") || k.includes("..") || /[\u0000-\u001f]/.test(k)) return false;
  return true;
}

// Build the S3 host + RFC-3986 path for a bucket/region/object key.
function s3Object(bucketName, region, key) {
  const host = `${bucketName}.s3.${region}.backblazeb2.com`;
  const path = '/' + key.split('/').map(encodeURIComponent).join('/');
  return { host, path, url: `https://${host}${path}` };
}

// Decrypt the sub-account's S3 key pair. Throws { code:'no_credentials' }.
function s3Creds(accountId) {
  const cred = getCredential(accountId);
  if (!cred) { const e = new Error('No stored credentials'); e.code = 'no_credentials'; throw e; }
  const secret = getDecryptedApplicationKey(accountId);
  if (!secret) { const e = new Error('Could not decrypt key'); e.code = 'no_credentials'; throw e; }
  return { keyId: cred.application_key_id, secret };
}

// Validate bucket/region/key; returns an error string or null.
function validateObjectParams({ bucket, region, key }) {
  if (!BUCKET_NAME_RE.test(String(bucket || ''))) return 'bucket missing or malformed';
  if (!ALLOWED_REGIONS.has(String(region))) return `region must be one of: ${[...ALLOWED_REGIONS].join(', ')}`;
  if (!validFileKey(String(key || ''))) return 'file key missing or malformed';
  return null;
}

function denyReadOnly(req, res, accountId, op) {
  audit({ actorId: req.session.user.id, action: 'authz.denied', details: { route: 'customer-b2', accountId, op, reason: 'read_only' }, ip: req.ip });
  return res.status(403).json({ error: 'read_only', message: 'Read-only access — file changes require an account admin.' });
}

// POST /:accountId/file/upload?bucket=&region=&key=  (raw body streamed to S3 PUT)
router.post('/:accountId/file/upload', requireCsrf, async (req, res) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId } = req.params;
  if (!canWrite(req.session.user)) return denyReadOnly(req, res, accountId, 'file_upload');
  const { bucket, region, key } = req.query;
  const bad = validateObjectParams({ bucket, region, key });
  if (bad) return res.status(400).json({ error: bad });

  // B2's S3 endpoint rejects a chunked (no-length) PUT signed with
  // UNSIGNED-PAYLOAD. Require Content-Length so we never forward one.
  if (!req.headers['content-length']) {
    return res.status(411).json({ error: 'length_required', message: 'Content-Length header is required for uploads.' });
  }

  let creds;
  try { creds = s3Creds(accountId); } catch { return res.status(404).json({ error: 'no_credentials' }); }
  const { host, path, url } = s3Object(bucket, region, key);
  const headers = s3AuthHeaders('PUT', host, path, '', region, creds.keyId, creds.secret, '', {
    payloadHash: 'UNSIGNED-PAYLOAD',
    contentType: req.headers['content-type'] || 'application/octet-stream',
  });
  try {
    const s3Res = await fetch(url, {
      method: 'PUT',
      headers: { Host: host, ...headers, ...(req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}) },
      body: req,
      duplex: 'half',
    });
    if (!s3Res.ok) {
      const txt = await s3Res.text();
      return res.status(s3Res.status).json({ error: `S3 PUT failed: ${s3Res.status}`, detail: txt.slice(0, 500) });
    }
    audit({ actorId: req.session.user.id, action: 'customer_b2.file_upload', details: { accountId, bucket, key }, ip: req.ip });
    res.json({ ok: true, bucket, key, etag: s3Res.headers.get('etag') || null });
  } catch (err) {
    console.error('[customerB2] upload error:', err.message);
    res.status(502).json({ error: `Upload failed: ${err.message}` });
  }
});

// GET /:accountId/file/download?bucket=&region=&key=  (streams the object back)
router.get('/:accountId/file/download', async (req, res) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId } = req.params;
  const { bucket, region, key } = req.query;
  const bad = validateObjectParams({ bucket, region, key });
  if (bad) return res.status(400).json({ error: bad });

  let creds;
  try { creds = s3Creds(accountId); } catch { return res.status(404).json({ error: 'no_credentials' }); }
  const { host, path, url } = s3Object(bucket, region, key);
  const headers = s3AuthHeaders('GET', host, path, '', region, creds.keyId, creds.secret, '');
  try {
    const s3Res = await fetch(url, { headers: { Host: host, ...headers } });
    if (!s3Res.ok) {
      const txt = await s3Res.text();
      return res.status(s3Res.status).json({ error: `S3 GET failed: ${s3Res.status}`, detail: txt.slice(0, 500) });
    }
    res.setHeader('Content-Type', s3Res.headers.get('content-type') || 'application/octet-stream');
    const len = s3Res.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);
    res.setHeader('Content-Disposition', `attachment; filename="${String(key).split('/').pop().replace(/"/g, '')}"`);
    Readable.fromWeb(s3Res.body).pipe(res);
  } catch (err) {
    console.error('[customerB2] download error:', err.message);
    res.status(502).json({ error: `Download failed: ${err.message}` });
  }
});

// POST /:accountId/file/delete  { bucket, region, key }  (S3 DELETE object)
router.post('/:accountId/file/delete', requireCsrf, async (req, res) => {
  if (rejectInvalidAccountAccess(req, res)) return;
  const { accountId } = req.params;
  if (!canWrite(req.session.user)) return denyReadOnly(req, res, accountId, 'file_delete');
  const { bucket, region, key } = req.body || {};
  const bad = validateObjectParams({ bucket, region, key });
  if (bad) return res.status(400).json({ error: bad });

  let creds;
  try { creds = s3Creds(accountId); } catch { return res.status(404).json({ error: 'no_credentials' }); }
  const { host, path, url } = s3Object(bucket, region, key);
  const headers = s3AuthHeaders('DELETE', host, path, '', region, creds.keyId, creds.secret, '');
  try {
    const s3Res = await fetch(url, { method: 'DELETE', headers: { Host: host, ...headers } });
    if (!s3Res.ok && s3Res.status !== 204) {
      const txt = await s3Res.text();
      return res.status(s3Res.status).json({ error: `S3 DELETE failed: ${s3Res.status}`, detail: txt.slice(0, 500) });
    }
    audit({ actorId: req.session.user.id, action: 'customer_b2.file_delete', details: { accountId, bucket, key }, ip: req.ip });
    res.json({ ok: true, bucket, key });
  } catch (err) {
    console.error('[customerB2] delete error:', err.message);
    res.status(502).json({ error: `Delete failed: ${err.message}` });
  }
});

export default router;
