// Tests for the pure account-growth computation behind the MCP usage tool.

import { describe, it, expect } from 'vitest';
import { computeAccountGrowth } from '../../server/mcp/usageInsights.js';

// Helper: one report row.
const row = (accountId, _date, storageBytes, extra = {}) => ({
  accountId, _date, storageBytes,
  egressBytes: 0, uploadBytes: 0, classCTxn: 0, ...extra,
});

describe('computeAccountGrowth', () => {
  it('computes first-vs-last growth per account, summing buckets per day', () => {
    const rows = [
      // acct A: two buckets on day 1 (sum 100), grows to 300 by day 3
      row('A', '2026-06-01', 60), row('A', '2026-06-01', 40),
      row('A', '2026-06-03', 200), row('A', '2026-06-03', 100),
      // acct B: shrinks 500 -> 400
      row('B', '2026-06-01', 500),
      row('B', '2026-06-02', 400),
    ];
    const out = computeAccountGrowth(rows);
    const a = out.find((x) => x.accountId === 'A');
    const b = out.find((x) => x.accountId === 'B');

    expect(a.firstBytes).toBe(100);
    expect(a.lastBytes).toBe(300);
    expect(a.growthBytes).toBe(200);
    expect(a.growthPct).toBe(200); // +200%
    expect(a.dataPoints).toBe(2);

    expect(b.growthBytes).toBe(-100);
    expect(b.growthPct).toBe(-20);
  });

  it('sorts by absolute growth descending', () => {
    const rows = [
      row('small', '2026-06-01', 10), row('small', '2026-06-02', 20),
      row('big', '2026-06-01', 10), row('big', '2026-06-02', 1000),
    ];
    const out = computeAccountGrowth(rows);
    expect(out[0].accountId).toBe('big');
    expect(out[1].accountId).toBe('small');
  });

  it('returns null growthPct when the account started at zero stored bytes', () => {
    const rows = [
      row('new', '2026-06-01', 0),
      row('new', '2026-06-05', 5000),
    ];
    const [acct] = computeAccountGrowth(rows);
    expect(acct.firstBytes).toBe(0);
    expect(acct.lastBytes).toBe(5000);
    expect(acct.growthBytes).toBe(5000);
    expect(acct.growthPct).toBeNull();
  });

  it('sums egress and class-C transactions over the window', () => {
    const rows = [
      row('A', '2026-06-01', 100, { egressBytes: 10, classCTxn: 3 }),
      row('A', '2026-06-02', 100, { egressBytes: 5, classCTxn: 7 }),
    ];
    const [a] = computeAccountGrowth(rows);
    expect(a.egressBytes).toBe(15);
    expect(a.classCTxn).toBe(10);
  });

  it('ignores rows with no accountId or date, and handles empty input', () => {
    expect(computeAccountGrowth([])).toEqual([]);
    const out = computeAccountGrowth([
      row(null, '2026-06-01', 100),
      row('A', null, 100),
      row('A', '2026-06-01', 50),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].lastBytes).toBe(50);
  });
});
