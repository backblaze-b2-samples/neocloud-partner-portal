// End-to-end SSO: the full redirect → callback → exchange → session path, with
// real RS256 signing and the real jose verification code. Only the network
// transport is stubbed (see tests/fixtures/mockIdp.mjs).
//
// This is the test that would catch a regression in the parts previously only
// proven by hand: discovery, the same-origin guard, token exchange, ID-token
// verification, JIT provisioning, role re-evaluation, and the one-time handoff.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createMockIdp, installFetch, CLIENT_ID, CLIENT_SECRET } from '../fixtures/mockIdp.mjs';
import { attachSession } from '../../server/middleware/requireAuth.js';
import ssoRouter from '../../server/routes/sso.js';
import ssoAdminRouter from '../../server/routes/ssoAdmin.js';
import authRouter from '../../server/routes/auth.js';
import { setConfig, createMapping } from '../../server/ssoStore.js';
import { createRole } from '../../server/roles.js';
import { createUser, findByEmail, setAuthSource } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { clearDiscoveryCache, getDiscovery, exchangeCode, verifyIdToken } from '../../server/sso/oidcClient.js';
import { resetRateLimits } from '../../server/rateLimit.js';
import { db } from '../../server/db.js';

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(attachSession);
  a.use('/api/auth/sso', ssoRouter);
  a.use('/api/admin/sso', ssoAdminRouter);
  a.use('/api/auth', authRouter);
  return a;
})();

let idp, restoreFetch;

beforeAll(async () => {
  process.env.CREDENTIAL_ENCRYPTION_KEY =
    process.env.CREDENTIAL_ENCRYPTION_KEY || 'test-encryption-key-at-least-32-chars-long';
  // idp.test.example is a public-looking host so validateIssuerUrl accepts it;
  // nothing ever resolves it because fetch is stubbed.
  db.prepare('DELETE FROM users').run();
  idp = await createMockIdp();
  restoreFetch = installFetch(idp.handler);
  createRole({ id: 'ops', name: 'Operations', scope: 'partner', permissions: ['audit:read', 'buckets:read'] });
});

afterAll(() => { restoreFetch(); });

beforeEach(() => {
  // Every request in this file comes from the same loopback address, so the SSO
  // limiter would otherwise trip partway through the suite.
  resetRateLimits();
  db.prepare('DELETE FROM sso_group_mappings').run();
  db.prepare('DELETE FROM sso_states').run();
  db.prepare('DELETE FROM sso_exchange_codes').run();
  db.prepare('DELETE FROM sso_config').run();
  clearDiscoveryCache();
  idp.state.claims = { email: 'alice@corp.example', groups: ['grp-ops'] };
  idp.state.tokenStatus = 200;
  idp.state.tokenOptions = undefined;
  idp.state.signWithWrongKey = false;
  idp.state.discoveryStatus = 200;
  setConfig({
    enabled: true, issuerUrl: idp.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    groupsClaim: 'groups', buttonLabel: 'Sign in with Acme',
  });
  createMapping({ groupValue: 'grp-ops', roleId: 'ops' });
});

/**
 * Walk /login → IdP → /callback, carrying the flow cookie the way a browser
 * would. Returns the final redirect plus the cookie, since the exchange needs it.
 */
async function walkToCallback() {
  const login = await request(app).get('/api/auth/sso/login').expect(302);
  const authUrl = new URL(login.headers.location);
  const state = authUrl.searchParams.get('state');
  const redirectUri = authUrl.searchParams.get('redirect_uri');
  expect(redirectUri).toMatch(/\/api\/auth\/sso\/callback$/);
  const flowCookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('sso_flow='));
  expect(flowCookie, 'login must issue a flow cookie').toBeTruthy();
  const jar = flowCookie.split(';')[0];
  const cb = await request(app)
    .get(`/api/auth/sso/callback?code=idp-code&state=${state}`)
    .set('Cookie', jar)
    .expect(302);
  return { location: cb.headers.location, state, jar };
}

