// An in-process OIDC provider for tests.
//
// It stubs global fetch rather than running a TLS server: the portal validates
// that an issuer is HTTPS and non-private, and standing up real TLS would mean
// shipping a certificate and key in the repo. Everything that matters is still
// real — RS256 keys, a genuine signed JWT, a real JWKS document, and the actual
// jose verification path. Only the transport is simulated.
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from 'jose';

export const ISSUER = 'https://idp.test.example';
export const CLIENT_ID = 'portal-client';
export const CLIENT_SECRET = 'portal-secret';

export async function createMockIdp(overrides = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = await calculateJwkThumbprint(jwk);
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const issuer = overrides.issuer || ISSUER;
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    ...overrides.discovery,
  };

  const state = {
    // What the next issued ID token should claim.
    claims: { email: 'alice@corp.example', groups: ['grp-ops'] },
    // Force failures for negative cases.
    tokenStatus: 200,
    tokenBody: null,
    signWithWrongKey: false,
    calls: { discovery: 0, token: 0, jwks: 0 },
  };

  const wrongPair = await generateKeyPair('RS256', { extractable: true });

  async function issueIdToken() {
    const { audience = CLIENT_ID, expiresIn = '5m', issuerOverride } = state.tokenOptions || {};
    return new SignJWT(state.claims)
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuedAt()
      .setIssuer(issuerOverride || issuer)
      .setAudience(audience)
      .setSubject('subject-1')
      .setExpirationTime(expiresIn)
      .sign(state.signWithWrongKey ? wrongPair.privateKey : privateKey);
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function handler(input, init) {
    const url = typeof input === 'string' ? input : input.url;

    if (url.endsWith('/.well-known/openid-configuration')) {
      state.calls.discovery++;
      if (state.discoveryStatus && state.discoveryStatus !== 200) return json({ error: 'nope' }, state.discoveryStatus);
      return json(discovery);
    }
    if (url === discovery.jwks_uri) {
      state.calls.jwks++;
      return json({ keys: [jwk] });
    }
    if (url === discovery.token_endpoint && (init?.method || 'GET') === 'POST') {
      state.calls.token++;
      const form = new URLSearchParams(init.body);
      if (form.get('client_secret') !== CLIENT_SECRET) return json({ error: 'invalid_client' }, 401);
      if (state.tokenStatus !== 200) return json(state.tokenBody || { error: 'invalid_grant' }, state.tokenStatus);
      return json({ access_token: 'at', token_type: 'Bearer', id_token: await issueIdToken() });
    }
    return json({ error: 'not_found' }, 404);
  }

  return { issuer, discovery, jwk, state, handler, issueIdToken };
}

/** Install the mock as global fetch; returns a restore function. */
export function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}
