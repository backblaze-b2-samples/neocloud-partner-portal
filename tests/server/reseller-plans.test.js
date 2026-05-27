// Tests for /api/admin/reseller-plans — list (any auth user) and update (admin+CSRF).
// Seed data is auto-populated by the route module on first import.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import resellerPlansRouter from '../../server/routes/resellerPlans.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/admin/reseller-plans', resellerPlansRouter);
  return app;
}
const app = makeApp();

let adminSid, adminCsrf;
let userSid, userCsrf;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const admin = createUser({ email: 'rp-admin@test.com', passwordHash: 'h', role: 'admin' });
  const a = createSession({ userId: admin.id });
  adminSid = a.sid; adminCsrf = a.csrf;

  const user = createUser({ email: 'rp-user@test.com', passwordHash: 'h', role: 'manager' });
  const u = createSession({ userId: user.id });
  userSid = u.sid; userCsrf = u.csrf;
});

const ag = (path) => request(app).get(path).set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`);
const ap = (path, body) => request(app).put(path)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
  .set('X-CSRF-Token', adminCsrf)
  .send(body);
const ug = (path) => request(app).get(path).set('Cookie', `sid=${userSid}; csrf=${userCsrf}`);
const up = (path, body) => request(app).put(path)
  .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`)
  .set('X-CSRF-Token', userCsrf)
  .send(body);

describe('GET / reseller plans (any auth)', () => {
  it('rejects unauthenticated', async () => {
    const r = await request(app).get('/api/admin/reseller-plans');
    expect(r.status).toBe(401);
  });

  it('lists seeded plans for admin', async () => {
    const r = await ag('/api/admin/reseller-plans');
    expect(r.status).toBe(200);
    const ids = r.body.plans.map((p) => p.id).sort();
    expect(ids).toEqual(['tier-1', 'tier-2', 'tier-3']);
  });

  it('non-admin users can list (used for billing math)', async () => {
    const r = await ug('/api/admin/reseller-plans');
    expect(r.status).toBe(200);
    expect(r.body.plans.length).toBe(3);
  });

  it('plans have all numeric fields', async () => {
    const r = await ag('/api/admin/reseller-plans');
    for (const p of r.body.plans) {
      expect(typeof p.storagePerTb).toBe('number');
      expect(typeof p.egressPerGb).toBe('number');
      expect(typeof p.classAPer10k).toBe('number');
      expect(typeof p.classBPer10k).toBe('number');
      expect(typeof p.classCPer10k).toBe('number');
      expect(typeof p.classDPer10k).toBe('number');
    }
  });

  it('default tier 3 mirrors B2 list (A/B/C free)', async () => {
    const r = await ag('/api/admin/reseller-plans');
    const t3 = r.body.plans.find((p) => p.id === 'tier-3');
    expect(t3.classAPer10k).toBe(0);
    expect(t3.classBPer10k).toBe(0);
    expect(t3.classCPer10k).toBe(0);
  });
});

describe('PUT /:id update plan', () => {
  it('admin can update storage / egress', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-2', { storagePerTb: 17, egressPerGb: 0.022 });
    expect(r.status).toBe(200);
    expect(r.body.plan.storagePerTb).toBe(17);
    expect(r.body.plan.egressPerGb).toBe(0.022);
  });

  it('admin can update class A/B/C/D', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-2', {
      classAPer10k: 0.005, classBPer10k: 0.006, classCPer10k: 0.0015, classDPer10k: 0.01,
    });
    expect(r.body.plan.classAPer10k).toBe(0.005);
    expect(r.body.plan.classDPer10k).toBe(0.01);
  });

  it('rejects non-admin', async () => {
    const r = await up('/api/admin/reseller-plans/tier-2', { storagePerTb: 99 });
    expect(r.status).toBe(403);
  });

  it('rejects negative pricing', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-2', { storagePerTb: -5 });
    expect(r.status).toBe(400);
  });

  it('rejects non-numeric pricing', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-2', { storagePerTb: 'abc' });
    expect(r.status).toBe(400);
  });

  it('404s on unknown plan id', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-99', { storagePerTb: 10 });
    expect(r.status).toBe(404);
  });

  it('partial update only changes provided fields', async () => {
    const before = await ag('/api/admin/reseller-plans');
    const t1 = before.body.plans.find((p) => p.id === 'tier-1');
    const originalEgress = t1.egressPerGb;
    await ap('/api/admin/reseller-plans/tier-1', { storagePerTb: 30 });
    const after = await ag('/api/admin/reseller-plans');
    const t1After = after.body.plans.find((p) => p.id === 'tier-1');
    expect(t1After.storagePerTb).toBe(30);
    expect(t1After.egressPerGb).toBe(originalEgress);
  });
});
