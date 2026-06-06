// Tests for the read-only "view as customer" impersonation flow.
// Covers: start/stop gating, target role restriction, the CSRF-chokepoint
// write block (and its read-endpoint opt-out), and audit logging of all
// state transitions.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser, findById } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import impersonateRouter from '../../server/routes/impersonate.js';
import adminRouter from '../../server/routes/admin.js';
import authRouter from '../../server/routes/auth.js';
import customerAdminRouter from '../../server/routes/customerAdmin.js';
import { listAudit } from '../../server/audit.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/customer-admin', customerAdminRouter);
  app.use('/api/impersonate', impersonateRouter);
  return app;
}
const app = makeApp();

let admin, support, manager, customerAdmin, customerReadonly, otherStaff;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  admin            = createUser({ email: 'imp-admin@test.com',  passwordHash: 'h', role: 'admin' });
  support          = createUser({ email: 'imp-support@test.com', passwordHash: 'h', role: 'support' });
  manager          = createUser({ email: 'imp-mgr@test.com',     passwordHash: 'h', role: 'manager' });
  otherStaff       = createUser({ email: 'imp-other@test.com',   passwordHash: 'h', role: 'user' });
  customerAdmin    = createUser({ email: 'imp-cust-a@test.com',  passwordHash: 'h', role: 'customer_admin',    accountId: 'cust-a' });
  customerReadonly = createUser({ email: 'imp-cust-r@test.com',  passwordHash: 'h', role: 'customer_readonly', accountId: 'cust-r' });
});

beforeEach(() => {
  // Clean sessions + audit between tests so assertions don't leak across blocks.
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

function sessionFor(userId) {
  return createSession({ userId });
}
function asGet(sess, path) {
  return request(app).get(path).set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`);
}
function asPost(sess, path, body) {
  return request(app).post(path)
    .set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`)
    .set('X-CSRF-Token', sess.csrf)
    .send(body || {});
}

describe('GET /api/impersonate/targets', () => {
  it('returns only active customer users', async () => {
    const sess = sessionFor(admin.id);
    const r = await asGet(sess, '/api/impersonate/targets');
    expect(r.status).toBe(200);
    const emails = r.body.targets.map((t) => t.email).sort();
    expect(emails).toEqual([customerAdmin.email, customerReadonly.email].sort());
  });

  it('is reachable by support too', async () => {
    const sess = sessionFor(support.id);
    const r = await asGet(sess, '/api/impersonate/targets');
    expect(r.status).toBe(200);
    expect(r.body.targets.length).toBe(2);
  });

  it('rejects non-admin / non-support partner staff', async () => {
    const sess = sessionFor(manager.id);
    const r = await asGet(sess, '/api/impersonate/targets');
    expect(r.status).toBe(403);
  });

  it('rejects customer roles', async () => {
    const sess = sessionFor(customerAdmin.id);
    const r = await asGet(sess, '/api/impersonate/targets');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/impersonate/start', () => {
  it('admin can start impersonation of a customer', async () => {
    const sess = sessionFor(admin.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // /me now reflects the impersonated identity, with impersonator carrying staff.
    const me = await asGet(sess, '/api/auth/me');
    expect(me.body.user.email).toBe(customerAdmin.email);
    expect(me.body.user.role).toBe('customer_admin');
    expect(me.body.user.accountId).toBe('cust-a');
    expect(me.body.impersonator.email).toBe(admin.email);
    expect(me.body.impersonator.role).toBe('admin');

    // Audit entry written.
    const { entries } = listAudit({ action: 'impersonation.start' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor_id).toBe(admin.id);
    expect(entries[0].target_user_id).toBe(customerAdmin.id);
  });

  it('support can start impersonation', async () => {
    const sess = sessionFor(support.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: customerReadonly.id });
    expect(r.status).toBe(200);
  });

  it('rejects non-admin / non-support staff', async () => {
    const sess = sessionFor(manager.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    expect(r.status).toBe(403);
  });

  it('refuses to impersonate another staff member', async () => {
    const sess = sessionFor(admin.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: otherStaff.id });
    expect(r.status).toBe(403);
  });

  it('refuses to impersonate self', async () => {
    const sess = sessionFor(admin.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: admin.id });
    expect(r.status).toBe(400);
  });

  it('refuses 404 on unknown target', async () => {
    const sess = sessionFor(admin.id);
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: 9_999_999 });
    expect(r.status).toBe(404);
  });

  it('refuses to nest a second impersonation', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    const r = await asPost(sess, '/api/impersonate/start', { targetUserId: customerReadonly.id });
    expect(r.status).toBe(409);
  });
});

