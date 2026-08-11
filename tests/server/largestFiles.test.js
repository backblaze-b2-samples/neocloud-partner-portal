// Tests for the largest_files_in_bucket MCP tool (ranking + account scoping).
// Seeds throwaway rows in file_index / object_counts and cleans them up.
process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key-unit-test-key-unit-test-32';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../server/db.js';
import { runLargestFilesTool } from '../../server/mcp/usageInsights.js';

const BID = 'test-bkt-largest-001';
const BNAME = 'test-largest-bucket';
const ACCT = 'test-acct-largest';
const now = '2026-06-26T00:00:00.000Z';

const staff = { user: { id: 1, role: 'admin', accountId: null } };
const owner = { user: { id: 2, role: 'customer_admin', accountId: ACCT } };
const other = { user: { id: 3, role: 'customer_admin', accountId: 'someone-else' } };

const ALL_BIDS = [BID, 'fz-alpha', 'fz-beta'];
const cleanup = () => {
  for (const id of ALL_BIDS) {
    db.prepare('DELETE FROM file_index WHERE bucket_id = ?').run(id);
    db.prepare('DELETE FROM object_counts WHERE bucket_id = ?').run(id);
  }
};

beforeAll(() => {
  cleanup();
  const oc = db.prepare('INSERT INTO object_counts (bucket_id, account_id, bucket_name, object_count, counted_at, updated_at) VALUES (?,?,?,?,?,?)');
  oc.run(BID, ACCT, BNAME, 3, now, now);
  oc.run('fz-alpha', ACCT, 'fuzzy-alpha-bkt', 1, now, now);
  oc.run('fz-beta', ACCT, 'fuzzy-beta-bkt', 1, now, now);
  const ins = db.prepare('INSERT INTO file_index (bucket_id, file_name, file_id, size, uploaded_at, content_type, indexed_at) VALUES (?,?,?,?,?,?,?)');
  ins.run(BID, 'checkpoints/small.bin', 'f1', 1_000, now, 'application/octet-stream', now);
  ins.run(BID, 'checkpoints/huge.pt',  'f2', 5_000_000_000, now, 'application/octet-stream', now);
  ins.run(BID, 'logs/medium.log',      'f3', 2_000_000, now, 'text/plain', now);
  ins.run('fz-alpha', 'data/file.bin', 'fa1', 123, now, 'application/octet-stream', now);
});

afterAll(cleanup);

describe('runLargestFilesTool', () => {
  it('returns files largest-first, resolving bucket by name', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: BNAME, limit: 10 } }));
    expect(out.ok).toBe(true);
    expect(out.bucket).toBe(BNAME);
    expect(out.bucket_id).toBe(BID);
    expect(out.files.map((f) => f.name)).toEqual([
      'checkpoints/huge.pt', 'logs/medium.log', 'checkpoints/small.bin',
    ]);
    expect(out.files[0].size_bytes).toBe(5_000_000_000);
    expect(out.files[0].size).toMatch(/GB/);
  });

  it('honors limit', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: BID, limit: 1 } }));
    expect(out.files).toHaveLength(1);
    expect(out.files[0].name).toBe('checkpoints/huge.pt');
  });

  it('filters by prefix', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: BNAME, prefix: 'logs/' } }));
    expect(out.files.map((f) => f.name)).toEqual(['logs/medium.log']);
  });

  it('lets the owning customer inspect their own bucket', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: owner, input: { bucket: BNAME } }));
    expect(out.ok).toBe(true);
    expect(out.files.length).toBe(3);
  });

  it('denies a customer querying a bucket outside their account (scope)', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: other, input: { bucket: BNAME } }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/scope/i);
  });

  it('resolves a unique partial (fuzzy) bucket name', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: 'alpha' } }));
    expect(out.ok).toBe(true);
    expect(out.bucket).toBe('fuzzy-alpha-bkt');
  });

  it('returns candidates for an ambiguous partial name instead of guessing', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: 'fuzzy' } }));
    expect(out.ok).toBe(false);
    expect(out.candidates).toEqual(expect.arrayContaining(['fuzzy-alpha-bkt', 'fuzzy-beta-bkt']));
  });

  it('reports when a bucket is not indexed', async () => {
    const out = JSON.parse(await runLargestFilesTool({ session: staff, input: { bucket: 'no-such-bucket-xyz' } }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not been indexed|unavailable/i);
  });
});