async function signIn() {
  const { location, jar } = await walkToCallback();
  const code = new URL(location, 'http://x').searchParams.get('code');
  expect(code, `expected a handoff code, got ${location}`).toBeTruthy();
  const ex = await request(app).post('/api/auth/sso/exchange').set('Cookie', jar).send({ code }).expect(200);
  return ex.headers['set-cookie'];
}

// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('JIT-provisions a user onto the mapped role and issues a session', async () => {
    const cookies = await signIn();
    const me = await request(app).get('/api/auth/me').set('Cookie', cookies).expect(200);
    expect(me.body.user).toMatchObject({
      email: 'alice@corp.example', role: 'ops', authSource: 'sso', active: true,
    });
    expect(me.body.user.permissions.sort()).toEqual(['audit:read', 'buckets:read']);
  });

  it('sends the IdP a correctly formed authorization request', async () => {
    const login = await request(app).get('/api/auth/sso/login').expect(302);
    const u = new URL(login.headers.location);
    expect(u.origin).toBe(idp.issuer);
    expect(u.pathname).toBe('/authorize');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toHaveLength(43);
  });

  it('reuses the cached discovery document rather than refetching per login', async () => {
    const before = idp.state.calls.discovery;
    await request(app).get('/api/auth/sso/login').expect(302);
    await request(app).get('/api/auth/sso/login').expect(302);
    expect(idp.state.calls.discovery - before).toBe(1);
  });

  it('re-evaluates the role on every sign-in when IdP groups change', async () => {
    createMapping({ groupValue: 'grp-support', roleId: 'support' });
    await signIn();
    expect(findByEmail('alice@corp.example').role).toBe('ops');

    idp.state.claims = { email: 'alice@corp.example', groups: ['grp-support'] };
    await signIn();
    expect(findByEmail('alice@corp.example').role).toBe('support');

    // ...and back again, so this is not a one-way door.
    idp.state.claims = { email: 'alice@corp.example', groups: ['grp-ops'] };
    await signIn();
    expect(findByEmail('alice@corp.example').role).toBe('ops');
  });

  it('records provisioning and login in the audit log', async () => {
    db.prepare('DELETE FROM audit_log').run();
    idp.state.claims = { email: 'newcomer@corp.example', groups: ['grp-ops'] };
    await signIn();
    const actions = db.prepare("SELECT action FROM audit_log ORDER BY id").all().map((r) => r.action);
    expect(actions).toContain('auth.sso.provisioned');
    expect(actions).toContain('auth.sso.login.success');
  });
});

// ---------------------------------------------------------------------------

