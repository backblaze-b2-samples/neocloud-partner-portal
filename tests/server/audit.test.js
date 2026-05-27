// Tests for the audit log: list filters, pagination, JOIN enrichment,
// retention pruning, CSV export, and authz-denied logging from customerB2.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import adminRouter from '../../server/routes/admin.js';
import customerB2Router from '../../server/routes/customerB2.js';
import { audit, listAudit, pruneAudit } from '../../server/audit.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/admin', adminRouter);
  app.use('/api/customer-b2', customerB2Router);
  return app;
}
const app = makeApp();

let adminSid, adminCsrf, adminId;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const admin = createUser({ email: 'audit-admin@test.com', passwordHash: 'h', role: 'admin' });
  adminId = admin.id;
  const a = createSession({ userId: admin.id });
  adminSid = a.sid; adminCsrf = a.csrf;
});

const ag = (path) => request(app).get(path).set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`);
const ap = (path, body) => request(app).post(path)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
  .set('X-CSRF-Token', adminCsrf)
  .send(body || {});

describe('listAudit filters', () => {
  beforeAll(() => {
    db.prepare('DELETE FROM audit_log').run();
    audit({ actorId: adminId, action: 'auth.login.success', ip: '1.1.1.1' });
    audit({ actorId: adminId, action: 'auth.login.failed',  ip: '1.1.1.1' });
    audit({ actorId: adminId, action: 'user.created', targetUserId: 999, details: { role: 'manager' } });
    audit({ actorId: null,    action: 'admin.seeded', targetUserId: adminId });
  });

  it('returns total count + entries with JOIN-enriched actor_email', () => {
    const { entries, total } = listAudit({});
    expect(total).toBe(4);
    expect(entries.length).toBe(4);
    const login = entries.find((e) => e.action === 'auth.login.success');
    expect(login.actor_email).toBe('audit-admin@test.com');
  });

  it('action substring filter', () => {
    const { entries, total } = listAudit({ action: 'auth.' });
    expect(total).toBe(2);
    expect(entries.every((e) => e.action.startsWith('auth.'))).toBe(true);
  });

  it('actorId filter excludes null actors (system events)', () => {
    const { entries } = listAudit({ actorId: adminId });
    expect(entries.find((e) => e.action === 'admin.seeded')).toBeUndefined();
    expect(entries.every((e) => e.actor_id === adminId)).toBe(true);
  });

  it('pagination via limit + offset', () => {
    const page1 = listAudit({ limit: 2, offset: 0 });
    const page2 = listAudit({ limit: 2, offset: 2 });
    expect(page1.entries.length).toBe(2);
    expect(page2.entries.length).toBe(2);
    expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
    expect(page1.total).toBe(4);
  });

  it('limit is clamped to 500', () => {
    const r = listAudit({ limit: 99999 });
    expect(r.entries.length).toBeLessThanOrEqual(500);
  });
});

describe('pruneAudit retention', () => {
  beforeAll(() => {
    db.prepare('DELETE FROM audit_log').run();
    // Insert one 400-day-old entry + one fresh entry
    db.prepare(`INSERT INTO audit_log (actor_id, action, created_at) VALUES (?, ?, ?)`)
      .run(adminId, 'auth.login.success', new Date(Date.now() - 400 * 86_400_000).toISOString());
    audit({ actorId: adminId, action: 'auth.login.success' });
  });

  it('removes entries older than the retention window', () => {
    const removed = pruneAudit(365);
    expect(removed).toBe(1);
    const { total } = listAudit({});
    expect(total).toBe(1); // only the fresh one survives
  });
});

describe('GET /api/admin/audit', () => {
  beforeAll(() => {
    db.prepare('DELETE FROM audit_log').run();
    audit({ actorId: adminId, action: 'auth.login.success' });
    audit({ actorId: adminId, action: 'user.created' });
  });

  it('returns entries + total', async () => {
    const r = await ag('/api/admin/audit');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.entries.length).toBe(2);
  });

  it('honors action filter from query string', async () => {
    const r = await ag('/api/admin/audit?action=auth.');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });

  it('rejects non-admin', async () => {
    const u = createUser({ email: 'audit-mgr@test.com', passwordHash: 'h', role: 'manager' });
    const s = createSession({ userId: u.id });
    const r = await request(app).get('/api/admin/audit')
      .set('Cookie', `sid=${s.sid}; csrf=${s.csrf}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /api/admin/audit.csv', () => {
  it('returns CSV with header row and content-disposition', async () => {
    const r = await ag('/api/admin/audit.csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*audit-/);
    expect(r.text.split('\n')[0]).toBe('id,created_at,actor_id,action,target_user_id,ip,details');
  });
});

describe('customer-b2 authz denials are audited', () => {
  it('writes an authz.denied entry when a customer hits another accountId', async () => {
    db.prepare('DELETE FROM audit_log').run();
    const customer = createUser({
      email: 'audit-cust@test.com', passwordHash: 'h',
      role: 'customer_admin', accountId: 'cust-own',
    });
    const s = createSession({ userId: customer.id });
    await request(app).post('/api/customer-b2/different-acct/b2_list_buckets')
      .set('Cookie', `sid=${s.sid}; csrf=${s.csrf}`)
      .set('X-CSRF-Token', s.csrf)
      .send({});

    const { entries } = listAudit({ action: 'authz.denied' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor_id).toBe(customer.id);
    expect(entries[0].details).toContain('different-acct');
  });
});
