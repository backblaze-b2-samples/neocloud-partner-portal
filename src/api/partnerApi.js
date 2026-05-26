// =============================================================================
// Backblaze Partner API Adapter (mock + live mode)
// =============================================================================
// The Partner API exposes Group / sub-account management and per-Group billing
// reports for resellers. Separate API surface from the B2 Native API; requires
// Partner Program enrollment (contact Backblaze sales).
//
// Reference: https://www.backblaze.com/docs/cloud-storage-partner-api
// Version:   v3 — base URL: https://api123.backblazeb2.com/b2api/v3/
//
// Live-mode calls reuse the master-key authorization from ../api/b2Adapter.js
// — the partner endpoints accept the same authorization token.
// =============================================================================

import { CUSTOMERS, aggregate } from '../data/customers.js';
import { GROUPS } from '../data/groups.js';
import { authorizeAccount, getCustomerUsageFromCsv } from './b2Adapter.js';
import { api } from '../lib/apiClient.js';
import { computeBilling, DEFAULT_PLAN_NAME, RESELLER_PLANS } from '../data/resellerPlans.js';

const wait = (ms = 220) => new Promise((r) => setTimeout(r, ms));

let runtimeConfig = { mode: 'demo', proxyUrl: '' };
export function configurePartner(config) {
  runtimeConfig = { ...runtimeConfig, ...config };
}
const useMocks = () => runtimeConfig.mode !== 'live';

