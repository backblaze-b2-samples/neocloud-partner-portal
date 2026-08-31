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

// A plan may also carry `groupId`, pinning it to a B2 partner group so every
// member of that group bills at this tier without per-account assignment. The
// static defaults below are unpinned; pinning is done through the API.
//
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

/**
 * Fallback tier for demo data and for seeding only.
 *
 * NOT a default for live customers: Partner-API group members arrive with no
 * plan, so defaulting them here billed every unassigned account at the most
 * expensive tier. Live plan resolution is explicit account plan -> the plan
 * pinned to the account's group (plan.groupId) -> unassigned (B2 list, zero
 * margin). See getCustomers in src/api/partnerApi.js.
 */
export const DEFAULT_PLAN_NAME = 'Reseller — Tier 1';

/** The plan pinned to a B2 partner group, if any. */
export function planForGroup(groupId, plans = RESELLER_PLANS) {
  if (groupId == null || groupId === '') return null;
  return plans.find((p) => p.groupId != null && String(p.groupId) === String(groupId)) || null;
}

/** Look up a plan by its display name (matches the value stored on customers). */
export function planByName(name, plans = RESELLER_PLANS) {
  return plans.find((p) => p.name === name) || null;
}

/**
 * Compute revenue and COGS for a customer from their usage. Returns
 * { revenue, cogs, margin } in dollars (number, not currency-formatted).
 *
 * Pricing precedence (what the partner CHARGES):
 *   1. Per-customer override (customer.price_per_gb_storage / price_per_gb_download
 *      / price_per_10k_class_a..d) — if set, wins
 *   2. Plan default from RESELLER_PLANS — if customer.plan matches a tier
 *      (the plan itself may have been resolved from the account's group pin)
 *   3. B2 list price — if neither is set, customer is at-cost (no margin)
 *
 * Cost (what the partner PAYS Backblaze) is a separate axis: storage is
 * negotiated per B2 partner group, so it arrives on the customer as
 * costPerTbStorage, resolved from the group's row in group_costs. Absent that,
 * B2 list applies. Egress and Class D COGS stay at B2 list — they are not
 * negotiated per group today.
 *
 * Usage:
 *   storageBytes        — current snapshot bytes (or 30-day average)
 *   egressBytes30d      — total egress over the last 30 days
 *   txnD30d             — Class D event notifications over the last 30 days
 */
export function computeBilling(customer, plans = RESELLER_PLANS) {
  const plan = planByName(customer.plan, plans);

  // The stored storage override is $/GB — customer_metadata.price_per_gb_storage
  // is what the Edit Customer dialog collects — while plans quote $/TB. Accept
  // either form and convert, so a saved override actually reaches the math
  // instead of silently falling through to the plan rate.
  const storageOverridePerTb = customer.price_per_tb_storage
    ?? (customer.price_per_gb_storage != null ? customer.price_per_gb_storage * 1000 : null);

  const storagePerTb = storageOverridePerTb ?? plan?.storagePerTb ?? B2_LIST_PRICE.storagePerTb;
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

  // COGS — what the partner pays Backblaze. Egress and Class D mirror B2's
  // published pricing (A/B/C are always free, D has a daily free tier then a
  // per-10k rate). Storage uses the group's negotiated rate where one is set:
  // a partner at 30 PB does not pay list, and costing them at list makes every
  // margin figure wrong.
  const costPerTb = customer.costPerTbStorage ?? B2_LIST_PRICE.storagePerTb;

  const storageGb        = (customer.storageBytes || 0) / 1e9;
  const freeEgressGb     = storageGb * B2_LIST_PRICE.egressFreeMultiplier;
  const billableEgressGb = Math.max(0, egressGb - freeEgressGb);
  const freeClassD       = B2_LIST_PRICE.classDFreePerDay * 30;
  const billableClassD   = Math.max(0, classDCount - freeClassD);

  const cogs = storageTb * costPerTb
             + billableEgressGb * B2_LIST_PRICE.egressPerGb
             + (billableClassD / 10_000) * B2_LIST_PRICE.classDPer10k;

  const margin = revenue > 0 ? (revenue - cogs) / revenue : 0;
  return { revenue, cogs, margin };
}
