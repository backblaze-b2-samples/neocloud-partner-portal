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
import { authorizeAccount } from './b2Adapter.js';

const wait = (ms = 220) => new Promise((r) => setTimeout(r, ms));

let runtimeConfig = { mode: 'demo', proxyUrl: '' };
export function configurePartner(config) {
  runtimeConfig = { ...runtimeConfig, ...config };
}
const useMocks = () => runtimeConfig.mode !== 'live';

async function callPartner(endpoint, body) {
  // accountId for Partner API calls is the master-key holder's accountId,
  // which b2_authorize_account already returns. No separate "Partner Account ID"
  // input is required.
  const auth = await authorizeAccount();
  // Default to same-origin /b2-partner proxy so the request goes server-side.
  // nginx strips /b2-partner/ and forwards to api123.backblazeb2.com.
  const base = runtimeConfig.proxyUrl ||
    `${window.location.origin}/b2-partner/b2api/v3`;
  const res = await fetch(`${base}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    return GROUPS.find((g) => g.groupId === groupId) || null;
  }
  const { groups } = await callPartner('b2_list_groups', { maxGroupCount: 1000 });
  return groups.find((g) => g.groupId === groupId) || null;
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

// All customers across all groups (used by views that want a flat list).
export async function getCustomers({ groupId } = {}) {
  await wait();
  const list = groupId ? CUSTOMERS.filter((c) => c.groupId === groupId) : CUSTOMERS;
  return { customers: list, totals: aggregate(list) };
}

export async function getCustomer(id) {
  await wait(120);
  return CUSTOMERS.find((c) => c.id === id) || null;
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