describe('POST /api/impersonate/stop', () => {
  it('clears impersonation and restores staff identity', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });

    const r = await asPost(sess, '/api/impersonate/stop');
    expect(r.status).toBe(200);

    const me = await asGet(sess, '/api/auth/me');
    expect(me.body.user.email).toBe(admin.email);
    expect(me.body.impersonator).toBeNull();

    const { entries } = listAudit({ action: 'impersonation.stop' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor_id).toBe(admin.id);
    expect(entries[0].target_user_id).toBe(customerAdmin.id);
  });

  it('returns 400 if not currently impersonating', async () => {
    const sess = sessionFor(admin.id);
    const r = await asPost(sess, '/api/impersonate/stop');
    expect(r.status).toBe(400);
  });
});

describe('write block while impersonating', () => {
  it('blocks a customer-admin write the impersonator would otherwise reach', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });

    // The impersonator's effective role is customer_admin so requireRole on
    // the customer-admin router passes — the CSRF chokepoint is what stops
    // the write, which is the whole point of the read-only block.
    const r = await asPost(sess, '/api/customer-admin/users', {
      email: 'new-cust@test.com', password: 'longenough', role: 'customer_readonly',
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonating_readonly');

    const { entries } = listAudit({ action: 'impersonation.write_blocked' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor_id).toBe(admin.id);
    expect(entries[0].target_user_id).toBe(customerAdmin.id);
  });

  it('blocks change-password — would otherwise change the customer password', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    const r = await asPost(sess, '/api/auth/change-password', {
      currentPassword: 'whatever', newPassword: 'newlongpass',
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonating_readonly');
  });

  it('lets /impersonate/stop through even though it is a write', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    const r = await asPost(sess, '/api/impersonate/stop');
    expect(r.status).toBe(200);
  });

  it('lets logout through so impersonator can sign out', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });
    const r = await asPost(sess, '/api/auth/logout');
    expect(r.status).toBe(200);
  });

  it('honours req.allowDuringImpersonation flag for read-via-POST', async () => {
    // Simulate the customerB2 read-classifier: a route that sets the flag
    // before requireCsrf runs. Should NOT be blocked.
    const localApp = express();
    localApp.use(express.json());
    localApp.use(cookieParser());
    localApp.use(attachSession);
    const { requireAuth, requireCsrf } = await import('../../server/middleware/requireAuth.js');
    localApp.post(
      '/fake-read',
      requireAuth,
      (req, _res, next) => { req.allowDuringImpersonation = true; next(); },
      requireCsrf,
      (_req, res) => res.json({ ok: true })
    );

    // Bring impersonate router along so we can start the session.
    localApp.use('/api/impersonate', impersonateRouter);

    const sess = sessionFor(admin.id);
    await request(localApp).post('/api/impersonate/start')
      .set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`)
      .set('X-CSRF-Token', sess.csrf)
      .send({ targetUserId: customerAdmin.id });

    const r = await request(localApp).post('/fake-read')
      .set('Cookie', `sid=${sess.sid}; csrf=${sess.csrf}`)
      .set('X-CSRF-Token', sess.csrf)
      .send({});
    expect(r.status).toBe(200);
  });
});

describe('session shape integration', () => {
  it('disabling the impersonated user falls back to the staff identity', async () => {
    const sess = sessionFor(admin.id);
    await asPost(sess, '/api/impersonate/start', { targetUserId: customerAdmin.id });

    // Deactivate the impersonated user out of band. Subsequent session
    // resolution sees t_active=0 and falls back to returning the staff user.
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(customerAdmin.id);
    const me = await asGet(sess, '/api/auth/me');
    expect(me.body.user.email).toBe(admin.email);
    expect(me.body.impersonator).toBeNull();

    // Restore for other tests.
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(customerAdmin.id);
  });
});
