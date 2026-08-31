// Tests for src/data/resellerPlans.js — plan lookup, computeBilling math,
// per-customer override precedence, and ejected-customer zeroing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RESELLER_PLANS,
  B2_LIST_PRICE,
  DEFAULT_PLAN_NAME,
  planByName,
  planForGroup,
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

describe('storage override units', () => {
  it('per-GB override (the column the UI actually writes) beats the plan rate', () => {
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 2',       // plan storage = $15/TB
      price_per_gb_storage: 0.02,      // $0.02/GB = $20/TB
      storageBytes: 1e12,
    });
    expect(revenue).toBeCloseTo(20, 5);
  });

  it('per-TB override wins when both forms are present', () => {
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 2',
      price_per_tb_storage: 7,
      price_per_gb_storage: 0.02,
      storageBytes: 1e12,
    });
    expect(revenue).toBeCloseTo(7, 5);
  });

  it('a zero per-GB override means free, not "unset"', () => {
    const { revenue } = computeBilling({
      plan: 'Reseller — Tier 1',
      price_per_gb_storage: 0,
      storageBytes: 1e12,
    });
    expect(revenue).toBeCloseTo(0, 5);
  });

  it('no override → plan rate, unaffected by the per-GB path', () => {
    const { revenue } = computeBilling({ plan: 'Reseller — Tier 1', storageBytes: 1e12 });
    expect(revenue).toBeCloseTo(25, 5);
  });
});

// ---------------------------------------------------------------------------
// Group pinning + transaction-rate overrides. Aylo prices per B2 group
// ("Hot" / "Cool"), so the plan a member bills at has to be derivable from its
// group rather than typed onto each account.
// ---------------------------------------------------------------------------
describe('planForGroup', () => {
  const PINNED = [
    { ...RESELLER_PLANS[0], name: 'Hot',  groupId: '166701', storagePerTb: 3.42 },
    { ...RESELLER_PLANS[1], name: 'Cool', groupId: '166702', storagePerTb: 2.10 },
    { ...RESELLER_PLANS[2], name: 'Unpinned', groupId: null },
  ];

  it('resolves a plan from its pinned group id', () => {
    expect(planForGroup('166701', PINNED).name).toBe('Hot');
    expect(planForGroup('166702', PINNED).name).toBe('Cool');
  });

  it('matches across string/number group ids', () => {
    expect(planForGroup(166701, PINNED).name).toBe('Hot');
  });

  it('returns null for an unpinned or unknown group', () => {
    expect(planForGroup('999999', PINNED)).toBeNull();
    expect(planForGroup(null, PINNED)).toBeNull();
    expect(planForGroup('', PINNED)).toBeNull();
  });

  it('never matches the plans that carry no groupId', () => {
    expect(planForGroup(undefined, PINNED)).toBeNull();
  });
});