async function callPartner(endpoint, body) {
  // Partner API v3 must reach the account-specific B2 host (e.g.
  // api004.backblazeb2.com). Browser calls to that host fail due to CORS, and
  // the nginx /b2-proxy only covers the generic api.backblazeb2.com. Instead,
  // we POST to the Express server-side proxy at /api/b2-partner/:endpoint.
  // Express forwards the call from Node.js (no CORS restrictions) using the
  // raw B2 apiUrl (before nginx rewriting) passed via X-B2-Api-Url header.
  const auth = await authorizeAccount();

  // auth.apiUrl has been rewritten by b2Adapter to a local proxy path like
  // https://neocloud.backblazedemos.xyz/b2-api004 — reconstruct the real
  // B2 host so the server-side proxy can reach it directly.
  const rawApiUrl = (() => {
    if (!auth.apiUrl) return null;
    // Already a real B2 host (dev or if rewriting was skipped)
    if (/^https:\/\/api\d+\.backblazeb2\.com$/.test(auth.apiUrl)) return auth.apiUrl;
    // Proxy-rewritten: https://host/b2-api004 → https://api004.backblazeb2.com
    const m = auth.apiUrl.match(/\/b2-api(\d+)/);
    if (m) return `https://api${m[1]}.backblazeb2.com`;
    return null;
  })();

  if (!rawApiUrl) throw new Error('callPartner: could not derive B2 API host from auth.apiUrl=' + auth.apiUrl);

  const res = await fetch(`${window.location.origin}/api/b2-partner/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'X-B2-Api-Url': rawApiUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ adminAccountId: auth.accountId, ...body }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`partner ${endpoint} ${res.status}: ${err}`);
  }
  return res.json();
}

// POST /b2api/v3/b2_list_groups
export async function listGroups({ maxGroupCount = 100 } = {}) {
  if (useMocks()) {
    await wait();
    return { groups: GROUPS, nextGroupId: null };
  }
  return callPartner('b2_list_groups', { maxGroupCount });
}

export async function getGroup(groupId) {
  if (useMocks()) {
    await wait(120);
    return GROUPS.find((g) => String(g.groupId) === String(groupId)) || null;
  }
  // Re-use listGroups() which already handles the groups/groupsList field-name
  // variant that the B2 Partner API v3 uses in some responses.
  // String-coerce both IDs so numeric vs string mismatches never cause false negatives.
  const data = await listGroups();
  const groups = data?.groups ?? data?.groupsList ?? [];
  return groups.find((g) => String(g.groupId) === String(groupId)) || null;
}

// POST /b2api/v3/b2_list_group_members
export async function listGroupMembers({ groupId, maxMemberCount = 5000 } = {}) {
  if (useMocks()) {
    await wait();
    const members = CUSTOMERS.filter((c) => c.groupId === groupId).slice(0, maxMemberCount);
    return {
      members: members.map((c) => ({
        accountId: c.accountId,
        email: c.contactEmail,
        addedTimestamp: new Date(c.onboarded).getTime(),
        // Convenience extras (not in the actual API response):
        _displayName: c.name,
        _industry: c.industry,
        _region: c.region,
      })),
      nextMemberId: null,
    };
  }
  return callPartner('b2_list_group_members', { groupId, maxMemberCount });
}

// =============================================================================
// Live-mode member → customer shape adapter
// =============================================================================
// b2_list_group_members returns: { accountId, email, addedTimestamp, b2Stats? }
// b2Stats (when present) includes storage and bucket counts.
// Egress, transactions, revenue, and growth are ONLY in the daily CSV report
// and are left null here — the UI's formatters already show '—' for null.
function memberToCustomer(member, groupId) {
  const stats = member.b2Stats || {};
  // The real Partner API uses b2BytesStoredCount / b2FilesStoredCount / bucketCount.
  // Earlier mock data used storageBytes / storedBytes. Accept all.
  const storageBytes = stats.b2BytesStoredCount ?? stats.storageBytes ?? stats.storedBytes ?? 0;
  const bucketCount  = stats.bucketCount ?? 0;

  // Derive a readable display name from the email local-part.
  // "platform@lumora.ai" → "Platform", "sre_team@co.com" → "Sre Team"
  let name = member.accountId;
  if (member.email) {
    const local = member.email.split('@')[0];
    name = local
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  // Infer region from the NeoCloud email naming convention:
  //   *-eu@*   → eu-central-003
  //   *-west@* → us-west-002
  //   *-east@* → us-east-005
  // Falls back to us-west-002 for internal accounts without a suffix.
  function inferRegion(email = '') {
    const local = email.split('@')[0].toLowerCase();
    if (local.endsWith('-eu'))   return 'eu-central-003';
    if (local.endsWith('-ca'))   return 'ca-east-006';
    if (local.endsWith('-east')) return 'us-east-005';
    if (local.endsWith('-west')) return 'us-west-002';
    // Internal accounts: james.rivera → east, everyone else → west
    if (local.includes('rivera')) return 'us-east-005';
    return 'us-west-002';
  }

  return {
    id: member.accountId,   // accountId doubles as id in live mode
    accountId: member.accountId,
    name,
    industry: null,   // not in Partner API — set via Edit Customer → local metadata
    region: inferRegion(member.email),
    plan: null,             // not in API; shows '—'
    groupId,
    storageBytes,
    egressBytes30d: null,   // only in CSV report
    txnA30d: null,
    txnB30d: null,
    txnC30d: null,
    txnD30d: null,
    cogs30d: null,          // billing data only
    revenue30d: null,
    health: 'healthy',      // can't derive without CSV trend data
    growth: null,
    activeBuckets: bucketCount,
    contactEmail: member.email || null,
    onboarded: member.addedTimestamp
      ? new Date(member.addedTimestamp).toISOString().slice(0, 10)
      : null,
  };
}

// All customers across all groups (used by views that want a flat list).
export async function getCustomers({ groupId } = {}) {
  if (useMocks()) {
    await wait();
    const list = groupId ? CUSTOMERS.filter((c) => c.groupId === groupId) : CUSTOMERS;
    return { customers: list, totals: aggregate(list) };
  }

  // Live: fetch all groups, then their members in parallel
  const groupsResp = await listGroups();
  const groups = groupsResp.groups || groupsResp.groupsList || [];
  const targetGroups = groupId
    ? groups.filter((g) => g.groupId === groupId)
    : groups;

  // Fetch stored credentials (contains region) in parallel with group members.
  // Falls back gracefully if the credentials endpoint fails or returns nothing.
  const storedCredsPromise = fetch('/api/admin/credentials', { credentials: 'include' })
    .then((r) => r.ok ? r.json() : { credentials: [] })
    .then((d) => {
      const map = new Map();
      for (const c of d.credentials || []) map.set(c.account_id, c);
      return map;
    })
    .catch(() => new Map());

  // Fetch all customer metadata so we can (a) merge per-customer overrides and
  // (b) surface ejected sub-accounts that the Partner API no longer returns.
  const metadataPromise = api.get('/api/admin/metadata')
    .then((d) => {
      const map = new Map();
      for (const m of d.metadata || []) map.set(m.account_id, m);
      return map;
    })
    .catch(() => new Map());

  const [perGroup, storedCreds, metadata] = await Promise.all([
    Promise.all(
      targetGroups.map(async (g) => {
        // Paginate — Partner API caps maxMemberCount at 100.
        // Real API returns groupMembers (not members) and nextEmail (not nextMemberId).
        //
        // Defensive: Backblaze sometimes returns a non-null nextEmail on the
        // final page; the next call then re-fetches members starting at that
        // email, producing duplicates. Dedupe by accountId and break if a page
        // adds no new members.
        const seen = new Set();
        const members = [];
        let nextEmail = undefined;
        do {
          const data = await callPartner('b2_list_group_members', {
            groupId: g.groupId,
            maxMemberCount: 100,
            ...(nextEmail ? { startEmail: nextEmail } : {}),
          });
          const batch = data.groupMembers || data.members || [];
          let added = 0;
          for (const m of batch) {
            if (m?.accountId && !seen.has(m.accountId)) {
              seen.add(m.accountId);
              members.push(m);
              added++;
            }
          }
          nextEmail = data.nextEmail || null;
          if (added === 0) break; // no progress — stop even if nextEmail is set
        } while (nextEmail);
        return members.map((m) => memberToCustomer(m, g.groupId));
      })
    ),
    storedCredsPromise,
    metadataPromise,
  ]);

  // Map seed region values (us-west, eu-central, us-east) to REGIONS ids.
  const regionMap = {
    'us-west':    'us-west-002',
    'us-east':    'us-east-005',
    'eu-central': 'eu-central-003',
    'ca-east':    'ca-east-006',
  };
  const normalizeRegion = (r) => regionMap[r] ?? r;

  // Merge stored region into each customer (overrides the email-inferred fallback).
  const liveAccountIds = new Set();
  const customers = perGroup.flat().map((c) => {
    liveAccountIds.add(c.accountId);
    const stored = storedCreds.get(c.accountId);
    if (stored?.region) {
      return { ...c, region: normalizeRegion(stored.region) };
    }
    return c;
  });

  // Append stub rows for ejected sub-accounts (active=false). These are no
  // longer returned by b2_list_group_members, so we synthesize them from the
  // ejection snapshot stored in customer_metadata.
  for (const m of metadata.values()) {
    if (!m.ejected_at) continue;
    if (liveAccountIds.has(m.account_id)) continue; // shouldn't happen, but guard
    customers.push({
      id: m.account_id,
      accountId: m.account_id,
      name: m.display_name || m.ejected_email || m.account_id,
      industry: m.industry || null,
      region: normalizeRegion(m.ejected_region) || null,
      plan: m.plan || null,
      groupId: m.ejected_group_id || null,
      storageBytes: 0,
      egressBytes30d: 0,
      txnA30d: 0,
      txnB30d: 0,
      txnC30d: 0,
      txnD30d: 0,
      cogs30d: 0,
      revenue30d: 0,
      health: 'risk',
      growth: 0,
      activeBuckets: 0,
      contactEmail: m.ejected_email || null,
      onboarded: null,
      active: false,
      ejectedAt: m.ejected_at,
    });
  }
  // Enrich with CSV-derived usage (storage, egress, transactions),
  // object-count job results, and reseller plan billing. Storage preference order:
  //   1. CSV daily report   (authoritative for historic billing windows)
  //   2. object_counts table (real-time after a Sync — bypasses CSV lag)
  //   3. b2Stats from Partner API (b2BytesStoredCount; updates on its own cadence)
  //   4. 0 fallback
  const [csvUsage, objectCounts, plans] = await Promise.all([
    getCustomerUsageFromCsv(),
    (await import('./b2Adapter.js')).getObjectCounts().catch(() => new Map()),
    api.get('/api/admin/reseller-plans').then((d) => d.plans).catch(() => RESELLER_PLANS),
  ]);

  // Sum object_counts per accountId so we can use it as a per-customer storage source.
  const bytesByAccount = new Map();
  for (const [, oc] of objectCounts) {
    if (!oc?.accountId) continue; // map values now include accountId via the GET response shape
    bytesByAccount.set(oc.accountId, (bytesByAccount.get(oc.accountId) || 0) + (oc.totalBytes || 0));
  }

  const enriched = customers.map((c) => {
    // Ejected sub-accounts are no longer the partner's billing responsibility,
    // so they roll up as zero everywhere. They still appear on the dedicated
    // "Inactive" tab via the active=false flag.
    if (c.active === false) {
      return { ...c, storageBytes: 0, egressBytes30d: 0, txnA30d: 0, txnB30d: 0, txnC30d: 0, txnD30d: 0, revenue30d: 0, cogs30d: 0 };
    }
    const csv  = csvUsage.get(c.accountId);
    const objBytes = bytesByAccount.get(c.accountId) || 0;
    const csvBytes = csv?.storageBytes > 0 ? csv.storageBytes : 0;
    const apiBytes = c.storageBytes ?? 0;
    const storageBytes   = csvBytes || objBytes || apiBytes;
    const egressBytes30d = csv?.egressBytes30d > 0 ? csv.egressBytes30d : (c.egressBytes30d ?? 0);
    const txnA30d        = csv?.txnA30d        > 0 ? csv.txnA30d        : (c.txnA30d        ?? 0);
    const txnB30d        = csv?.txnB30d        > 0 ? csv.txnB30d        : (c.txnB30d        ?? 0);
    const txnC30d        = csv?.txnC30d        > 0 ? csv.txnC30d        : (c.txnC30d        ?? 0);
    const txnD30d        = csv?.txnD30d        > 0 ? csv.txnD30d        : (c.txnD30d        ?? 0);

    // Default-assign a plan to every active customer that doesn't already have one.
    const plan = c.plan || DEFAULT_PLAN_NAME;
    const billingInput = {
      ...c,
      storageBytes, egressBytes30d, txnA30d, txnB30d, txnC30d, txnD30d,
      plan,
    };
    const { revenue, cogs } = computeBilling(billingInput, plans);

    // A customer with no storage is either brand-new or has removed all data —
    // flag as 'attention' so they show up on the watch list.
    // Also catches accounts not in the CSV at all (never had usage data).
    const health = storageBytes === 0 ? 'attention' : (c.health || 'healthy');

    return {
      ...c,
      plan,
      storageBytes, egressBytes30d, txnA30d, txnB30d, txnC30d, txnD30d,
      revenue30d: revenue,
      cogs30d:    cogs,
      health,
    };
  });

  return { customers: enriched, totals: aggregate(enriched) };
}

export async function getCustomer(id) {
  if (useMocks()) {
    await wait(120);
    const c = CUSTOMERS.find((c) => c.id === id) || null;
    if (!c) return null;
    // Merge any saved local metadata (plan, pricing overrides etc.)
    try {
      const meta = await getCustomerMeta(c.accountId);
      if (meta) return mergeMetadata(c, meta);
    } catch { /* ignore */ }
    return c;
  }
  // In live mode, id IS the accountId. Re-use getCustomers to avoid
  // duplicating the group-member fetch logic.
  const [{ customers }, meta] = await Promise.all([
    getCustomers(),
    getCustomerMeta(id).catch(() => null),
  ]);
  const c = customers.find((c) => c.id === id) || null;
  if (!c) return null;
  return meta ? mergeMetadata(c, meta) : c;
}

/** Apply saved local metadata on top of the Partner-API-derived customer shape. */
function mergeMetadata(customer, meta) {
  return {
    ...customer,
    name:     meta.display_name  || customer.name,
    industry: meta.industry      || customer.industry,
    plan:     meta.plan          || customer.plan,
    price_per_gb_storage:  meta.price_per_gb_storage  ?? null,
    price_per_gb_download: meta.price_per_gb_download ?? null,
    _notes:   meta.notes         || null,
  };
}

// POST /b2api/v3/b2_create_account (Partner API; exact endpoint name varies
// by partner contract). Mock implementation creates a sub-account record.
export async function createCustomer(payload) {
  if (useMocks()) {
    await wait(450);
    const id = 'sub-' + Math.random().toString(16).slice(2, 8);
    const acct = Math.random().toString(16).slice(2, 14);
    const newCust = {
      id,
      accountId: acct,
      name: payload.name,
      industry: payload.industry || 'Unspecified',
      region: payload.region,
      plan: payload.plan || 'Reseller — Tier 3',
      groupId: payload.groupId,
      storageBytes: 0,
      egressBytes30d: 0,
      txnA30d: 0,
      txnB30d: 0,
      txnC30d: 0,
      txnD30d: 0,
      cogs30d: 0,
      revenue30d: 0,
      health: 'healthy',
      growth: 0,
      activeBuckets: 0,
      contactEmail: payload.contactEmail,
      onboarded: new Date().toISOString().slice(0, 10),
    };
    CUSTOMERS.unshift(newCust);
    // Bump group member count so UI stays in sync.
    const grp = GROUPS.find((g) => g.groupId === payload.groupId);
    if (grp) grp.memberCount += 1;
    return newCust;
  }
  // Real Partner API uses an account-creation endpoint for sub-accounts.
  return callPartner('b2_create_account', payload);
}

// =============================================================================
// Member management — live mode only
// =============================================================================

/**
 * Update the login email for a B2 sub-account via the Partner API.
 * NOTE: Endpoint name 'b2_update_account_email' — verify against your partner
 * contract if this returns a 400. Some partner tiers use b2_change_email.
 */
export async function updateMemberEmail(accountId, newEmail) {
  if (useMocks()) {
    await wait(300);
    const c = CUSTOMERS.find((x) => x.accountId === accountId);
    if (c) c.contactEmail = newEmail;
    return { accountId, email: newEmail };
  }
  return callPartner('b2_update_account_email', { accountId, email: newEmail });
}

/**
 * Eject a sub-account from a Partner group.
 * Uses b2_eject_group_member — the correct Partner API v3 endpoint.
 *
 * IMPORTANT B2 CONSTRAINTS:
 *   - Once ejected, the member CANNOT be re-added via API. Re-invitation
 *     must be done through the Backblaze Group Management web UI.
 *   - The optional `newEmail` param updates their email in the same call.
 *   - Ejected members must reset their password on next login.
 *
 * Body: { adminAccountId, groupId, accountId, email? }
 */
export async function removeGroupMember({ accountId, groupId, newEmail, email, region } = {}) {
  if (useMocks()) {
    await wait(500);
    const idx = CUSTOMERS.findIndex((x) => x.accountId === accountId);
    if (idx !== -1) CUSTOMERS.splice(idx, 1);
    const grp = GROUPS.find((g) => g.groupId === groupId);
    if (grp && grp.memberCount > 0) grp.memberCount -= 1;
    return { ejected: true };
  }
  const body = { groupId, accountId };
  if (newEmail) body.email = newEmail; // B2 updates email as part of eject in one call
  const result = await callPartner('b2_eject_group_member', body);
  // Record the ejection in customer_metadata so the account still appears on
  // the Inactive tab — the Partner API will not return it again.
  try {
    await api.post(`/api/admin/metadata/${accountId}/eject`, {
      email: newEmail || email || null,
      groupId,
      region: region || null,
    });
  } catch (err) {
    console.warn('[partnerApi] failed to record ejection metadata:', err);
  }
  return result;
}

// =============================================================================
// Local customer metadata (plan, pricing overrides, display name, industry)
// Stored in our control-plane SQLite — not in the B2 API.
// =============================================================================

/**
 * Fetch metadata for one account.  Returns null if none stored yet.
 */
export async function getCustomerMeta(accountId) {
  try {
    const data = await api.get(`/api/admin/metadata/${accountId}`);
    return data?.metadata ?? null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/**
 * Bulk-fetch all metadata records as a Map<accountId, row>.
 * Used to enrich the customer list without N+1 requests.
 */
export async function getAllCustomerMeta() {
  try {
    const data = await api.get('/api/admin/metadata');
    const map = new Map();
    for (const row of data?.metadata ?? []) map.set(row.account_id, row);
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Upsert metadata for one account.
 * Fields: display_name, industry, plan, price_per_gb_storage, price_per_gb_download, notes
 */
export async function saveCustomerMeta(accountId, fields) {
  const data = await api.put(`/api/admin/metadata/${accountId}`, fields);
  return data?.metadata ?? null;
}

/**
 * Remove local metadata record for one account.
 */
export async function deleteCustomerMeta(accountId) {
  return api.delete(`/api/admin/metadata/${accountId}`);
}
