// Tests for aggregateObjectCounts — the roll-up that feeds a customer's storage
// figure, and therefore their revenue.
//
// The index job abandons buckets over a file-count ceiling and records them with
// zeroed counts. An account can hold a mix of walked and skipped buckets, and
// summing that mix would present a fraction of the account as its total.
import { describe, it, expect } from 'vitest';
import { aggregateObjectCounts } from '../../src/api/partnerApi.js';

const counts = (rows) => new Map(rows.map((r) => [r.bucketId, r]));

describe('aggregateObjectCounts', () => {
  it('sums buckets per account', () => {
    const { bytesByAccount, objectsByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', accountId: 'a', count: 10, totalBytes: 100, indexStatus: 'indexed' },
      { bucketId: 'b2', accountId: 'a', count: 5,  totalBytes: 50,  indexStatus: 'indexed' },
      { bucketId: 'b3', accountId: 'b', count: 7,  totalBytes: 70,  indexStatus: 'indexed' },
    ]));
    expect(bytesByAccount.get('a')).toBe(150);
    expect(objectsByAccount.get('a')).toBe(15);
    expect(bytesByAccount.get('b')).toBe(70);
  });

  it('treats a missing indexStatus as indexed, for rows written before the ceiling existed', () => {
    const { bytesByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', accountId: 'a', count: 10, totalBytes: 100 },
    ]));
    expect(bytesByAccount.get('a')).toBe(100);
  });

  it('omits an account entirely when any of its buckets was skipped', () => {
    const { bytesByAccount, objectsByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', accountId: 'a', count: 10, totalBytes: 100, indexStatus: 'indexed' },
      { bucketId: 'b2', accountId: 'a', count: 0,  totalBytes: 0,   indexStatus: 'skipped_too_large' },
    ]));
    // Not 100 — that would report one walked bucket as the whole account.
    expect(bytesByAccount.has('a')).toBe(false);
    expect(objectsByAccount.has('a')).toBe(false);
  });

  it('omits the account regardless of which bucket came first', () => {
    const { bytesByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', accountId: 'a', count: 0,  totalBytes: 0,   indexStatus: 'skipped_too_large' },
      { bucketId: 'b2', accountId: 'a', count: 10, totalBytes: 100, indexStatus: 'indexed' },
    ]));
    expect(bytesByAccount.has('a')).toBe(false);
  });

  it('leaves other accounts untouched when one is partial', () => {
    const { bytesByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', accountId: 'big',   count: 0, totalBytes: 0,  indexStatus: 'skipped_too_large' },
      { bucketId: 'b2', accountId: 'small', count: 4, totalBytes: 40, indexStatus: 'indexed' },
    ]));
    expect(bytesByAccount.has('big')).toBe(false);
    expect(bytesByAccount.get('small')).toBe(40);
  });

  it('ignores rows with no accountId', () => {
    const { bytesByAccount } = aggregateObjectCounts(counts([
      { bucketId: 'b1', count: 10, totalBytes: 100, indexStatus: 'indexed' },
    ]));
    expect(bytesByAccount.size).toBe(0);
  });

  it('returns empty maps for no data', () => {
    const { bytesByAccount, objectsByAccount } = aggregateObjectCounts(new Map());
    expect(bytesByAccount.size).toBe(0);
    expect(objectsByAccount.size).toBe(0);
  });
});
