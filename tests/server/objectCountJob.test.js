// Tests for the objectCountJob file-count ceiling.
//
// b2_list_file_names has no count endpoint, so bucket size is only discoverable
// by walking it. One real partner account holds 2.46e9 files across 36 buckets —
// ~2.46M sequential API calls against a job that reruns every 24h, plus a
// file_index row per file. The ceiling bounds that discovery and remembers the
// result so the cost is paid once.
//
// The credential vault is mocked so the job doesn't need real encrypted keys.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../../server/credentials.js', () => ({
  listCredentials: () => [{ account_id: 'acct-1', email: 'a@example.com', application_key_id: 'kid' }],
  getCredential: (id) => ({ account_id: id, email: 'a@example.com', application_key_id: 'kid' }),
  getDecryptedApplicationKey: () => 'secret',
}));

// Read at module load, so it has to be set before the dynamic import below.
process.env.OBJECT_INDEX_MAX_FILES = '2000';

const { db }   = await import('../../server/db.js');
const jobMod   = await import('../../server/jobs/objectCountJob.js');
const { runObjectCountJob, runForAccount, INDEX_STATUS_OK, INDEX_STATUS_TOO_BIG } = jobMod;

const BIG    = 'bucket-big';    // never runs out of pages
const SMALL  = 'bucket-small';  // one short page

let listCalls = {};

function page(n, startIndex) {
  return {
    files: Array.from({ length: n }, (_, i) => ({
      fileName:      `f-${startIndex + i}`,
      fileId:        `id-${startIndex + i}`,
      contentLength: 10,
      contentType:   'text/plain',
      uploadTimestamp: 1_700_000_000_000,
    })),
  };
}

globalThis.fetch = vi.fn(async (url, opts) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

  if (u.includes('b2_authorize_account')) {
    return json({
      authorizationToken: 'tok',
      accountId: 'acct-1',
      apiInfo: { storageApi: { apiUrl: 'https://api.example.com' } },
    });
  }
  if (u.includes('b2_list_buckets')) {
    return json({ buckets: [
      { bucketId: BIG,   bucketName: 'big' },
      { bucketId: SMALL, bucketName: 'small' },
    ] });
  }
  if (u.includes('b2_list_file_names')) {
    const body = JSON.parse(opts.body);
    listCalls[body.bucketId] = (listCalls[body.bucketId] || 0) + 1;
    const nth = listCalls[body.bucketId];
    if (body.bucketId === SMALL) return json({ ...page(3, 0), nextFileName: null });
    // BIG: 1000 per page, always another page to come.
    return json({ ...page(1000, nth * 1000), nextFileName: `f-${nth * 1000 + 1000}` });
  }
  throw new Error(`unexpected fetch: ${u}`);
});

const rowFor = (bucketId) =>
  db.prepare('SELECT * FROM object_counts WHERE bucket_id = ?').get(bucketId);
const indexedFiles = (bucketId) =>
  db.prepare('SELECT COUNT(*) AS n FROM file_index WHERE bucket_id = ?').get(bucketId).n;

beforeEach(() => {
  listCalls = {};
  db.prepare('DELETE FROM object_counts').run();
  db.prepare('DELETE FROM file_index').run();
});

afterAll(() => { delete process.env.OBJECT_INDEX_MAX_FILES; });

describe('bucket under the ceiling', () => {
  it('walks and indexes normally', async () => {
    await runObjectCountJob();
    const row = rowFor(SMALL);
    expect(row.index_status).toBe(INDEX_STATUS_OK);
    expect(row.object_count).toBe(3);
    expect(row.total_bytes).toBe(30);
    expect(indexedFiles(SMALL)).toBe(3);
  });
});

describe('bucket over the ceiling', () => {
  it('abandons the walk instead of paginating forever', async () => {
    await runObjectCountJob();
    // 1000, 2000, 3000 — bails on the first page that crosses 2000.
    expect(listCalls[BIG]).toBe(3);
  });

  it('records it as skipped with zeroed counts', async () => {
    await runObjectCountJob();
    const row = rowFor(BIG);
    expect(row.index_status).toBe(INDEX_STATUS_TOO_BIG);
    // Zeroed on purpose: the read path falls through to the Usage CSV /
    // Partner API rather than billing against a partial walk.
    expect(row.object_count).toBe(0);
    expect(row.total_bytes).toBe(0);
  });

  it('drops the partial index rather than leaving a truncated one', async () => {
    await runObjectCountJob();
    expect(indexedFiles(BIG)).toBe(0);
  });

  it('costs nothing on the next scheduled run', async () => {
    await runObjectCountJob();
    expect(listCalls[BIG]).toBe(3);

    listCalls = {};
    await runObjectCountJob();
    expect(listCalls[BIG]).toBeUndefined();   // never listed again
    expect(listCalls[SMALL]).toBe(1);         // the small one still refreshes
  });

  it('does not stop the other buckets on the account from indexing', async () => {
    await runObjectCountJob();
    expect(rowFor(SMALL).index_status).toBe(INDEX_STATUS_OK);
    expect(indexedFiles(SMALL)).toBe(3);
  });
});

describe('on-demand refresh', () => {
  it('retries a skipped bucket, since a human asked', async () => {
    await runObjectCountJob();
    expect(rowFor(BIG).index_status).toBe(INDEX_STATUS_TOO_BIG);

    listCalls = {};
    await runForAccount('acct-1');
    expect(listCalls[BIG]).toBe(3); // walked again rather than silently skipped
  });
});
