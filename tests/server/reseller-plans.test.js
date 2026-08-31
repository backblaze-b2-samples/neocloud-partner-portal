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

// ---------------------------------------------------------------------------
// Pinning a plan to a B2 partner group. Partners who price per group (Hot /
// Cool) need group membership to decide the rate, not per-account editing.
// ---------------------------------------------------------------------------
describe('PUT /:id group pinning', () => {
  it('pins a plan to a group and returns it as groupId', async () => {
    const r = await ap('/api/admin/reseller-plans/tier-1', { groupId: '166701' });
    expect(r.status).toBe(200);

    const list = await ag('/api/admin/reseller-plans');
    const t1 = list.body.plans.find((p) => p.id === 'tier-1');
    expect(t1.groupId).toBe('166701');
  });

  it('leaves the pin alone when groupId is not in the body', async () => {
    await ap('/api/admin/reseller-plans/tier-1', { groupId: '166701' });
    await ap('/api/admin/reseller-plans/tier-1', { storagePerTb: 3.42 });

    const list = await ag('/api/admin/reseller-plans');
    const t1 = list.body.plans.find((p) => p.id === 'tier-1');
    expect(t1.groupId).toBe('166701');
    expect(t1.storagePerTb).toBe(3.42);
  });

  it('refuses to pin one group to two plans', async () => {
    await ap('/api/admin/reseller-plans/tier-1', { groupId: '166701' });
    const r = await ap('/api/admin/reseller-plans/tier-2', { groupId: '166701' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/166701/);

    const list = await ag('/api/admin/reseller-plans');
    expect(list.body.plans.find((p) => p.id === 'tier-2').groupId).toBeNull();
  });

  it('unpins on empty string and on null', async () => {
    await ap('/api/admin/reseller-plans/tier-3', { groupId: '166702' });
    let r = await ap('/api/admin/reseller-plans/tier-3', { groupId: '' });
    expect(r.status).toBe(200);
    let list = await ag('/api/admin/reseller-plans');
    expect(list.body.plans.find((p) => p.id === 'tier-3').groupId).toBeNull();

    await ap('/api/admin/reseller-plans/tier-3', { groupId: '166702' });
    r = await ap('/api/admin/reseller-plans/tier-3', { groupId: null });
    expect(r.status).toBe(200);
    list = await ag('/api/admin/reseller-plans');
    expect(list.body.plans.find((p) => p.id === 'tier-3').groupId).toBeNull();
  });

  it('lets a plan keep its own pin on re-save', async () => {
    await ap('/api/admin/reseller-plans/tier-1', { groupId: '166701' });
    const r = await ap('/api/admin/reseller-plans/tier-1', { groupId: '166701' });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Managing the catalog: create, rename, delete, and the assigned-account count.
// Operators need their own tiers (Aylo's "Hot"/"Cool"), not just the samples.
// ---------------------------------------------------------------------------

const adel = (path) => request(app).delete(path)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
  .set('X-CSRF-Token', adminCsrf);
const apost = (path, body) => request(app).post(path)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
  .set('X-CSRF-Token', adminCsrf)
  .send(body);

const planNamed = async (name) => {
  const list = await ag('/api/admin/reseller-plans');
  return list.body.plans.find((p) => p.name === name);
};

describe('POST / — create a plan', () => {
  it('creates a tier with the rates given', async () => {
    const r = await apost('/api/admin/reseller-plans', {
      name: 'Aylo Hot', description: 'Hot tier', storagePerTb: 3.42, egressPerGb: 0.01,
    });
    expect(r.status).toBe(201);
    expect(r.body.plan.name).toBe('Aylo Hot');
    expect(r.body.plan.storagePerTb).toBe(3.42);
    expect(r.body.plan.assignedCount).toBe(0);
    expect(r.body.plan.groupId).toBeNull();
  });

  it('defaults omitted rates to zero rather than leaving them null', async () => {
    const r = await apost('/api/admin/reseller-plans', { name: 'Bare', storagePerTb: 5 });
    expect(r.status).toBe(201);
    expect(r.body.plan.classAPer10k).toBe(0);
    expect(r.body.plan.classDPer10k).toBe(0);
  });

  it('appends after the existing tiers', async () => {
    const before = await ag('/api/admin/reseller-plans');
    const maxPos = Math.max(...before.body.plans.map((p) => p.position));
    const r = await apost('/api/admin/reseller-plans', { name: 'Appended', storagePerTb: 1 });
    expect(r.body.plan.position).toBeGreaterThan(maxPos);
  });

  it('rejects a duplicate name, since name is the join key', async () => {
    await apost('/api/admin/reseller-plans', { name: 'Dupe', storagePerTb: 1 });
    const r = await apost('/api/admin/reseller-plans', { name: 'Dupe', storagePerTb: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already exists/);
  });

  it('rejects a blank or whitespace-only name', async () => {
    expect((await apost('/api/admin/reseller-plans', { storagePerTb: 1 })).status).toBe(400);
    expect((await apost('/api/admin/reseller-plans', { name: '   ', storagePerTb: 1 })).status).toBe(400);
  });

  it('rejects a negative rate', async () => {
    const r = await apost('/api/admin/reseller-plans', { name: 'Negative', storagePerTb: -1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/storagePerTb/);
  });

  it('refuses a non-admin', async () => {
    const r = await request(app).post('/api/admin/reseller-plans')
      .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`)
      .set('X-CSRF-Token', userCsrf)
      .send({ name: 'Sneaky', storagePerTb: 1 });
    expect(r.status).toBe(403);
    expect(await planNamed('Sneaky')).toBeUndefined();
  });

  it('refuses without a CSRF token', async () => {
    const r = await request(app).post('/api/admin/reseller-plans')
      .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
      .send({ name: 'NoCsrf', storagePerTb: 1 });
    expect(r.status).toBe(403);
  });
});

describe('PUT /:id — renaming carries the assignments', () => {
  it('moves customers on the old name to the new one', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Old Name', storagePerTb: 9 });
    const id = created.body.plan.id;

    db.prepare(`
      INSERT INTO customer_metadata (account_id, plan, created_at, updated_at)
      VALUES ('acct-rename', 'Old Name', datetime('now'), datetime('now'))
    `).run();

    const r = await ap(`/api/admin/reseller-plans/${id}`, { name: 'New Name' });
    expect(r.status).toBe(200);
    expect(r.body.plan.name).toBe('New Name');

    // The regression this guards: a rename that leaves the assignment behind
    // drops the customer to no rate card at all, billing at B2 list.
    const row = db.prepare('SELECT plan FROM customer_metadata WHERE account_id = ?').get('acct-rename');
    expect(row.plan).toBe('New Name');
    expect(r.body.plan.assignedCount).toBe(1);
  });

  it('rejects renaming onto another plan name', async () => {
    await apost('/api/admin/reseller-plans', { name: 'Taken', storagePerTb: 1 });
    const other = await apost('/api/admin/reseller-plans', { name: 'Mover', storagePerTb: 1 });
    const r = await ap(`/api/admin/reseller-plans/${other.body.plan.id}`, { name: 'Taken' });
    expect(r.status).toBe(409);
  });

  it('leaves the name alone when the body omits it', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Keeps Name', storagePerTb: 1 });
    const r = await ap(`/api/admin/reseller-plans/${created.body.plan.id}`, { storagePerTb: 4 });
    expect(r.body.plan.name).toBe('Keeps Name');
    expect(r.body.plan.storagePerTb).toBe(4);
  });
});

describe('GET / — assignedCount', () => {
  it('counts the customers explicitly on each plan', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Counted', storagePerTb: 1 });
    db.prepare(`
      INSERT INTO customer_metadata (account_id, plan, created_at, updated_at)
      VALUES ('acct-c1', 'Counted', datetime('now'), datetime('now')),
             ('acct-c2', 'Counted', datetime('now'), datetime('now'))
    `).run();

    const plan = await planNamed('Counted');
    expect(plan.assignedCount).toBe(2);
    expect(created.body.plan.assignedCount).toBe(0); // was 0 at creation
  });

  it('is 0, not undefined, for an unused plan', async () => {
    await apost('/api/admin/reseller-plans', { name: 'Unused', storagePerTb: 1 });
    expect((await planNamed('Unused')).assignedCount).toBe(0);
  });
});

describe('DELETE /:id', () => {
  it('deletes a plan nothing depends on', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Disposable', storagePerTb: 1 });
    const r = await adel(`/api/admin/reseller-plans/${created.body.plan.id}`);
    expect(r.status).toBe(200);
    expect(await planNamed('Disposable')).toBeUndefined();
  });

  it('refuses while a customer is assigned, and names them', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'In Use', storagePerTb: 1 });
    db.prepare(`
      INSERT INTO customer_metadata (account_id, display_name, plan, created_at, updated_at)
      VALUES ('acct-inuse', 'Acme Corp', 'In Use', datetime('now'), datetime('now'))
    `).run();

    const r = await adel(`/api/admin/reseller-plans/${created.body.plan.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Acme Corp/);
    expect(r.body.assignedCount).toBe(1);
    expect(await planNamed('In Use')).toBeTruthy(); // still there
  });

  it('refuses while pinned to a group, whose members carry no explicit plan', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Pinned', storagePerTb: 1 });
    await ap(`/api/admin/reseller-plans/${created.body.plan.id}`, { groupId: '900001' });

    const r = await adel(`/api/admin/reseller-plans/${created.body.plan.id}`);
    expect(r.status).toBe(409);
    expect(r.body.groupId).toBe('900001');
  });

  it('succeeds once the last assignment is cleared', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Freed', storagePerTb: 1 });
    db.prepare(`
      INSERT INTO customer_metadata (account_id, plan, created_at, updated_at)
      VALUES ('acct-freed', 'Freed', datetime('now'), datetime('now'))
    `).run();
    expect((await adel(`/api/admin/reseller-plans/${created.body.plan.id}`)).status).toBe(409);

    db.prepare("UPDATE customer_metadata SET plan = NULL WHERE account_id = 'acct-freed'").run();
    expect((await adel(`/api/admin/reseller-plans/${created.body.plan.id}`)).status).toBe(200);
  });

  it('404s for an unknown id', async () => {
    expect((await adel('/api/admin/reseller-plans/nope')).status).toBe(404);
  });

  it('refuses a non-admin', async () => {
    const created = await apost('/api/admin/reseller-plans', { name: 'Guarded', storagePerTb: 1 });
    const r = await request(app).delete(`/api/admin/reseller-plans/${created.body.plan.id}`)
      .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`)
      .set('X-CSRF-Token', userCsrf);
    expect(r.status).toBe(403);
    expect(await planNamed('Guarded')).toBeTruthy();
  });
});