describe('token and signature failures', () => {
  it('refuses an ID token signed by a key that is not in the JWKS', async () => {
    idp.state.signWithWrongKey = true;
    idp.state.claims = { email: 'forged@corp.example', groups: ['grp-ops'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=token_error');
    expect(findByEmail('forged@corp.example')).toBeFalsy();
  });

  it('refuses an ID token issued for a different audience', async () => {
    idp.state.tokenOptions = { audience: 'some-other-client' };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=token_error');
  });

  it('refuses an ID token from an unexpected issuer', async () => {
    idp.state.tokenOptions = { issuerOverride: 'https://evil.test.example' };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=token_error');
  });

  it('refuses an expired ID token', async () => {
    idp.state.tokenOptions = { expiresIn: '-1s' };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=token_error');
  });

  it('surfaces a token-endpoint rejection', async () => {
    idp.state.tokenStatus = 400;
    idp.state.tokenBody = { error: 'invalid_grant', error_description: 'code already used' };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=token_error');
  });

  it('reports a provider that cannot be reached at all', async () => {
    idp.state.discoveryStatus = 503;
    clearDiscoveryCache();
    const res = await request(app).get('/api/auth/sso/login').expect(302);
    expect(res.headers.location).toBe('/?sso=1&error=discovery_failed');
  });
});

// ---------------------------------------------------------------------------

describe('discovery same-origin guard', () => {
  it('rejects a discovery document whose token endpoint is on another host', async () => {
    const evil = await createMockIdp({
      discovery: { token_endpoint: 'https://attacker.test.example/token' },
    });
    const restore = installFetch(evil.handler);
    try {
      clearDiscoveryCache();
      await expect(getDiscovery(evil.issuer)).rejects.toThrow(/does not share the issuer host/);
    } finally { restore(); clearDiscoveryCache(); }
  });

  it('rejects a plaintext jwks_uri', async () => {
    const evil = await createMockIdp({ discovery: { jwks_uri: 'http://idp.test.example/jwks' } });
    const restore = installFetch(evil.handler);
    try {
      clearDiscoveryCache();
      await expect(getDiscovery(evil.issuer)).rejects.toThrow(/does not share the issuer host/);
    } finally { restore(); clearDiscoveryCache(); }
  });

  it('rejects a discovery document missing a required endpoint', async () => {
    const broken = await createMockIdp({ discovery: { token_endpoint: undefined } });
    broken.discovery.token_endpoint = undefined;
    delete broken.discovery.token_endpoint;
    const restore = installFetch(broken.handler);
    try {
      clearDiscoveryCache();
      await expect(getDiscovery(broken.issuer)).rejects.toThrow(/missing token_endpoint/);
    } finally { restore(); clearDiscoveryCache(); }
  });
});

// ---------------------------------------------------------------------------

describe('account rules at the callback', () => {
  it('refuses to take over an existing password account', async () => {
    createUser({ email: 'dave@corp.example', passwordHash: 'h', role: 'user' });
    idp.state.claims = { email: 'dave@corp.example', groups: ['grp-ops'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=account_conflict');
    expect(findByEmail('dave@corp.example').role).toBe('user');   // untouched
  });

  it('accepts the same address once an admin has converted the account', async () => {
    const u = createUser({ email: 'erin@corp.example', passwordHash: 'h', role: 'user' });
    idp.state.claims = { email: 'erin@corp.example', groups: ['grp-ops'] };
    setAuthSource(u.id, 'sso');
    await signIn();
    const after = findByEmail('erin@corp.example');
    expect(after.id).toBe(u.id);          // same row — audit history survives
    expect(after.role).toBe('ops');
  });

  it('refuses a deactivated account', async () => {
    const u = createUser({ email: 'frank@corp.example', passwordHash: 'h', role: 'user' });
    setAuthSource(u.id, 'sso');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    idp.state.claims = { email: 'frank@corp.example', groups: ['grp-ops'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=account_inactive');
  });

  it('refuses a demo address', async () => {
    idp.state.claims = { email: 'someone@demo.com', groups: ['grp-ops'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=demo_account');
    expect(findByEmail('someone@demo.com')).toBeFalsy();
  });

  it('refuses an unverified email without provisioning anything', async () => {
    idp.state.claims = { email: 'gina@corp.example', email_verified: false, groups: ['grp-ops'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=no_email');
    expect(findByEmail('gina@corp.example')).toBeFalsy();
  });

  // Microsoft Entra ID replaces the groups claim with a Graph pointer once a
  // user belongs to more than ~150 groups. Real deployments hit this, and it
  // hits senior staff first.
  it('names the Entra group-overage case instead of reporting a missing mapping', async () => {
    idp.state.claims = {
      email: 'manygroups@corp.example',
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' } },
    };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=group_overage');
    const row = db.prepare("SELECT details FROM audit_log WHERE action='auth.sso.denied' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(row.details).reason).toBe('group_overage');
  });

  it('still reports no_role when groups are genuinely absent without an overage', async () => {
    idp.state.claims = { email: 'nogroups@corp.example' };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=no_role');
  });

  it('refuses a user whose groups map to nothing', async () => {
    idp.state.claims = { email: 'hank@corp.example', groups: ['grp-nothing'] };
    const { location } = await walkToCallback();
    expect(location).toBe('/?sso=1&error=no_role');
    expect(findByEmail('hank@corp.example')).toBeFalsy();
  });

  it('normalises the email case so one identity cannot become two accounts', async () => {
    idp.state.claims = { email: 'Ivy@Corp.Example', groups: ['grp-ops'] };
    await signIn();
    idp.state.claims = { email: 'ivy@corp.example', groups: ['grp-ops'] };
    await signIn();
    const n = db.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE 'ivy@corp.example'").get().n;
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('handoff code and state hardening', () => {
  it('consumes state so a replayed callback fails', async () => {
    const { state, jar } = await walkToCallback();
    const replay = await request(app)
      .get(`/api/auth/sso/callback?code=idp-code&state=${state}`).set('Cookie', jar).expect(302);
    expect(replay.headers.location).toBe('/?sso=1&error=invalid_state');
  });

  it('never puts a credential in the redirect URL', async () => {
    const { location } = await walkToCallback();
    expect(location).not.toMatch(/id_token|access_token|eyJ/);
  });

  it('only lets one of several concurrent exchanges of the same code win', async () => {
    const { location, jar } = await walkToCallback();
    const code = new URL(location, 'http://x').searchParams.get('code');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/auth/sso/exchange').set('Cookie', jar).send({ code }))
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
  });

  // The reason the flow cookie exists.
  it('refuses a handoff code redeemed in a different browser (login CSRF)', async () => {
    const { location } = await walkToCallback();          // attacker's browser
    const code = new URL(location, 'http://x').searchParams.get('code');
    // Victim's browser has no sso_flow cookie — this is the link-in-an-email case.
    const res = await request(app).post('/api/auth/sso/exchange').send({ code }).expect(400);
    expect(res.headers['set-cookie'].join(';')).not.toMatch(/sid=[^;]/);
    expect(res.body.error).toMatch(/Invalid or expired/);
  });

  it('refuses a handoff code redeemed with someone else\'s flow cookie', async () => {
    const victim = await walkToCallback();
    const attacker = await walkToCallback();
    const attackerCode = new URL(attacker.location, 'http://x').searchParams.get('code');
    await request(app).post('/api/auth/sso/exchange')
      .set('Cookie', victim.jar).send({ code: attackerCode }).expect(400);
  });

  it('refuses a callback completed in a browser that did not start the flow', async () => {
    const login = await request(app).get('/api/auth/sso/login').expect(302);
    const state = new URL(login.headers.location).searchParams.get('state');
    // No flow cookie presented.
    const cb = await request(app).get(`/api/auth/sso/callback?code=idp-code&state=${state}`).expect(302);
    expect(cb.headers.location).toBe('/?sso=1&error=invalid_state');
  });

  it('clears the flow cookie once the session is issued', async () => {
    const { location, jar } = await walkToCallback();
    const code = new URL(location, 'http://x').searchParams.get('code');
    const ex = await request(app).post('/api/auth/sso/exchange').set('Cookie', jar).send({ code }).expect(200);
    const setCookie = ex.headers['set-cookie'].join(';');
    expect(setCookie).toMatch(/sso_flow=;/);
    expect(setCookie).toMatch(/sid=/);
  });

  it('scopes the flow cookie to the SSO path and keeps it httpOnly', async () => {
    const login = await request(app).get('/api/auth/sso/login').expect(302);
    const c = (login.headers['set-cookie'] || []).find((x) => x.startsWith('sso_flow='));
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Path=\/api\/auth\/sso/);
    // Lax, not Strict: the IdP's redirect is a cross-site top-level GET.
    expect(c).toMatch(/SameSite=Lax/);
  });

  it('issues a session tied to the user the code was minted for', async () => {
    const cookies = await signIn();
    const sid = /sid=([^;]+)/.exec(cookies.join(';'))[1];
    const row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid);
    expect(row.user_id).toBe(findByEmail('alice@corp.example').id);
  });
});

// ---------------------------------------------------------------------------

describe('oidcClient units', () => {
  it('exchangeCode sends the client secret and returns the token set', async () => {
    const tokens = await exchangeCode({
      issuerUrl: idp.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      redirectUri: 'https://portal.test/cb', code: 'abc',
    });
    expect(tokens.id_token.split('.')).toHaveLength(3);
  });

  it('exchangeCode rejects a wrong client secret', async () => {
    await expect(exchangeCode({
      issuerUrl: idp.issuer, clientId: CLIENT_ID, clientSecret: 'wrong',
      redirectUri: 'https://portal.test/cb', code: 'abc',
    })).rejects.toThrow();
  });

  it('verifyIdToken accepts a well-formed token and returns its claims', async () => {
    const token = await idp.issueIdToken();
    const claims = await verifyIdToken({ idToken: token, issuerUrl: idp.issuer, clientId: CLIENT_ID });
    expect(claims.email).toBe('alice@corp.example');
    expect(claims.groups).toEqual(['grp-ops']);
  });

  it('verifyIdToken rejects a tampered payload', async () => {
    const token = await idp.issueIdToken();
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.email = 'attacker@corp.example';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    await expect(verifyIdToken({ idToken: forged, issuerUrl: idp.issuer, clientId: CLIENT_ID }))
      .rejects.toThrow(/validation failed/);
  });
});

// ---------------------------------------------------------------------------
// Switching identity provider at runtime
// ---------------------------------------------------------------------------
// A second deployment, or a move to a different Entra tenant, should be a
// configuration change and nothing more. This proves it: point the portal at a
// different provider through the admin endpoint, with a different issuer,
// client id and secret, and confirm sign in follows it over without a restart.

describe('pointing the portal at a different identity provider', () => {
  it('follows the new provider, and stops trusting the old one', async () => {
    const A = await createMockIdp({ issuer: 'https://idp-a.test.example' });
    const B = await createMockIdp({ issuer: 'https://idp-b.test.example' });
    A.state.claims = { email: 'from-a@corp.example', groups: ['grp-ops'] };
    B.state.claims = { email: 'from-b@corp.example', groups: ['grp-ops'] };

    // One fetch that answers for whichever provider the URL belongs to, the way
    // the internet would.
    const route = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      return url.includes('idp-b.test.example') ? B.handler(input, init) : A.handler(input, init);
    };
    const restore = installFetch(route);

    // An admin, to drive the config endpoint like an operator would.
    const admin = createUser({ email: 'switch-admin@test.com', passwordHash: 'h', role: 'admin' });
    const s = createSession({ userId: admin.id, ip: '127.0.0.1', userAgent: 'test' });
    const putConfig = (body) => request(app).put('/api/admin/sso/config')
      .set('Cookie', `sid=${s.sid}; csrf=${s.csrf}`).set('X-CSRF-Token', s.csrf).send(body);

    try {
      await putConfig({
        enabled: true, issuerUrl: A.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        groupsClaim: 'groups',
      }).expect(200);
      const cookiesA = await signIn();
      const meA = await request(app).get('/api/auth/me').set('Cookie', cookiesA).expect(200);
      expect(meA.body.user.email).toBe('from-a@corp.example');

      // Now the "different Entra" case: new issuer, new client, new secret.
      await putConfig({
        enabled: true, issuerUrl: B.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        groupsClaim: 'groups',
      }).expect(200);

      const cookiesB = await signIn();
      const meB = await request(app).get('/api/auth/me').set('Cookie', cookiesB).expect(200);
      expect(meB.body.user.email).toBe('from-b@corp.example');

      // The previous provider's signing key must no longer be accepted: the
      // discovery and JWKS caches have to have been dropped on the config write.
      const staleToken = await A.issueIdToken();
      await expect(
        verifyIdToken({ idToken: staleToken, issuerUrl: B.issuer, clientId: CLIENT_ID })
      ).rejects.toThrow();
    } finally {
      restore();
      clearDiscoveryCache();
    }
  });

  it('sends users to the new provider authorize endpoint', async () => {
    const B = await createMockIdp({ issuer: 'https://idp-b.test.example' });
    const restore = installFetch(B.handler);
    const admin = createUser({ email: 'switch-admin2@test.com', passwordHash: 'h', role: 'admin' });
    const s = createSession({ userId: admin.id, ip: '127.0.0.1', userAgent: 'test' });
    try {
      await request(app).put('/api/admin/sso/config')
        .set('Cookie', `sid=${s.sid}; csrf=${s.csrf}`).set('X-CSRF-Token', s.csrf)
        .send({ enabled: true, issuerUrl: B.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
        .expect(200);
      const login = await request(app).get('/api/auth/sso/login').expect(302);
      expect(new URL(login.headers.location).origin).toBe('https://idp-b.test.example');
    } finally {
      restore();
      clearDiscoveryCache();
    }
  });
});