describe('per-customer transaction overrides reach billing', () => {
  const plans = [{
    ...RESELLER_PLANS[0], name: 'Hot', storagePerTb: 3.42, egressPerGb: 0.01,
    classAPer10k: 0.004, classBPer10k: 0.004, classCPer10k: 0.002, classDPer10k: 0.012,
  }];
  const base = {
    plan: 'Hot',
    storageBytes: 0,
    egressBytes30d: 0,
    txnA30d: 10_000, txnB30d: 10_000, txnC30d: 10_000, txnD30d: 10_000,
  };

  it('bills transactions at the plan rate when no override is set', () => {
    const { revenue } = computeBilling(base, plans);
    expect(revenue).toBeCloseTo(0.004 + 0.004 + 0.002 + 0.012, 10);
  });

  it('each class override wins over the plan rate independently', () => {
    const { revenue } = computeBilling({
      ...base,
      price_per_10k_class_a: 0.001,
      price_per_10k_class_c: 0.005,
    }, plans);
    expect(revenue).toBeCloseTo(0.001 + 0.004 + 0.005 + 0.012, 10);
  });

  it('an override of zero is honoured, not treated as unset', () => {
    const { revenue } = computeBilling({
      ...base,
      price_per_10k_class_a: 0,
      price_per_10k_class_b: 0,
      price_per_10k_class_c: 0,
      price_per_10k_class_d: 0,
    }, plans);
    expect(revenue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getResellerPlans: a catalog the operator emptied on purpose is not the same
// thing as an unreachable endpoint. Answering the first with the sample tiers
// would invent prices nobody set.
// ---------------------------------------------------------------------------
describe('getResellerPlans empty vs failed', () => {
  let getResellerPlans, api;

  beforeEach(async () => {
    vi.resetModules();
    api = (await import('../../src/lib/apiClient.js')).api;
    ({ getResellerPlans } = await import('../../src/api/partnerApi.js'));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the operator catalog when there is one', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ plans: [{ id: 'p1', name: 'Aylo Hot', storagePerTb: 3.42 }] });
    const plans = await getResellerPlans();
    expect(plans.map((p) => p.name)).toEqual(['Aylo Hot']);
  });

  it('returns empty for a successful empty response, not the sample tiers', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ plans: [] });
    expect(await getResellerPlans()).toEqual([]);
  });

  it('falls back to the static defaults when the request fails', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('network down'));
    expect(await getResellerPlans()).toEqual(RESELLER_PLANS);
  });

  it('falls back when the response has no plans key at all', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({});
    expect(await getResellerPlans()).toEqual(RESELLER_PLANS);
  });
});

// ---------------------------------------------------------------------------
// COGS is a separate axis from price. Storage cost is negotiated per B2 partner
// group and arrives as costPerTbStorage; a partner at petabyte scale does not
// pay list, and costing them at list makes every margin figure wrong.
// ---------------------------------------------------------------------------
describe('group-negotiated storage cost', () => {
  const oneTb = { storageBytes: 1e12, plan: 'Reseller — Tier 1' }; // $25/TB revenue

  it('falls back to B2 list when the group has no negotiated rate', () => {
    const { cogs } = computeBilling(oneTb);
    expect(cogs).toBeCloseTo(B2_LIST_PRICE.storagePerTb, 10);
  });

  it('uses the group rate when one is set', () => {
    const { cogs } = computeBilling({ ...oneTb, costPerTbStorage: 3.42 });
    expect(cogs).toBeCloseTo(3.42, 10);
  });

  it('honours a zero cost rather than treating it as unset', () => {
    const { cogs } = computeBilling({ ...oneTb, costPerTbStorage: 0 });
    expect(cogs).toBe(0);
  });

  it('widens margin relative to costing at list', () => {
    const atList = computeBilling(oneTb);
    const atCost = computeBilling({ ...oneTb, costPerTbStorage: 3.42 });
    expect(atCost.revenue).toBe(atList.revenue);       // price is unchanged
    expect(atCost.margin).toBeGreaterThan(atList.margin);
  });

  it('reproduces the Aylo shape: below-list cost turns a loss into a margin', () => {
    // Cool: 2.10/TB cost. If the same 2.10 were read as the sell price while
    // cost stayed at list, margin would be deeply negative — the misreading
    // this separation exists to prevent.
    const asPrice = computeBilling({ storageBytes: 1e15, price_per_gb_storage: 2.10 / 1000 });
    expect(asPrice.margin).toBeLessThan(0);

    const asCost = computeBilling({
      storageBytes: 1e15,
      price_per_gb_storage: 6 / 1000,   // what they charge
      costPerTbStorage: 2.10,           // what they pay
    });
    expect(asCost.margin).toBeGreaterThan(0);
  });

  it('leaves egress and Class D COGS at B2 list', () => {
    // 1 TB stored gives 3 TB free egress; 4 TB egress leaves 1 TB billable.
    const { cogs } = computeBilling({
      storageBytes: 1e12, egressBytes30d: 4e12, costPerTbStorage: 0,
    });
    expect(cogs).toBeCloseTo(1000 * B2_LIST_PRICE.egressPerGb, 6);
  });
});

