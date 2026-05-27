// Reseller plan tiers — pricing applied when a customer has no per-account
// price override. Storage is quoted per TB to match Backblaze's published
// pricing model ($6.95/TB list). Egress and Class D are per-unit (B2's units).
//
// B2 list (COGS):
//   Storage:   $6.95/TB/mo
//   Egress:    $0.01/GB (after 3× stored free)
//   Class D:   $0.004 / 10,000 event notifications (2,500/day free)
//   Class A/B/C: free

export const B2_LIST_PRICE = {
  storagePerTb: 6.95,
  egressPerGb:  0.01,
  egressFreeMultiplier: 3,  // 3× stored bytes free egress per month
  classAPer10k: 0,          // free at B2 list — partner may still charge customers
  classBPer10k: 0,          // free at B2 list
  classCPer10k: 0,          // free at B2 list
  classDPer10k: 0.004,
  classDFreePerDay: 2500,
};

// Defaults are seeded into the `reseller_plans` DB table on first boot.
// Admins can edit them via Reseller plans in the System sidebar; the API is
// the runtime source of truth. This array is only used to seed and as a
// fallback if the API call fails.
export const RESELLER_PLANS = [
  {
    id:           'tier-1',
    name:         'Reseller — Tier 1',
    description:  'Standard reseller — highest markup',
    storagePerTb: 25,
    egressPerGb:  0.030,
    classAPer10k: 0.004,
    classBPer10k: 0.004,
    classCPer10k: 0.002,
    classDPer10k: 0.012,
  },
  {
    id:           'tier-2',
    name:         'Reseller — Tier 2',
    description:  'Growth tier — mid markup',
    storagePerTb: 15,
    egressPerGb:  0.020,
    classAPer10k: 0.002,
    classBPer10k: 0.002,
    classCPer10k: 0.001,
    classDPer10k: 0.008,
  },
  {
    id:           'tier-3',
    name:         'Reseller — Tier 3',
    description:  'Enterprise volume — lowest markup; mirrors B2 list',
    storagePerTb: 10,
    egressPerGb:  0.015,
    classAPer10k: 0,       // mirrors B2 — uploads stay free
    classBPer10k: 0,       // mirrors B2 — downloads stay free
    classCPer10k: 0,       // mirrors B2 — list/metadata stays free
    classDPer10k: 0.005,
  },
];

export const PLAN_NAMES = RESELLER_PLANS.map((p) => p.name);

/** Default plan name assigned to customers that have no explicit plan. */
export const DEFAULT_PLAN_NAME = 'Reseller — Tier 1';

/** Look up a plan by its display name (matches the value stored on customers). */
export function planByName(name, plans = RESELLER_PLANS) {
  return plans.find((p) => p.name === name) || null;
}

/**
 * Compute revenue and COGS for a customer from their usage. Returns
 * { revenue, cogs, margin } in dollars (number, not currency-formatted).
 *
 * Pricing precedence:
 *   1. Per-customer override (customer.price_per_tb_storage, etc.) — if set, win
 *   2. Plan default from RESELLER_PLANS — if customer.plan matches a tier
 *   3. B2 list price — if neither is set, customer is at-cost (no margin)
 *
 * Usage:
 *   storageBytes        — current snapshot bytes (or 30-day average)
 *   egressBytes30d      — total egress over the last 30 days
 *   txnD30d             — Class D event notifications over the last 30 days
 */
export function computeBilling(customer, plans = RESELLER_PLANS) {
  const plan = planByName(customer.plan, plans);

  const storagePerTb = customer.price_per_tb_storage  ?? plan?.storagePerTb ?? B2_LIST_PRICE.storagePerTb;
  const egressPerGb  = customer.price_per_gb_download ?? plan?.egressPerGb  ?? B2_LIST_PRICE.egressPerGb;
  const classAPer10k = customer.price_per_10k_class_a ?? plan?.classAPer10k ?? B2_LIST_PRICE.classAPer10k;
  const classBPer10k = customer.price_per_10k_class_b ?? plan?.classBPer10k ?? B2_LIST_PRICE.classBPer10k;
  const classCPer10k = customer.price_per_10k_class_c ?? plan?.classCPer10k ?? B2_LIST_PRICE.classCPer10k;
  const classDPer10k = customer.price_per_10k_class_d ?? plan?.classDPer10k ?? B2_LIST_PRICE.classDPer10k;

  const storageTb   = (customer.storageBytes    || 0) / 1e12;
  const egressGb    = (customer.egressBytes30d  || 0) / 1e9;
  const classACount = customer.txnA30d || 0;
  const classBCount = customer.txnB30d || 0;
  const classCCount = customer.txnC30d || 0;
  const classDCount = customer.txnD30d || 0;

  // Revenue — every unit is billed at the chosen rate (no free tier on the
  // customer side; partners decide how much of B2's free tier they pass on).
  const revenue = storageTb * storagePerTb
                + egressGb  * egressPerGb
                + (classACount / 10_000) * classAPer10k
                + (classBCount / 10_000) * classBPer10k
                + (classCCount / 10_000) * classCPer10k
                + (classDCount / 10_000) * classDPer10k;

  // COGS — what the partner pays Backblaze. Mirrors B2's published pricing:
  // A/B/C are always free, D has a daily free tier then a per-10k rate.
  const storageGb        = (customer.storageBytes || 0) / 1e9;
  const freeEgressGb     = storageGb * B2_LIST_PRICE.egressFreeMultiplier;
  const billableEgressGb = Math.max(0, egressGb - freeEgressGb);
  const freeClassD       = B2_LIST_PRICE.classDFreePerDay * 30;
  const billableClassD   = Math.max(0, classDCount - freeClassD);

  const cogs = storageTb * B2_LIST_PRICE.storagePerTb
             + billableEgressGb * B2_LIST_PRICE.egressPerGb
             + (billableClassD / 10_000) * B2_LIST_PRICE.classDPer10k;

  const margin = revenue > 0 ? (revenue - cogs) / revenue : 0;
  return { revenue, cogs, margin };
}
