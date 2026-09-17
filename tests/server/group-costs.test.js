// Tests for /api/admin/group-costs — what the partner PAYS Backblaze per B2
// partner group. Read by any partner staff member, written by plans:write.
// Never visible to a tenant user: these are the partner's own purchase rates.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import groupCostsRouter from '../../server/routes/groupCosts.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/admin/group-costs', groupCostsRouter);
  return app;
}
const app = makeApp();

let adminSid, adminCsrf, userSid, userCsrf;

beforeAll(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const admin = createUser({ email: 'gc-admin@test.com', passwordHash: 'h', role: 'admin' });
  const a = createSession({ userId: admin.id });
  adminSid = a.sid; adminCsrf = a.csrf;

  const user = createUser({ email: 'gc-user@test.com', passwordHash: 'h', role: 'manager' });
  const u = createSession({ userId: user.id });
  userSid = u.sid; userCsrf = u.csrf;
});

beforeEach(() => { db.prepare('DELETE FROM group_costs').run(); });

const ag  = (p) => request(app).get(p).set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`);
const ap  = (p, body) => request(app).put(p)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`).set('X-CSRF-Token', adminCsrf).send(body);
const adel = (p) => request(app).delete(p)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`).set('X-CSRF-Token', adminCsrf);

describe('PUT /:groupId — egress cost', () => {
  it('stores a negotiated egress rate', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 3.42, costPerGbEgress: 0.005 });
    expect(r.status).toBe(200);
    expect(r.body.cost.costPerGbEgress).toBe(0.005);
  });

  it('leaves it null when not negotiated — meaning list, not free', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    expect(r.body.cost.costPerGbEgress).toBeNull();
  });

  it('stores zero distinctly from unset', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPerGbEgress: 0 });
    expect(r.body.cost.costPerGbEgress).toBe(0);
  });

  it('clears when sent empty', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPerGbEgress: 0.005 });
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPerGbEgress: '' });
    expect(r.body.cost.costPerGbEgress).toBeNull();
  });

  it('rejects a negative or non-numeric rate, and stores nothing', async () => {
    expect((await ap('/api/admin/group-costs/g8', { costPerTb: 1, costPerGbEgress: -1 })).status).toBe(400);
    expect((await ap('/api/admin/group-costs/g8', { costPerTb: 1, costPerGbEgress: 'free' })).status).toBe(400);
    expect((await ag('/api/admin/group-costs')).body.costs).toHaveLength(0);
  });
});

describe('PUT /:groupId — transaction costs', () => {
  it('stores Class A/B/C alongside storage', async () => {
    const r = await ap('/api/admin/group-costs/166701', {
      costPerTb: 3.42,
      costPer10kClassA: 0.002,
      costPer10kClassB: 0.0015,
      costPer10kClassC: 0.001,
    });
    expect(r.status).toBe(200);
    expect(r.body.cost).toMatchObject({
      costPerTb: 3.42, costPer10kClassA: 0.002, costPer10kClassB: 0.0015, costPer10kClassC: 0.001,
    });
  });

  it('leaves unnegotiated classes null — meaning list, not free', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 3.42, costPer10kClassA: 0.002 });
    expect(r.body.cost.costPer10kClassA).toBe(0.002);
    expect(r.body.cost.costPer10kClassB).toBeNull();
    expect(r.body.cost.costPer10kClassC).toBeNull();
  });

  it('stores a class cost of zero distinctly from unset', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPer10kClassA: 0 });
    expect(r.body.cost.costPer10kClassA).toBe(0);
    expect(r.body.cost.costPer10kClassB).toBeNull();
  });

  it('clears a class cost when sent empty', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPer10kClassA: 0.002 });
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 1, costPer10kClassA: '' });
    expect(r.body.cost.costPer10kClassA).toBeNull();
  });

  it('rejects a negative or non-numeric class cost, and stores nothing', async () => {
    expect((await ap('/api/admin/group-costs/g9', { costPerTb: 1, costPer10kClassB: -1 })).status).toBe(400);
    expect((await ap('/api/admin/group-costs/g9', { costPerTb: 1, costPer10kClassC: 'free' })).status).toBe(400);
    expect((await ag('/api/admin/group-costs')).body.costs).toHaveLength(0);
  });
});

describe('PUT /:groupId', () => {
  it('stores a negotiated cost', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    expect(r.status).toBe(200);
    expect(r.body.cost).toMatchObject({ groupId: '166701', costPerTb: 3.42 });
  });

  it('upserts rather than duplicating', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    await ap('/api/admin/group-costs/166701', { costPerTb: 2.10 });
    const list = await ag('/api/admin/group-costs');
    expect(list.body.costs).toHaveLength(1);
    expect(list.body.costs[0].costPerTb).toBe(2.10);
  });

  it('keeps groups independent', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    await ap('/api/admin/group-costs/166702', { costPerTb: 2.10 });
    const byId = Object.fromEntries((await ag('/api/admin/group-costs')).body.costs.map((c) => [c.groupId, c.costPerTb]));
    expect(byId).toEqual({ '166701': 3.42, '166702': 2.10 });
  });

  it('accepts zero — a fully absorbed cost is not the same as unset', async () => {
    const r = await ap('/api/admin/group-costs/166701', { costPerTb: 0 });
    expect(r.status).toBe(200);
    expect(r.body.cost.costPerTb).toBe(0);
  });

  it('rejects a negative or non-numeric cost', async () => {
    expect((await ap('/api/admin/group-costs/g1', { costPerTb: -1 })).status).toBe(400);
    expect((await ap('/api/admin/group-costs/g1', { costPerTb: 'free' })).status).toBe(400);
    expect((await ap('/api/admin/group-costs/g1', {})).status).toBe(400);
  });

  it('refuses a non-admin, and stores nothing', async () => {
    const r = await request(app).put('/api/admin/group-costs/166701')
      .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`).set('X-CSRF-Token', userCsrf)
      .send({ costPerTb: 1 });
    expect(r.status).toBe(403);
    expect((await ag('/api/admin/group-costs')).body.costs).toHaveLength(0);
  });

  it('refuses without a CSRF token', async () => {
    const r = await request(app).put('/api/admin/group-costs/166701')
      .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`).send({ costPerTb: 1 });
    expect(r.status).toBe(403);
  });
});

describe('DELETE /:groupId', () => {
  it('clears a cost, reverting the group to B2 list', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    expect((await adel('/api/admin/group-costs/166701')).status).toBe(200);
    expect((await ag('/api/admin/group-costs')).body.costs).toHaveLength(0);
  });

  it('404s when nothing is stored', async () => {
    expect((await adel('/api/admin/group-costs/never-set')).status).toBe(404);
  });
});

describe('GET /', () => {
  it('is empty when nothing is negotiated', async () => {
    expect((await ag('/api/admin/group-costs')).body.costs).toEqual([]);
  });

  it('is readable by non-admin partner staff — margin needs cost', async () => {
    await ap('/api/admin/group-costs/166701', { costPerTb: 3.42 });
    const r = await request(app).get('/api/admin/group-costs')
      .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`);
    expect(r.status).toBe(200);
    expect(r.body.costs).toHaveLength(1);
  });
});
