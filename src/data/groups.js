// Demo Groups. In production, populate via Partner API v3:
//   POST https://api123.backblazeb2.com/b2api/v3/b2_list_groups
// Reference: https://www.backblaze.com/docs/cloud-storage-partner-api
//
// A Group is the partner-level container that holds customer sub-accounts.
// One partner can manage up to 500 Groups; each Group can hold up to 5,000
// member sub-accounts. Groups are how Backblaze rolls up billing for resellers.

export const GROUPS = [
  {
    groupId: 'kevinco-resellers',
    groupName: 'KevinCo Reseller Tier',
    description: 'Primary reseller group — Tier 1/2/3 customer plans',
    createdTimestamp: 1718323200000,
    memberCount: 6,
    plan: 'Reseller',
    accent: '#E61F18',
  },
  {
    groupId: 'kevinco-strategic',
    groupName: 'KevinCo Strategic Partners',
    description: 'Custom-priced partner accounts (multi-year, volume-discounted)',
    createdTimestamp: 1709251200000,
    memberCount: 2,
    plan: 'Partner — Custom',
    accent: '#9B7CFF',
  },
];
