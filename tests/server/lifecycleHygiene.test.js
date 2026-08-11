// Tests for the bucket_lifecycle_hygiene tool (stale-data detection + scope).
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-32';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../server/db.js';
import { runLifecycleHygieneTool } from '../../server/mcp/usageInsights.js';

const BID = 'test-hyg-bkt-001';
const BNAME = 'hygiene-bucket';
const ACCT = 'test-hyg-acct';
const nowIso = new Date().toISOString();
const oldIso = '2020-01-01T00:00:00.000Z';

const staff = { user: { id: 1, role: 'admin', accountId: null } };
const owner = { user: { id: 2, role: 'customer_admin', accountId: ACCT } };
const other = { user: { id: 3, role: 'customer_admin', accountId: 'someone-else' } };

const cleanup = () => {
  db.prepare('DELETE FROM file_index WHERE bucket_id = ?').run(BID);
  db.prepare('DELETE FROM object_counts WHERE bucket_id = ?').run(BID);
};

beforeAll(() => {
  cleanup();
  db.prepare('INSERT INTO object_counts (bucket_id, account_id, bucket_name, object_count, counted_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(BID, ACCT, BNAME, 3, nowIso, nowIso);
  const ins = db.prepare('INSERT INTO file_index (bucket_id, file_name, file_id, size, uploaded_at, content_type, indexed_at) VALUES (?,?,?,?,?,?,?)');
  ins.run(BID, 'old/a.bin', 'f1', 1_000, oldIso, 'application/octet-stream', nowIso);  // stale
  ins.run(BID, 'old/b.bin', 'f2', 3_000, oldIso, 'application/octet-stream', nowIso);  // stale
  ins.run(BID, 'fresh/c.bin', 'f3', 500, nowIso, 'application/octet-stream', nowIso);  // not stale
});

afterAll(cleanup);

describe('runLifecycleHygiene', () => {
  it('flags a bucket and reports its stale objects/bytes/share', async () => {
    const out = JSON.parse(await runLifecycleHygieneTool({ session: staff, input: { days: 90, limit: 50 } }));
    expect(out.ok).toBe(true);
    const b = out.buckets.find((x) => x.bucket === BNAME);
    expect(b).toBeTruthy();
    expect(b.objects).toBe(3);
    expect(b.stale_objects).toBe(2);
    expect(b.stale_share_pct).toBeCloseTo(88.9, 0); // 4000 / 4500
    expect(b.oldest_object).toBe(oldIso);
  });

  it('reports nothing stale when the threshold is older than every object', async () => {
    // days=3650 → cutoff ≈ 10 years ago; the 2020 objects are newer than that,
    // so none count as stale.
    const out = JSON.parse(await runLifecycleHygieneTool({ session: owner, input: { days: 3650 } }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/older than/i);
  });

  it('only shows the owning customer their own bucket (scope)', async () => {
    const ownerOut = JSON.parse(await runLifecycleHygieneTool({ session: owner, input: {} }));
    expect(ownerOut.ok).toBe(true);
    expect(ownerOut.buckets.some((b) => b.bucket === BNAME)).toBe(true);

    const otherOut = JSON.parse(await runLifecycleHygieneTool({ session: other, input: {} }));
    expect(otherOut.ok).toBe(false); // no buckets in their scope
  });
});
