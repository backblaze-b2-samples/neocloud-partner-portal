// Tests for the per-customer object count in src/data/customers.js — the demo
// derivation from BUCKETS, the null-vs-zero distinction, and aggregate() totals.
import { describe, it, expect } from 'vitest';
import { CUSTOMERS, aggregate } from '../../src/data/customers.js';
import { BUCKETS } from '../../src/data/buckets.js';

const byId = (id) => CUSTOMERS.find((c) => c.id === id);

describe('demo object-count derivation', () => {
  it('gives every customer an objectCount field', () => {
    for (const c of CUSTOMERS) {
      expect(c).toHaveProperty('objectCount');
    }
  });

  it('sums the objectCount of the buckets a customer owns', () => {
    // Lumora AI owns two buckets in the demo data.
    const expected = BUCKETS
      .filter((b) => b.customerId === 'sub-7f3a91')
      .reduce((s, b) => s + b.objectCount, 0);
    expect(expected).toBeGreaterThan(0);
    expect(byId('sub-7f3a91').objectCount).toBe(expected);
  });

  it('matches a per-customer bucket sum for every customer that owns buckets', () => {
    const owners = new Set(BUCKETS.map((b) => b.customerId));
    for (const id of owners) {
      const expected = BUCKETS
        .filter((b) => b.customerId === id)
        .reduce((s, b) => s + (b.objectCount || 0), 0);
      expect(byId(id)?.objectCount).toBe(expected);
    }
  });

  it('is null — not 0 — for a customer that owns no buckets', () => {
    const owners = new Set(BUCKETS.map((b) => b.customerId));
    const orphans = CUSTOMERS.filter((c) => !owners.has(c.id));
    expect(orphans.length).toBeGreaterThan(0); // guard: the fixture still has some
    for (const c of orphans) {
      expect(c.objectCount).toBeNull();
    }
  });

  it('totals across all customers equal the total across all buckets', () => {
    const fromBuckets = BUCKETS.reduce((s, b) => s + (b.objectCount || 0), 0);
    const fromCustomers = CUSTOMERS.reduce((s, c) => s + (c.objectCount || 0), 0);
    expect(fromCustomers).toBe(fromBuckets);
  });
});

describe('aggregate() object counts', () => {
  it('rolls objectCount into the totals', () => {
    const totals = aggregate(CUSTOMERS);
    const expected = CUSTOMERS.reduce((s, c) => s + (c.objectCount || 0), 0);
    expect(totals.objectCount).toBe(expected);
  });

  it('coerces null objectCount without producing NaN', () => {
    const totals = aggregate([
      { objectCount: null },
      { objectCount: 5 },
      { objectCount: undefined },
    ]);
    expect(totals.objectCount).toBe(5);
    expect(Number.isNaN(totals.objectCount)).toBe(false);
  });

  it('returns 0 for an empty customer list', () => {
    expect(aggregate([]).objectCount).toBe(0);
  });
});
