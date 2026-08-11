// Tests for the pure egress-leaders ranking behind the MCP egress tool.

import { describe, it, expect } from 'vitest';
import { computeEgressLeaders } from '../../server/mcp/usageInsights.js';

const row = (accountId, bucketId, bucketName, egressBytes, extra = {}) => ({
  accountId, bucketId, bucketName, egressBytes, uploadBytes: 0, classCTxn: 0, ...extra,
});

describe('computeEgressLeaders', () => {
  it('ranks accounts by total egress, descending', () => {
    const rows = [
      row('A', 'b1', 'a-one', 100), row('A', 'b2', 'a-two', 50), // A = 150
      row('B', 'b3', 'b-one', 400),                              // B = 400
      row('C', 'b4', 'c-one', 10),                               // C = 10
    ];
    const out = computeEgressLeaders(rows, { by: 'account' });
    expect(out.map((g) => g.key)).toEqual(['B', 'A', 'C']);
    expect(out[1].egress).toBe(150); // A summed across buckets
  });

  it('can rank by bucket', () => {
    const rows = [
      row('A', 'b1', 'a-one', 100), row('A', 'b1', 'a-one', 100), // bucket b1 = 200
      row('A', 'b2', 'a-two', 150),                               // bucket b2 = 150
    ];
    const out = computeEgressLeaders(rows, { by: 'bucket' });
    expect(out[0].key).toBe('b1');
    expect(out[0].egress).toBe(200);
    expect(out[0].bucketName).toBe('a-one');
  });

  it('sums upload and class-C transactions alongside egress', () => {
    const rows = [
      row('A', 'b1', 'a', 100, { uploadBytes: 7, classCTxn: 2 }),
      row('A', 'b1', 'a', 100, { uploadBytes: 3, classCTxn: 5 }),
    ];
    const [a] = computeEgressLeaders(rows, { by: 'account' });
    expect(a.egress).toBe(200);
    expect(a.upload).toBe(10);
    expect(a.txnC).toBe(7);
  });

  it('ignores rows with no key and handles empty input', () => {
    expect(computeEgressLeaders([])).toEqual([]);
    const out = computeEgressLeaders([row(null, 'b', 'x', 100), row('A', 'b', 'x', 5)], { by: 'account' });
    expect(out).toHaveLength(1);
    expect(out[0].egress).toBe(5);
  });
});
