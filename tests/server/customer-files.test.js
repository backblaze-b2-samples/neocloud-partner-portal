// Tests for the customer-b2 file routes (upload / download / delete). All
// assertions short-circuit at the role/scope/validation/credential layer —
// the routes reject before any real S3 fetch, so these never call out.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createUser } from '../../server/users.js';
import { createSession } from '../../server/auth.js';
import { attachSession } from '../../server/middleware/requireAuth.js';
import customerB2Router from '../../server/routes/customerB2.js';
import { db } from '../../server/db.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachSession);
  app.use('/api/customer-b2', customerB2Router);
  return app;
}
const app = makeApp();

let adminSid, adminCsrf, roSid, roCsrf, otherSid, otherCsrf;
const ACCT = 'files-acct-1';

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const admin = createUser({ email: 'files-admin@test.com', passwordHash: 'h', role: 'customer_admin', accountId: ACCT });
  let s = createSession({ userId: admin.id }); adminSid = s.sid; adminCsrf = s.csrf;

  const ro = createUser({ email: 'files-ro@test.com', passwordHash: 'h', role: 'customer_readonly', accountId: ACCT });
  s = createSession({ userId: ro.id }); roSid = s.sid; roCsrf = s.csrf;

  const other = createUser({ email: 'files-other@test.com', passwordHash: 'h', role: 'customer_admin', accountId: 'someone-else' });
  s = createSession({ userId: other.id }); otherSid = s.sid; otherCsrf = s.csrf;
});

const post = (sid, csrf) => (path, body) =>
  request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).set('X-CSRF-Token', csrf).send(body || {});
const postNoCsrf = (sid, csrf) => (path, body) =>
  request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).send(body || {});
const get = (sid, csrf) => (path) =>
  request(app).get(path).set('Cookie', `sid=${sid}; csrf=${csrf}`);

const GOOD = 'bucket=valid-bucket-name&region=us-west-002&key=path/to/file.txt';

describe('file upload', () => {
  it('rejects without CSRF', async () => {
    const r = await postNoCsrf(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/upload?${GOOD}`);
    expect(r.status).toBe(403);
  });
  it('customer_readonly cannot upload (403 read_only)', async () => {
    const r = await post(roSid, roCsrf)(`/api/customer-b2/${ACCT}/file/upload?${GOOD}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('read_only');
  });
  it('cannot upload to another account (403 Forbidden)', async () => {
    const r = await post(adminSid, adminCsrf)(`/api/customer-b2/someone-else/file/upload?${GOOD}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Forbidden/);
  });
  it('rejects malformed bucket / region / key', async () => {
    const bad = [
      'bucket=BAD..NAME&region=us-west-002&key=ok.txt',
      'bucket=valid-bucket-name&region=evil.example.com&key=ok.txt',
      'bucket=valid-bucket-name&region=us-west-002&key=../escape',
    ];
    for (const q of bad) {
      const r = await post(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/upload?${q}`);
      expect(r.status).toBe(400);
    }
  });
  it('customer_admin with valid params but no stored creds → 404 (past the gate)', async () => {
    const r = await post(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/upload?${GOOD}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_credentials');
  });
});

describe('file download (reads open to readonly)', () => {
  it('cannot download from another account', async () => {
    const r = await get(adminSid, adminCsrf)(`/api/customer-b2/someone-else/file/download?${GOOD}`);
    expect(r.status).toBe(403);
  });
  it('rejects malformed key', async () => {
    const r = await get(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/download?bucket=valid-bucket-name&region=us-west-002&key=../x`);
    expect(r.status).toBe(400);
  });
  it('customer_readonly CAN download (not gated) — 404 only on missing creds', async () => {
    const r = await get(roSid, roCsrf)(`/api/customer-b2/${ACCT}/file/download?${GOOD}`);
    expect(r.status).not.toBe(403);
    expect(r.status).toBe(404);
  });
});

describe('file delete', () => {
  it('rejects without CSRF', async () => {
    const r = await postNoCsrf(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/delete`, { bucket: 'valid-bucket-name', region: 'us-west-002', key: 'a.txt' });
    expect(r.status).toBe(403);
  });
  it('customer_readonly cannot delete (403 read_only)', async () => {
    const r = await post(roSid, roCsrf)(`/api/customer-b2/${ACCT}/file/delete`, { bucket: 'valid-bucket-name', region: 'us-west-002', key: 'a.txt' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('read_only');
  });
  it('cannot delete in another account', async () => {
    const r = await post(adminSid, adminCsrf)(`/api/customer-b2/someone-else/file/delete`, { bucket: 'valid-bucket-name', region: 'us-west-002', key: 'a.txt' });
    expect(r.status).toBe(403);
  });
  it('rejects malformed params', async () => {
    const r = await post(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/delete`, { bucket: 'x', region: 'us-west-002', key: 'a.txt' });
    expect(r.status).toBe(400);
  });
  it('admin valid params, no creds → 404', async () => {
    const r = await post(adminSid, adminCsrf)(`/api/customer-b2/${ACCT}/file/delete`, { bucket: 'valid-bucket-name', region: 'us-west-002', key: 'a.txt' });
    expect(r.status).toBe(404);
  });
});
