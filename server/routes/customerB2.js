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
import { requireAuth, requireNotDemo } from '../middleware/requireAuth.js';
import { getCredential, getDecryptedApplicationKey } from '../credentials.js';

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
 */
function s3AuthHeaders(method, host, path, query, region, keyId, secret, body = '') {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');           // YYYYMMDD
  const amzDate  = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z'); // YYYYMMDDTHHmmssZ
  const payloadHash = sha256hex(body);

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
    ...(body ? { 'Content-Type': 'application/xml' } : {}),
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
  'b2_list_buckets',
  'b2_list_keys',
  'b2_list_file_names',
  'b2_list_file_versions',
  'b2_get_file_info',
  'b2_create_bucket',
]);

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

router.post('/:accountId/:endpoint', requireAuth, async (req, res) => {
  const { accountId, endpoint } = req.params;

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: `Endpoint '${endpoint}' not allowed via customer proxy.` });
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
  const NEEDS_ACCOUNT_ID = new Set(['b2_list_buckets', 'b2_list_keys', 'b2_create_bucket']);
  const body = NEEDS_ACCOUNT_ID.has(endpoint)
    ? { accountId: auth.accountId, ...req.body }
    : { ...req.body };

  try {
    const b2Res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: auth.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await b2Res.text();

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
        return res.status(b2Res.status).json(parsed);
      } catch (_) { /* fall through to raw send */ }
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

router.get('/:accountId/s3_logging', requireAuth, async (req, res) => {
  const { accountId } = req.params;
  const { bucketName, bucketRegion } = req.query;

  if (!bucketName || !bucketRegion) {
    return res.status(400).json({ error: 'bucketName and bucketRegion query params required' });
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

router.post('/:accountId/s3_logging', requireAuth, async (req, res) => {
  const { accountId } = req.params;
  const { bucketName, bucketRegion, enabled, targetBucket, targetPrefix = '' } = req.body;

  if (!bucketName || !bucketRegion) {
    return res.status(400).json({ error: 'bucketName and bucketRegion required' });
  }
  if (enabled && !targetBucket) {
    return res.status(400).json({ error: 'targetBucket required when enabling logging' });
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
    res.json({ ok: true, enabled: !!enabled, targetBucket: targetBucket || null, targetPrefix });
  } catch (err) {
    console.error('[customerB2] s3_put_bucket_logging fetch error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
