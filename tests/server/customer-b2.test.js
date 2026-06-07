// Regression tests for /api/customer-b2/* hardening:
//   - POST requires X-CSRF-Token (PR #11, regressed in PR #12)
//   - :accountId must belong to the user (customer roles only)
//   - bucketName / bucketRegion validated (rejects SSRF surface)
//
// All assertions short-circuit before any real B2 fetch — the routes reject
// at the middleware / validation layer, so these tests never call out.
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

let partnerSid, partnerCsrf;
let customerSid, customerCsrf, customerAccountId;
let readonlySid, readonlyCsrf;

beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  const partner = createUser({ email: 'b2-partner@test.com', passwordHash: 'h', role: 'admin' });
  const p = createSession({ userId: partner.id });
  partnerSid = p.sid; partnerCsrf = p.csrf;

  customerAccountId = 'cust-abc-123';
  const customer = createUser({
    email: 'b2-customer@test.com', passwordHash: 'h',
    role: 'customer_admin', accountId: customerAccountId,
  });
  const c = createSession({ userId: customer.id });
  customerSid = c.sid; customerCsrf = c.csrf;

  const readonly = createUser({
    email: 'b2-readonly@test.com', passwordHash: 'h',
    role: 'customer_readonly', accountId: customerAccountId,
  });
  const ro = createSession({ userId: readonly.id });
  readonlySid = ro.sid; readonlyCsrf = ro.csrf;
});

// Helpers — cookies only, no CSRF header
const postNoCsrf = (sid, csrf) => (path, body) =>
  request(app).post(path).set('Cookie', `sid=${sid}; csrf=${csrf}`).send(body || {});

// Helpers — full auth + CSRF
const post = (sid, csrf) => (path, body) =>
  request(app).post(path)
    .set('Cookie', `sid=${sid}; csrf=${csrf}`)
    .set('X-CSRF-Token', csrf)
    .send(body || {});

const get = (sid, csrf) => (path) =>
  request(app).get(path).set('Cookie', `sid=${sid}; csrf=${csrf}`);

describe('CSRF enforcement on POST routes', () => {
  it('rejects POST :endpoint without X-CSRF-Token', async () => {
    const r = await postNoCsrf(partnerSid, partnerCsrf)('/api/customer-b2/any-acct/b2_list_buckets');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/CSRF/i);
  });

  it('rejects POST s3_logging without X-CSRF-Token', async () => {
    const r = await postNoCsrf(partnerSid, partnerCsrf)('/api/customer-b2/any-acct/s3_logging', {
      bucketName: 'valid-bucket-name', bucketRegion: 'us-west-002', enabled: true, targetBucket: 'log-bucket',
    });
    expect(r.status).toBe(403);
  });

  it('accepts POST when CSRF cookie + header match (passes auth gate)', async () => {
    // The route will eventually fail at credential lookup since no stored
    // credential exists for 'any-acct'. The point: it gets PAST the CSRF gate.
    const r = await post(partnerSid, partnerCsrf)('/api/customer-b2/any-acct/b2_list_buckets');
    expect(r.status).not.toBe(403);
  });
});

describe('accountId ownership enforcement', () => {
  it('customer role: 403 on a different accountId', async () => {
    const r = await post(customerSid, customerCsrf)('/api/customer-b2/some-other-acct/b2_list_buckets');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Forbidden/);
  });

  it('customer role: own accountId is allowed past the auth gate', async () => {
    const r = await post(customerSid, customerCsrf)(`/api/customer-b2/${customerAccountId}/b2_list_buckets`);
    expect(r.status).not.toBe(403); // may 404 credential lookup, but not 403
  });

  it('partner staff: any accountId is allowed past the auth gate', async () => {
    const r = await post(partnerSid, partnerCsrf)('/api/customer-b2/anyone/b2_list_buckets');
    expect(r.status).not.toBe(403);
  });

  it('GET s3_logging: customer can\'t access another accountId', async () => {
    const r = await get(customerSid, customerCsrf)(
      '/api/customer-b2/some-other-acct/s3_logging?bucketName=foo-bar&bucketRegion=us-west-002'
    );
    expect(r.status).toBe(403);
  });
});

