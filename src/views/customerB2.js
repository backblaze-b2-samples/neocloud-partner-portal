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
import { requireAuth } from '../middleware/requireAuth.js';
import { getCredential, getDecryptedApplicationKey } from '../credentials.js';

const router = express.Router();

const ALLOWED_ENDPOINTS = new Set([
  'b2_list_buckets',
  'b2_list_keys',
  'b2_list_file_names',
  'b2_list_file_versions',
  'b2_get_file_info',
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
  const NEEDS_ACCOUNT_ID = new Set(['b2_list_buckets', 'b2_list_keys']);
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

    // For b2_list_buckets, inject _apiHost so the client can derive region.
    // The sub-account's apiUrl encodes the region (api003=eu, api004=us-west, api005=us-east).
    if (endpoint === 'b2_list_buckets' && b2Res.ok) {
      try {
        const parsed = JSON.parse(text);
        const m = auth.apiUrl?.match(/api(\d+)\.backblazeb2\.com/);
        const apiHost = m ? `api${m[1]}.backblazeb2.com` : null;
        if (parsed.buckets && apiHost) {
          parsed.buckets = parsed.buckets.map((b) => ({ ...b, _apiHost: apiHost }));
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

export default router;
