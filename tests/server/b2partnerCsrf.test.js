// Tests for CSRF / read-only-impersonation enforcement on the Partner API
// proxy. This router forwards state-changing Partner endpoints
// (b2_create_group_member, b2_eject_group_member, b2_update_account_email),
// so it must sit behind requireCsrf — which is also the single chokepoint
// that makes "view as customer" genuinely read-only.
//
// Every assertion short-circuits at the CSRF/impersonation layer or at header
// validation, so no request ever reaches Backblaze.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import b2partnerRouter from '../../server/routes/b2partner.js';
import impersonateRouter from '../../server/routes/impersonate.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/impersonate', impersonateRouter);
  app.use('/api/b2-partner', b2partnerRouter);
  return app;
}
const app = makeApp();

// Valid B2-shaped headers, so a request that clears the CSRF gate fails later
// on its own merits rather than on header validation.
const B2_HEADERS = {
  Authorization: 'Bearer fake-token',
  'X-B2-Api-Url': 'https://api005.backblazeb2.com',
};

let admin, customerAdmin;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  admin = createUser({ email: 'b2p-admin@test.com', passwordHash: 'h', role: 'admin', accountId: null });
  customerAdmin = createUser({ email: 'b2p-cust@test.com', passwordHash: 'h', role: 'customer_admin', accountId: 'b2p-acct' });
});

let sess;
beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  sess = createSession({ userId: admin.id });
});

const post = (path, body, { csrf = true, headers = B2_HEADERS } = {}) => {
  const r = request(app).post(path).set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`);
  if (csrf) r.set('X-CSRF-Token', sess.csrf);
  Object.entries(headers || {}).forEach(([k, v]) => r.set(k, v));
  return r.send(body || {});
};

const startImpersonation = () =>
  request(app)
    .post('/api/impersonate/start')
    .set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`)
    .set('X-CSRF-Token', sess.csrf)
    .send({ targetUserId: customerAdmin.id });

describe('CSRF enforcement', () => {
  it('rejects a write with no CSRF token', async () => {
    const r = await post('/api/b2-partner/b2_eject_group_member', { groupId: 'g', accountId: 'a' }, { csrf: false });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/CSRF/i);
  });

  it('rejects a read with no CSRF token', async () => {
    const r = await post('/api/b2-partner/b2_list_groups', {}, { csrf: false });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/CSRF/i);
  });

  it('lets a valid CSRF token through the gate', async () => {
    // Past CSRF the handler validates headers; with valid ones it would try to
    // reach B2. Assert only that it is NOT a CSRF rejection.
    const r = await post('/api/b2-partner/b2_list_groups', {});
    expect(r.status).not.toBe(403);
  });

  it('still rejects endpoints outside the allowlist', async () => {
    const r = await post('/api/b2-partner/b2_delete_everything', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not allowed/i);
  });
});

describe('read-only impersonation', () => {
  it('blocks b2_eject_group_member while impersonating', async () => {
    await startImpersonation();
    const r = await post('/api/b2-partner/b2_eject_group_member', { groupId: 'g', accountId: 'a' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonating_readonly');
  });

  it('blocks b2_create_group_member while impersonating', async () => {
    await startImpersonation();
    const r = await post('/api/b2-partner/b2_create_group_member', { groupId: 'g', email: 'x@y.com' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonating_readonly');
  });

  it('blocks b2_update_account_email while impersonating', async () => {
    await startImpersonation();
    const r = await post('/api/b2-partner/b2_update_account_email', { accountId: 'a', email: 'x@y.com' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonating_readonly');
  });

  it('audits the blocked write', async () => {
    await startImpersonation();
    await post('/api/b2-partner/b2_eject_group_member', { groupId: 'g', accountId: 'a' });
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'impersonation.write_blocked'`
    ).get().n;
    expect(n).toBeGreaterThan(0);
  });

  it('still allows the read endpoints while impersonating', async () => {
    await startImpersonation();
    for (const ep of ['b2_list_groups', 'b2_list_group_members']) {
      const r = await post(`/api/b2-partner/${ep}`, {});
      // Must not be the read-only block — reads are how "view as customer" works.
      expect(r.body.error).not.toBe('impersonating_readonly');
    }
  });
});
