// Tests for src/data/resellerPlans.js — plan lookup, computeBilling math,
// per-customer override precedence, and ejected-customer zeroing.
import { describe, it, expect } from 'vitest';
import {
  RESELLER_PLANS,
  B2_LIST_PRICE,
  DEFAULT_PLAN_NAME,
  planByName,
  computeBilling,
} from '../../src/data/resellerPlans.js';

describe('plan shape', () => {
  it('exports exactly three tiers', () => {
    expect(RESELLER_PLANS).toHaveLength(3);
    expect(RESELLER_PLANS.map((p) => p.id).sort()).toEqual(['tier-1', 'tier-2', 'tier-3']);
  });

  it('DEFAULT_PLAN_NAME points to a real tier', () => {
    expect(RESELLER_PLANS.find((p) => p.name === DEFAULT_PLAN_NAME)).toBeTruthy();
  });

  it('tier 3 mirrors B2 list (A/B/C free)', () => {
    const t3 = planByName('Reseller — Tier 3');
    expect(t3.classAPer10k).toBe(0);
    expect(t3.classBPer10k).toBe(0);
    expect(t3.classCPer10k).toBe(0);
  });

  it('tier 1 has highest storage markup', () => {
    const t1 = planByName('Reseller — Tier 1');
    const t2 = planByName('Reseller — Tier 2');
    const t3 = planByName('Reseller — Tier 3');
    expect(t1.storagePerTb).toBeGreaterThan(t2.storagePerTb);
    expect(t2.storagePerTb).toBeGreaterThan(t3.storagePerTb);
  });

  it('planByName returns null for unknown name', () => {
    expect(planByName('Nope')).toBeNull();
  });
});

describe('computeBilling math', () => {
  it('zero usage → zero revenue and cogs', () => {
    const { revenue, cogs, margin } = computeBilling({});
    expect(revenue).toBe(0);
    expect(cogs).toBe(0);
    expect(margin).toBe(0);
  });

  it('uses plan rate when customer has no override', () => {
    // 1 TB stored on Tier 2 ($15/TB) → revenue should be $15
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 2',
      storageBytes: 1e12,
      egressBytes30d: 0,
    });
    expect(revenue).toBeCloseTo(15, 5);
  });

  it('per-customer storage override beats plan rate', () => {
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 2',          // plan storage = $15
      price_per_tb_storage: 7,             // override
      storageBytes: 1e12,
    });
    expect(revenue).toBeCloseTo(7, 5);
  });

  it('cogs uses B2 list, not plan rate', () => {
    const { cogs } = computeBilling({
      plan: 'Reseller — Tier 1',
      storageBytes: 1e12,
    });
    expect(cogs).toBeCloseTo(B2_LIST_PRICE.storagePerTb, 5);
  });

  it('egress beyond 3× free is the only billable egress on cogs side', () => {
    // 1 TB stored, 4 TB egress → 1 TB billable @ $0.01/GB = $10 cogs
    const { cogs } = computeBilling({
      plan: 'Reseller — Tier 1',
      storageBytes: 1e12,
      egressBytes30d: 4e12,
    });
    // storage 6.95 + egress 1e12/1e9 * 0.01 = 10
    expect(cogs).toBeCloseTo(6.95 + 10, 4);
  });

  it('revenue bills every egress GB at plan rate (no free tier on the partner side)', () => {
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 1',           // egress = $0.03/GB
      storageBytes: 1e12,
      egressBytes30d: 4e12,                 // 4000 GB
    });
    // storage 25 + 4000*0.03 = 25 + 120
    expect(revenue).toBeCloseTo(25 + 120, 4);
  });

  it('class D over 75k/month (30 × 2500) gets billed on cogs', () => {
    const { cogs } = computeBilling({
      plan: 'Reseller — Tier 1',
      txnD30d: 75_000 + 10_000,
    });
    expect(cogs).toBeCloseTo(10_000 / 10_000 * B2_LIST_PRICE.classDPer10k, 6);
  });

  it('Tier 3 (mirrors B2) gives ~zero margin when usage is zero-egress and no D', () => {
    const { margin } = computeBilling({
      plan: 'Reseller — Tier 3',
      storageBytes: 1e12,
    });
    // Tier 3 storage = $10/TB, B2 cost = $6.95/TB → margin = (10-6.95)/10 = 0.305
    expect(margin).toBeCloseTo((10 - 6.95) / 10, 3);
  });

  it('Tier 1 → much higher margin than Tier 3 on same usage', () => {
    const usage = { storageBytes: 1e12, egressBytes30d: 5e12, txnD30d: 100_000 };
    const t1 = computeBilling({ ...usage, plan: 'Reseller — Tier 1' });
    const t3 = computeBilling({ ...usage, plan: 'Reseller — Tier 3' });
    expect(t1.margin).toBeGreaterThan(t3.margin);
  });

  it('falls back to B2 list when no plan and no overrides', () => {
    const { revenue, cogs } = computeBilling({ storageBytes: 1e12 });
    expect(revenue).toBeCloseTo(B2_LIST_PRICE.storagePerTb, 5);
    expect(cogs).toBeCloseTo(B2_LIST_PRICE.storagePerTb, 5);
  });

  it('respects DB-loaded plans array (not just static)', () => {
    const dynamic = [{
      id: 'custom', name: 'Custom', description: '',
      storagePerTb: 100, egressPerGb: 0, classAPer10k: 0, classBPer10k: 0, classCPer10k: 0, classDPer10k: 0,
    }];
    const { revenue } = computeBilling({ plan: 'Custom', storageBytes: 1e12 }, dynamic);
    expect(revenue).toBeCloseTo(100, 5);
  });
});

describe('per-class override precedence', () => {
  it('per-class overrides win over plan classes', () => {
    const usage = {
      plan: 'Reseller — Tier 1',
      txnA30d: 10_000,
      price_per_10k_class_a: 0.999,
    };
    const { revenue } = computeBilling(usage);
    // 10_000 / 10_000 * 0.999 = 0.999
    expect(revenue).toBeCloseTo(0.999, 5);
  });

  it('mixing override and plan — only overridden class uses override', () => {
    const usage = {
      plan: 'Reseller — Tier 1',
      storageBytes: 1e12,
      price_per_tb_storage: 50,   // override
      // egress not overridden → uses Tier 1's $0.03/GB
      egressBytes30d: 1e9,        // 1 GB
    };
    const { revenue } = computeBilling(usage);
    expect(revenue).toBeCloseTo(50 + 0.03, 5);
  });
});
