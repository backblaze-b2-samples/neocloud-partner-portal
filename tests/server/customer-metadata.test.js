// Tests for /api/admin/metadata — list, get-with-200-null, put upsert,
// eject (snapshot), restore, delete. No real B2 calls.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import metadataRouter from '../../server/routes/customerMetadata.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/admin/metadata', metadataRouter);
  return app;
}
const app = makeApp();

let adminSid, adminCsrf;
let userSid, userCsrf;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM customer_metadata').run();

  const admin = createUser({ email: 'meta-admin@test.com', passwordHash: 'h', role: 'admin' });
  const a = createSession({ userId: admin.id });
  adminSid = a.sid; adminCsrf = a.csrf;

  const user = createUser({ email: 'meta-user@test.com', passwordHash: 'h', role: 'manager' });
  const u = createSession({ userId: user.id });
  userSid = u.sid; userCsrf = u.csrf;
});

const ag = (path) => request(app).get(path).set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`);
const ap = (method, path, body) => request(app)[method](path)
  .set('Cookie', `sid=${adminSid}; csrf=${adminCsrf}`)
  .set('X-CSRF-Token', adminCsrf)
  .send(body);
const ug = (path) => request(app).get(path).set('Cookie', `sid=${userSid}; csrf=${userCsrf}`);
const up = (method, path, body) => request(app)[method](path)
  .set('Cookie', `sid=${userSid}; csrf=${userCsrf}`)
  .set('X-CSRF-Token', userCsrf)
  .send(body);

describe('customerMetadata route — auth', () => {
  it('rejects unauthenticated GET /', async () => {
    const r = await request(app).get('/api/admin/metadata');
    expect(r.status).toBe(401);
  });
  it('rejects non-admin', async () => {
    const r = await ug('/api/admin/metadata');
    expect(r.status).toBe(403);
  });
});

describe('GET /:accountId returns 200 + null (no 404 spam)', () => {
  it('returns metadata: null for unknown account', async () => {
    const r = await ag('/api/admin/metadata/does-not-exist');
    expect(r.status).toBe(200);
    expect(r.body.metadata).toBeNull();
  });
});

describe('PUT /:accountId upsert', () => {
  it('creates a row when none exists', async () => {
    const r = await ap('put', '/api/admin/metadata/aaa111', {
      display_name: 'Acme', industry: 'SaaS', plan: 'Reseller — Tier 2',
      price_per_gb_storage: 0.012, price_per_gb_download: 0.02, notes: 'hi',
    });
    expect(r.status).toBe(200);
    expect(r.body.metadata.account_id).toBe('aaa111');
    expect(r.body.metadata.display_name).toBe('Acme');
    expect(r.body.metadata.plan).toBe('Reseller — Tier 2');
  });

  it('updates an existing row', async () => {
    await ap('put', '/api/admin/metadata/aaa222', { display_name: 'V1', plan: null });
    const r = await ap('put', '/api/admin/metadata/aaa222', { display_name: 'V2', plan: 'Reseller — Tier 1' });
    expect(r.status).toBe(200);
    expect(r.body.metadata.display_name).toBe('V2');
    expect(r.body.metadata.plan).toBe('Reseller — Tier 1');
  });

  it('rejects non-admin', async () => {
    const r = await up('put', '/api/admin/metadata/aaa999', { display_name: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('POST /:accountId/eject snapshots fields', () => {
  it('writes ejected_at + email + group + region', async () => {
    const r = await ap('post', '/api/admin/metadata/ej001/eject', {
      email: 'old@example.com', groupId: 'g1', region: 'us-west-002',
    });
    expect(r.status).toBe(200);
    expect(r.body.metadata.ejected_at).toBeTruthy();
    expect(r.body.metadata.ejected_email).toBe('old@example.com');
    expect(r.body.metadata.ejected_group_id).toBe('g1');
    expect(r.body.metadata.ejected_region).toBe('us-west-002');
  });

  it('uses supplied ejectedAt date if provided', async () => {
    const r = await ap('post', '/api/admin/metadata/ej002/eject', {
      email: 'x@x.com', groupId: 'g', region: null, ejectedAt: '2026-03-08',
    });
    expect(r.body.metadata.ejected_at).toBe('2026-03-08');
  });

  it('rejects non-admin', async () => {
    const r = await up('post', '/api/admin/metadata/ej003/eject', { email: 'x@x.com' });
    expect(r.status).toBe(403);
  });
});

describe('POST /:accountId/restore clears ejection', () => {
  it('null-outs all ejection fields', async () => {
    await ap('post', '/api/admin/metadata/restore1/eject', { email: 'a@b.c', groupId: 'g', region: 'r' });
    const r = await ap('post', '/api/admin/metadata/restore1/restore', {});
    expect(r.status).toBe(200);
    expect(r.body.metadata.ejected_at).toBeNull();
    expect(r.body.metadata.ejected_email).toBeNull();
    expect(r.body.metadata.ejected_group_id).toBeNull();
    expect(r.body.metadata.ejected_region).toBeNull();
  });

  it('404s when no row exists', async () => {
    const r = await ap('post', '/api/admin/metadata/never-was/restore', {});
    expect(r.status).toBe(404);
  });
});

describe('DELETE /:accountId removes row', () => {
  it('deletes existing row', async () => {
    await ap('put', '/api/admin/metadata/del1', { display_name: 'tmp' });
    const r = await ap('delete', '/api/admin/metadata/del1');
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);

    const after = await ag('/api/admin/metadata/del1');
    expect(after.body.metadata).toBeNull();
  });

  it('404s on missing row', async () => {
    const r = await ap('delete', '/api/admin/metadata/never-existed');
    expect(r.status).toBe(404);
  });
});

describe('GET / lists all', () => {
  it('returns the metadata array', async () => {
    const r = await ag('/api/admin/metadata');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.metadata)).toBe(true);
    expect(r.body.metadata.length).toBeGreaterThan(0);
  });
});