// ---------------------------------------------------------------------------
// Class A/B/C are free at B2 list, so a partner who has negotiated a rate for
// them is paying something the portal previously treated as costless.
// ---------------------------------------------------------------------------
describe('group-negotiated transaction costs', () => {
  const txns = { txnA30d: 10_000, txnB30d: 10_000, txnC30d: 10_000 };

  it('costs Class A/B/C at zero by default, matching B2 list', () => {
    const { cogs } = computeBilling({ ...txns, costPerTbStorage: 0 });
    expect(cogs).toBe(0);
  });

  it('adds each negotiated class rate to COGS', () => {
    const { cogs } = computeBilling({
      ...txns,
      costPerTbStorage: 0,
      costPer10kClassA: 0.002,
      costPer10kClassB: 0.0015,
      costPer10kClassC: 0.001,
    });
    expect(cogs).toBeCloseTo(0.002 + 0.0015 + 0.001, 10);
  });

  it('treats each class independently — an unset one stays at list', () => {
    const { cogs } = computeBilling({ ...txns, costPerTbStorage: 0, costPer10kClassB: 0.0015 });
    expect(cogs).toBeCloseTo(0.0015, 10);
  });

  it('leaves revenue untouched — these are cost, not price', () => {
    const plans = [{ id: 'p', name: 'P', storagePerTb: 0, egressPerGb: 0,
      classAPer10k: 0.004, classBPer10k: 0, classCPer10k: 0, classDPer10k: 0 }];
    const base = { ...txns, plan: 'P', costPerTbStorage: 0 };
    const without = computeBilling(base, plans);
    const with_   = computeBilling({ ...base, costPer10kClassA: 0.002 }, plans);
    expect(with_.revenue).toBe(without.revenue);
    expect(with_.cogs).toBeGreaterThan(without.cogs);
    expect(with_.margin).toBeLessThan(without.margin);
  });

  it('still bills Class D at list, which is not negotiated per group', () => {
    // 10k Class D beyond the 75,000/month free tier.
    const { cogs } = computeBilling({
      txnD30d: 85_000, costPerTbStorage: 0,
    });
    expect(cogs).toBeCloseTo(B2_LIST_PRICE.classDPer10k, 10);
  });
});

// ---------------------------------------------------------------------------
// Negotiated egress. The rate is repriced; B2's free allowance of 3x stored
// bytes per month still applies on top.
// ---------------------------------------------------------------------------
describe('group-negotiated egress cost', () => {
  // 1 TB stored gives 3 TB free egress, so 4 TB egress leaves 1 TB (1000 GB) billable.
  const usage = { storageBytes: 1e12, egressBytes30d: 4e12, costPerTbStorage: 0 };

  it('costs billable egress at B2 list when not negotiated', () => {
    const { cogs } = computeBilling(usage);
    expect(cogs).toBeCloseTo(1000 * B2_LIST_PRICE.egressPerGb, 6);
  });

  it('uses the negotiated rate when set', () => {
    const { cogs } = computeBilling({ ...usage, costPerGbEgress: 0.005 });
    expect(cogs).toBeCloseTo(1000 * 0.005, 6);
  });

  it('honours a zero rate rather than treating it as unset', () => {
    const { cogs } = computeBilling({ ...usage, costPerGbEgress: 0 });
    expect(cogs).toBe(0);
  });

  it('still applies the 3x free allowance before the negotiated rate', () => {
    // All 3 TB of egress is inside the free allowance, so nothing is billable.
    const { cogs } = computeBilling({
      storageBytes: 1e12, egressBytes30d: 3e12, costPerTbStorage: 0, costPerGbEgress: 0.005,
    });
    expect(cogs).toBe(0);
  });

  it('is independent of the other negotiated components', () => {
    const { cogs } = computeBilling({
      ...usage, costPerGbEgress: 0.005, costPer10kClassA: 0.002, txnA30d: 10_000,
    });
    expect(cogs).toBeCloseTo(1000 * 0.005 + 0.002, 6);
  });
});
