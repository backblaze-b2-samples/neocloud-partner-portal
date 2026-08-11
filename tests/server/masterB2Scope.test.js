// Tests for per-account scoping on the master-b2 routes. These endpoints read
// the object_counts / file_index tables written by the 24h job — tenant data
// that a customer user must not be able to read for another account.
// Every assertion short-circuits at the authz layer, so no B2 call is made.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import masterB2Router from '../../server/routes/masterB2.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/master-b2', masterB2Router);
  return app;
}
const app = makeApp();

const ACCT_A = 'scope-acct-a';
const ACCT_B = 'scope-acct-b';
const BUCKET_A = 'scope-bucket-a';
const BUCKET_B = 'scope-bucket-b';

let staffSid, staffCsrf, custASid, custACsrf;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM object_counts').run();
  db.prepare('DELETE FROM file_index').run();

  // Two tenants, one bucket each.
  const insCount = db.prepare(
    `INSERT INTO object_counts (bucket_id, account_id, bucket_name, object_count, total_bytes, counted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insCount.run(BUCKET_A, ACCT_A, 'tenant-a-private', 10, 100, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  insCount.run(BUCKET_B, ACCT_B, 'tenant-b-private', 20, 200, '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z');

  const insFile = db.prepare(
    `INSERT INTO file_index (bucket_id, file_id, file_name, size, uploaded_at, content_type, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insFile.run(BUCKET_B, 'fid-b', 'tenant-b-secret.txt', 5, '2026-08-02T00:00:00Z', 'text/plain', '2026-08-02T00:00:00Z');

  // Partner staff carry a null accountId; customer roles are pinned to one.
  const staff = createUser({ email: 'scope-staff@test.com', passwordHash: 'h', role: 'admin', accountId: null });
  let s = createSession({ userId: staff.id }); staffSid = s.sid; staffCsrf = s.csrf;

  const custA = createUser({ email: 'scope-a@test.com', passwordHash: 'h', role: 'customer_admin', accountId: ACCT_A });
  s = createSession({ userId: custA.id }); custASid = s.sid; custACsrf = s.csrf;
});

const get = (sid, csrf) => (path) =>
  request(app).get(path).set('Cookie', `sid=${sid}; csrf=${csrf}`);
const post = (sid, csrf) => (path, body) =>
  request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf).send(body || {});
const postNoCsrf = (sid, csrf) => (path, body) =>
  request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).send(body || {});

describe('GET /object-counts scoping', () => {
  it('partner staff see every account', async () => {
    const r = await get(staffSid, staffCsrf)('/api/master-b2/object-counts');
    expect(r.status).toBe(200);
    expect(r.body.counts.map((c) => c.accountId).sort()).toEqual([ACCT_A, ACCT_B]);
  });

  it('a customer user sees only their own rows', async () => {
    const r = await get(custASid, custACsrf)('/api/master-b2/object-counts');
    expect(r.status).toBe(200);
    expect(r.body.counts).toHaveLength(1);
    expect(r.body.counts[0].accountId).toBe(ACCT_A);
  });

  it("does not leak another tenant's bucket names", async () => {
    const r = await get(custASid, custACsrf)('/api/master-b2/object-counts');
    expect(JSON.stringify(r.body)).not.toContain('tenant-b-private');
    expect(JSON.stringify(r.body)).not.toContain(BUCKET_B);
  });

  it('jobRanAt reflects the scoped rows, not the global max', async () => {
    const r = await get(custASid, custACsrf)('/api/master-b2/object-counts');
    // ACCT_B was counted later; a scoped caller must not learn that timestamp.
    expect(r.body.jobRanAt).toBe('2026-08-01T00:00:00Z');
  });
});

describe('GET /file-index/:bucketId scoping', () => {
  it("a customer cannot read another tenant's file names", async () => {
    const r = await get(custASid, custACsrf)(`/api/master-b2/file-index/${BUCKET_B}`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('tenant-b-secret.txt');
  });

  it('a customer can read their own bucket', async () => {
    const r = await get(custASid, custACsrf)(`/api/master-b2/file-index/${BUCKET_A}`);
    expect(r.status).toBe(200);
  });

  it('a customer cannot probe an unknown bucket id', async () => {
    const r = await get(custASid, custACsrf)('/api/master-b2/file-index/no-such-bucket');
    expect(r.status).toBe(403);
  });

  it('partner staff can read any bucket', async () => {
    const r = await get(staffSid, staffCsrf)(`/api/master-b2/file-index/${BUCKET_B}`);
    expect(r.status).toBe(200);
    expect(r.body.files.map((f) => f.fileName)).toContain('tenant-b-secret.txt');
  });
});

describe('sync / refresh scoping', () => {
  it("a customer cannot sync another tenant's account", async () => {
    const r = await post(custASid, custACsrf)(`/api/master-b2/sync-account/${ACCT_B}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Forbidden/);
  });

  it("a customer cannot refresh another tenant's counts", async () => {
    const r = await post(custASid, custACsrf)(`/api/master-b2/object-counts/refresh/${ACCT_B}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Forbidden/);
  });

  it('the refresh route enforces CSRF', async () => {
    const r = await postNoCsrf(custASid, custACsrf)(`/api/master-b2/object-counts/refresh/${ACCT_A}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/CSRF/i);
  });

  it('sync-all is partner-staff only', async () => {
    const r = await post(custASid, custACsrf)('/api/master-b2/sync-all');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/partner staff only/);
  });
});

describe('reports-csv scoping still holds', () => {
  it("rejects another tenant's accountId", async () => {
    const r = await post(custASid, custACsrf)('/api/master-b2/reports-csv', {
      authorizationToken: 't', apiUrl: 'https://api005.backblazeb2.com',
      downloadUrl: 'https://f005.backblazeb2.com', accountId: ACCT_B,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Forbidden/);
  });
});

describe('denials are audited', () => {
  it('writes an authz.denied row', async () => {
    await post(custASid, custACsrf)(`/api/master-b2/sync-account/${ACCT_B}`);
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'authz.denied'`
    ).get();
    expect(row.n).toBeGreaterThan(0);
  });
});
