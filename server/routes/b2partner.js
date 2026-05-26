// =============================================================================
// /api/b2-partner — server-side proxy for Backblaze Partner API v3 calls.
//
// The B2 Partner API v3 endpoints must be called at the account-specific API
// host (e.g. api004.backblazeb2.com), not the generic api.backblazeb2.com.
// Browser → B2 direct calls are blocked by CORS, and the nginx /b2-proxy only
// covers api.backblazeb2.com. This route lets the browser hand its B2 auth
// token to Express, which forwards the Partner API call from Node.js (no CORS
// restrictions, any B2 host reachable).
//
// POST /api/b2-partner/:endpoint
//   Headers:  Authorization: <B2 auth token from b2_authorize_account>
//             X-B2-Api-Url:  <apiUrl from b2_authorize_account, e.g. https://api004.backblazeb2.com>
//   Body:     JSON — forwarded as-is to B2
//   Returns:  JSON response from B2, or a structured error
//
// No session / auth required — the B2 token IS the credential. The route
// is intentionally public-ish so the SPA can call it without a cookie.
// Rate limiting is inherited from the global limiter in index.js.
// =============================================================================

import express from 'express';
import { requireAuth, requireNotDemo } from '../middleware/requireAuth.js';
import { upsertCredential } from '../credentials.js';

const router = express.Router();
router.use(requireAuth, requireNotDemo);

// Allowlist of Partner API v3 endpoints this proxy will forward. Keeps the
// proxy from becoming a general-purpose B2 relay.
const ALLOWED_ENDPOINTS = new Set([
  'b2_list_groups',
  'b2_list_group_members',
  'b2_create_group_member',   // provision a new sub-account; response carries the only copy of applicationKey
  // Member management
  'b2_eject_group_member',    // eject a sub-account from a group (optional email change included)
  'b2_update_account_email',  // update a sub-account's login email (without ejecting)
]);

router.post('/:endpoint', async (req, res) => {
  const { endpoint } = req.params;

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: `Endpoint '${endpoint}' is not allowed via this proxy.` });
  }

  // B2 auth token + account-specific API URL are passed from the browser.
  const authHeader = req.headers['authorization'];
  const apiUrl = req.headers['x-b2-api-url'];

  if (!authHeader || !authHeader.startsWith('Bearer ') && !authHeader) {
    return res.status(400).json({ error: 'Missing Authorization header.' });
  }
  if (!apiUrl) {
    return res.status(400).json({ error: 'Missing X-B2-Api-Url header.' });
  }

  // Validate the API URL looks like a real B2 host (or a local proxy).
  // Accept: https://api<N>.backblazeb2.com  OR  http(s)://localhost:<port>/...
  const isB2Host = /^https:\/\/api\d+\.backblazeb2\.com$/.test(apiUrl);
  const isLocalhost = /^https?:\/\/localhost(:\d+)?/.test(apiUrl);
  if (!isB2Host && !isLocalhost) {
    return res.status(400).json({ error: 'X-B2-Api-Url must be a backblazeb2.com API host.' });
  }

  const targetUrl = `${apiUrl}/b2api/v3/${endpoint}`;

  // Sanitise request body before forwarding to B2.
  // b2_list_groups: cap maxGroupCount at 100 (B2 rejects values > 100).
  // b2_list_group_members: cap maxMemberCount at 100.
  const forwardBody = { ...req.body };
  if (endpoint === 'b2_list_groups' && forwardBody.maxGroupCount > 100) {
    forwardBody.maxGroupCount = 100;
  }
  if (endpoint === 'b2_list_group_members' && forwardBody.maxMemberCount > 100) {
    forwardBody.maxMemberCount = 100;
  }

  try {
    const b2Res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(forwardBody),
    });

    const text = await b2Res.text();

    // Intercept b2_create_group_member success: extract the one-time
    // applicationKey and persist credentials before forwarding to the browser.
    // Without this, the secret reaches the browser and is then gone forever —
    // every subsequent per-customer call (listBuckets / createBucket / etc.)
    // would fail with "no_credentials".
    if (endpoint === 'b2_create_group_member' && b2Res.ok) {
      try {
        const data = JSON.parse(text);
        const newAccountId = data?.groupMember?.accountId;
        if (newAccountId && data.applicationKeyId && data.applicationKey) {
          upsertCredential({
            accountId:        newAccountId,
            email:            forwardBody.memberEmail,
            groupId:          forwardBody.groupId,
            region:           forwardBody.region,
            applicationKeyId: data.applicationKeyId,
            applicationKey:   data.applicationKey,
          });
          console.log(`[b2partner] stored credentials for new sub-account ${newAccountId} (${forwardBody.memberEmail})`);
        }
      } catch (credErr) {
        // Don't fail the user-facing request just because credential storage hit
        // an error — log loudly so it gets noticed in pm2 logs.
        console.error(`[b2partner] FAILED to store credentials for new sub-account: ${credErr.message}`);
      }
    }

    // Forward B2's status code and body verbatim so the browser-side error
    // handling in partnerApi.js can parse the same error shape.
    res.status(b2Res.status)
       .set('Content-Type', 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[b2partner] fetch failed for ${endpoint}:`, err.message);
    res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
});

export default router;