describe('bucketName / bucketRegion validation (SSRF surface)', () => {
  it('GET rejects missing bucketName', async () => {
    const r = await get(partnerSid, partnerCsrf)(
      `/api/customer-b2/${customerAccountId}/s3_logging?bucketRegion=us-west-002`
    );
    expect(r.status).toBe(400);
  });

  it('GET rejects malformed bucketName with dot injection', async () => {
    const r = await get(partnerSid, partnerCsrf)(
      `/api/customer-b2/${customerAccountId}/s3_logging?bucketName=bucket.evil.com&bucketRegion=us-west-002`
    );
    expect(r.status).toBe(400);
  });

  it('GET rejects unknown bucketRegion', async () => {
    const r = await get(partnerSid, partnerCsrf)(
      `/api/customer-b2/${customerAccountId}/s3_logging?bucketName=valid-bucket-name&bucketRegion=evil.attacker.com`
    );
    expect(r.status).toBe(400);
  });

  it('POST rejects malformed bucketName', async () => {
    const r = await post(partnerSid, partnerCsrf)(`/api/customer-b2/${customerAccountId}/s3_logging`, {
      bucketName: '../../etc', bucketRegion: 'us-west-002', enabled: false,
    });
    expect(r.status).toBe(400);
  });

  it('POST rejects targetBucket malformed when enabling logging', async () => {
    const r = await post(partnerSid, partnerCsrf)(`/api/customer-b2/${customerAccountId}/s3_logging`, {
      bucketName: 'valid-bucket-name', bucketRegion: 'us-west-002',
      enabled: true, targetBucket: 'has spaces',
    });
    expect(r.status).toBe(400);
  });
});

describe('endpoint allow-list', () => {
  it('rejects disallowed B2 endpoints', async () => {
    const r = await post(partnerSid, partnerCsrf)(`/api/customer-b2/${customerAccountId}/b2_cancel_large_file`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not allowed/);
  });

  it('allows the new CRUD write endpoints past the allow-list', async () => {
    for (const ep of ['b2_update_bucket', 'b2_delete_bucket', 'b2_create_key', 'b2_delete_key', 'b2_delete_file_version']) {
      const r = await post(partnerSid, partnerCsrf)(`/api/customer-b2/${customerAccountId}/${ep}`);
      // Not blocked by the allow-list (400 "not allowed"); fails later at cred lookup.
      expect(r.body.error || '').not.toMatch(/not allowed/);
    }
  });
});

describe('write role gate (customer_readonly cannot mutate)', () => {
  const writeEndpoints = ['b2_create_bucket', 'b2_update_bucket', 'b2_delete_bucket', 'b2_create_key', 'b2_delete_key', 'b2_delete_file_version'];

  it('customer_readonly: 403 read_only on every write endpoint (own account)', async () => {
    for (const ep of writeEndpoints) {
      const r = await post(readonlySid, readonlyCsrf)(`/api/customer-b2/${customerAccountId}/${ep}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('read_only');
    }
  });

  it('customer_readonly: reads are still allowed past the gate', async () => {
    const r = await post(readonlySid, readonlyCsrf)(`/api/customer-b2/${customerAccountId}/b2_list_buckets`);
    expect(r.status).not.toBe(403); // may 404 on cred lookup, but not gated
  });

  it('customer_readonly: 403 read_only on s3_logging (PutBucketLogging is a write)', async () => {
    const r = await post(readonlySid, readonlyCsrf)(`/api/customer-b2/${customerAccountId}/s3_logging`, {
      bucketName: 'valid-bucket-name', bucketRegion: 'us-west-002', enabled: false,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('read_only');
  });

  it('customer_admin: s3_logging passes the gate (own account)', async () => {
    const r = await post(customerSid, customerCsrf)(`/api/customer-b2/${customerAccountId}/s3_logging`, {
      bucketName: 'valid-bucket-name', bucketRegion: 'us-west-002', enabled: false,
    });
    expect(r.status).not.toBe(403); // 404 on cred lookup, but not gated
  });

  it('customer_admin: write endpoints pass the gate (own account)', async () => {
    const r = await post(customerSid, customerCsrf)(`/api/customer-b2/${customerAccountId}/b2_create_bucket`);
    expect(r.status).not.toBe(403);
  });

  it('partner staff: write endpoints pass the gate', async () => {
    const r = await post(partnerSid, partnerCsrf)(`/api/customer-b2/${customerAccountId}/b2_create_bucket`);
    expect(r.status).not.toBe(403);
  });
});
