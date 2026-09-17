// =============================================================================
// oidcClient — OIDC discovery, token exchange, and ID-token validation.
// =============================================================================
// Works with any standards-compliant provider: Microsoft Entra ID, Okta, Google
// Workspace, Keycloak, AWS Cognito, Auth0.
//
// Ported from the older backblaze-b2-samples/b2-partner-portal
// (app/services/oidc_client.py). The SSRF hardening below — issuer validation
// and the same-origin check on discovered endpoints — is the most valuable part
// of that implementation and is reproduced deliberately: the issuer URL is
// operator-supplied and is fetched by the server, so it is an SSRF sink.
// =============================================================================

import { createRemoteJWKSet, jwtVerify } from 'jose';
import net from 'node:net';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;  // re-fetch at most once an hour
const FETCH_TIMEOUT_MS = 10_000;

const discoveryCache = new Map();   // issuer -> { doc, fetchedAt }
const jwksCache      = new Map();   // jwks_uri -> remote key set

/** Drop cached discovery (and its key set) — call when the config changes. */
export function clearDiscoveryCache(issuerUrl) {
  if (issuerUrl) {
    const cached = discoveryCache.get(issuerUrl);
    if (cached?.doc?.jwks_uri) jwksCache.delete(cached.doc.jwks_uri);
    discoveryCache.delete(issuerUrl);
    return;
  }
  discoveryCache.clear();
  jwksCache.clear();
}

function allowedIssuerHosts() {
  return new Set(
    (process.env.SSO_ALLOWED_ISSUER_HOSTS || '')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  );
}

function isPrivateAddress(host) {
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;   // link-local
    if (a >= 224) return true;                 // multicast / reserved
    return false;
  }
  if (version === 6) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

/**
 * Validate an operator-supplied issuer URL before we ever fetch it.
 * Throws with an operator-readable message; never returns a value.
 */
export function validateIssuerUrl(issuerUrl) {
  let parsed;
  try {
    parsed = new URL(issuerUrl);
  } catch {
    throw new Error('Issuer URL is not a valid URL');
  }
  const host = (parsed.hostname || '').toLowerCase();
  if (parsed.protocol !== 'https:' || !host) {
    throw new Error('Issuer URL must be an HTTPS URL with a host');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Issuer URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Issuer URL must not contain a query string or fragment');
  }

  const allowlist = allowedIssuerHosts();
  if (allowlist.size > 0) {
    if (!allowlist.has(host)) {
      throw new Error(`Issuer host '${host}' is not in SSO_ALLOWED_ISSUER_HOSTS`);
    }
    return;
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Issuer URL must not target a local host');
  }
  if (isPrivateAddress(host)) {
    throw new Error('Issuer URL must not target a private or loopback address');
  }
}

/**
 * A discovered endpoint must live on the issuer's own host. Without this, a
 * compromised or misconfigured discovery document could point the token request
 * (which carries the client secret) at an attacker-controlled server.
 */
function requireSameOrigin(issuerUrl, endpointUrl, label) {
  let issuer, endpoint;
  try {
    issuer = new URL(issuerUrl);
    endpoint = new URL(endpointUrl);
  } catch {
    throw new Error(`OIDC ${label} is not a valid URL`);
  }
  if (endpoint.protocol !== 'https:' || endpoint.host !== issuer.host) {
    throw new Error(
      `OIDC ${label} '${endpointUrl}' does not share the issuer host '${issuer.host}'. ` +
      'The provider’s discovery document may be misconfigured.'
    );
  }
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function getDiscovery(issuerUrl) {
  const issuer = String(issuerUrl || '').replace(/\/+$/, '');
  validateIssuerUrl(issuer);

  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;

  const { ok, body } = await fetchJson(`${issuer}/.well-known/openid-configuration`);
  if (!ok || !body) throw new Error('Could not read the provider’s discovery document');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!body[key]) throw new Error(`Discovery document is missing ${key}`);
    requireSameOrigin(issuer, body[key], key);
  }
  discoveryCache.set(issuer, { doc: body, fetchedAt: Date.now() });
  return body;
}

export async function buildAuthUrl({ issuerUrl, clientId, redirectUri, state }) {
  const doc = await getDiscovery(issuerUrl);
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    response_mode: 'query',
    scope:         'openid email profile',
    state,
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeCode({ issuerUrl, clientId, clientSecret, redirectUri, code }) {
  const doc = await getDiscovery(issuerUrl);
  const { ok, body } = await fetchJson(doc.token_endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }).toString(),
  });
  if (!ok || !body?.id_token) {
    throw new Error(body?.error_description || body?.error || 'Token exchange failed');
  }
  return body;
}

export async function verifyIdToken({ idToken, issuerUrl, clientId }) {
  const doc = await getDiscovery(issuerUrl);
  let keySet = jwksCache.get(doc.jwks_uri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(doc.jwks_uri));
    jwksCache.set(doc.jwks_uri, keySet);
  }
  try {
    const { payload } = await jwtVerify(idToken, keySet, {
      algorithms: ['RS256', 'ES256'],
      audience:   clientId,
      issuer:     doc.issuer || issuerUrl.replace(/\/+$/, ''),
    });
    return payload;
  } catch (e) {
    throw new Error(`ID token validation failed: ${e.message}`);
  }
}

/**
 * The verified email from the ID token, or null when it cannot be trusted.
 *
 * email_verified absent is treated as verified: Entra and Google omit it
 * because they verify at the directory level. Present-and-false is rejected —
 * some Okta and Cognito configurations allow unverified addresses, and an
 * unverified address would let anyone who can register it claim the account.
 */
export function extractEmail(claims) {
  if (claims?.email_verified === false) return null;
  const raw = claims?.email || claims?.preferred_username || '';
  const email = String(raw).trim().toLowerCase();
  return email || null;
}

/** Group identifiers from the configured claim — GUIDs (Entra) or names (Okta). */
export function extractGroups(claims, groupsClaim = 'groups') {
  const raw = claims?.[groupsClaim];
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => String(g));
}

/**
 * Did the provider omit the groups claim because the user is in too many groups?
 *
 * Microsoft Entra ID stops embedding group memberships once a user exceeds
 * roughly 150 of them, and substitutes a `_claim_names` / `_claim_sources`
 * pointer to the Graph API instead. We do not call Graph, so the user simply
 * appears to be in no groups — which would otherwise surface as a baffling
 * "your groups are not mapped to a role" for exactly the senior staff most
 * likely to be in many groups.
 *
 * Detecting it lets us say what actually happened.
 */
export function hasGroupOverage(claims, groupsClaim = 'groups') {
  const names = claims?._claim_names;
  if (!names || typeof names !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(names, groupsClaim);
}
