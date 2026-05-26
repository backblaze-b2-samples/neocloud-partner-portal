// Demo customers (sub-accounts) under a Backblaze Partner Group.
// In production, populate via Partner API v3:
//   GET https://api.backblazeb2.com/b2api/v3/b2_list_group_members
// Reference: https://www.backblaze.com/docs/cloud-storage-partner-api

export const CUSTOMERS = [
  {
    id: 'sub-7f3a91',
    accountId: '7f3a91d2c4b8',
    name: 'Lumora AI',
    industry: 'GPU Cloud / AI Inference',
    region: 'us-east-005',
    plan: 'Reseller — Tier 2',
    groupId: 'neocloud-internal',
    storageBytes: 4.82e15,    // 4.82 PB
    egressBytes30d: 1.18e15,  // 1.18 PB
    txnA30d: 412_540_000,
    txnB30d: 89_220_000,
    txnC30d: 12_400_000,
    cogs30d: 28_640.50,
    revenue30d: 56_980.00,
    health: 'healthy',
    growth: 0.184,
    activeBuckets: 28,
    contactEmail: 'platform@lumora.ai',
    onboarded: '2024-08-12',
  },
  {
    id: 'sub-2c8e44',
    accountId: '2c8e44a09f1b',
    name: 'Northwind Render',
    industry: 'VFX / Media Pipeline',
    region: 'us-west-002',
    plan: 'Reseller — Tier 1',
    groupId: 'neocloud-internal',
    storageBytes: 9.44e15,
    egressBytes30d: 5.21e15,
    txnA30d: 1_204_000_000,
    txnB30d: 622_500_000,
    txnC30d: 28_400_000,
    cogs30d: 71_220.10,
    revenue30d: 138_900.00,
    health: 'healthy',
    growth: 0.092,
    activeBuckets: 41,
    contactEmail: 'ops@northwindrender.com',
    onboarded: '2023-11-04',
  },
  {
    id: 'sub-9d2f17',
    accountId: '9d2f17b6e3c2',
    name: 'Mercato Compute',
    industry: 'Bare-Metal Cloud',
    region: 'eu-central-003',
    plan: 'Partner — Custom',
    groupId: 'neocloud-external',
    storageBytes: 2.91e15,
    egressBytes30d: 0.47e15,
    txnA30d: 188_900_000,
    txnB30d: 29_400_000,
    txnC30d: 6_900_000,
    cogs30d: 17_280.40,
    revenue30d: 36_400.00,
    health: 'attention',
    growth: 0.038,
    activeBuckets: 19,
    contactEmail: 'cloud@mercato.eu',
    onboarded: '2024-02-21',
  },
  {
    id: 'sub-4b5c08',
    accountId: '4b5c08fa726d',
    name: 'Halcyon Models',
    industry: 'Foundation Model Training',
    region: 'us-east-005',
    plan: 'Reseller — Tier 2',
    groupId: 'neocloud-internal',
    storageBytes: 18.6e15,    // 18.6 PB - largest
    egressBytes30d: 3.92e15,
    txnA30d: 2_104_000_000,
    txnB30d: 412_800_000,
    txnC30d: 39_200_000,
    cogs30d: 134_900.00,
    revenue30d: 261_400.00,
    health: 'healthy',
    growth: 0.318,
    activeBuckets: 62,
    contactEmail: 'infra@halcyonmodels.com',
    onboarded: '2024-04-30',
  },
  {
    id: 'sub-1a7e63',
    accountId: '1a7e63c4d908',
    name: 'Tessera Labs',
    industry: 'Vector DB / RAG SaaS',
    region: 'us-east-005',
    plan: 'Reseller — Tier 3',
    groupId: 'neocloud-internal',
    storageBytes: 0.42e15,
    egressBytes30d: 0.18e15,
    txnA30d: 28_400_000,
    txnB30d: 14_900_000,
    txnC30d: 2_100_000,
    cogs30d: 2_580.20,
    revenue30d: 5_640.00,
    health: 'healthy',
    growth: 0.412,
    activeBuckets: 8,
    contactEmail: 'sre@tesseralabs.io',
    onboarded: '2025-01-18',
  },
  {
    id: 'sub-6e0d29',
    accountId: '6e0d29a83b51',
    name: 'Aerie Streaming',
    industry: 'OTT / Video CDN Origin',
    region: 'us-west-002',
    plan: 'Reseller — Tier 2',
    groupId: 'neocloud-internal',
    storageBytes: 6.18e15,
    egressBytes30d: 8.94e15,  // egress > storage = high download workload
    txnA30d: 412_000_000,
    txnB30d: 1_840_000_000,
    txnC30d: 18_400_000,
    cogs30d: 91_400.00,
    revenue30d: 162_800.00,
    health: 'attention',
    growth: 0.056,
    activeBuckets: 24,
    contactEmail: 'cdn@aeriestreaming.com',
    onboarded: '2024-06-14',
  },
  {
    id: 'sub-3f9b51',
    accountId: '3f9b5128e0ac',
    name: 'Boreal Genomics',
    industry: 'Life Sciences / Bioinformatics',
    region: 'ca-east-006',
    plan: 'Partner — Custom',
    groupId: 'neocloud-external',
    storageBytes: 11.2e15,
    egressBytes30d: 0.62e15,
    txnA30d: 84_000_000,
    txnB30d: 18_200_000,
    txnC30d: 4_100_000,
    cogs30d: 56_800.00,
    revenue30d: 124_400.00,
    health: 'healthy',
    growth: 0.142,
    activeBuckets: 14,
    contactEmail: 'platform@borealgx.ca',
    onboarded: '2024-09-08',
  },
  {
    id: 'sub-8c1a44',
    accountId: '8c1a44e2f607',
    name: 'Pylon Robotics',
    industry: 'Autonomy / Sensor Data',
    region: 'us-west-002',
    plan: 'Reseller — Tier 3',
    groupId: 'neocloud-internal',
    storageBytes: 3.84e15,
    egressBytes30d: 0.28e15,
    txnA30d: 218_000_000,
    txnB30d: 12_400_000,
    txnC30d: 5_200_000,
    cogs30d: 19_400.00,
    revenue30d: 41_200.00,
    health: 'risk',
    growth: -0.024,
    activeBuckets: 11,
    contactEmail: 'data@pylonrobotics.com',
    onboarded: '2024-03-19',
  },
];

// Aggregate metrics roll-up. In production these come from the daily usage
// CSV report (egress/transactions) plus aggregated storage from Partner API.
// n() coerces null/undefined to 0 so live-mode totals don't produce NaN.
const n = (v) => v ?? 0;

export function aggregate(customers = CUSTOMERS) {
  return customers.reduce(
    (acc, c) => {
      acc.storageBytes += n(c.storageBytes);
      acc.egressBytes30d += n(c.egressBytes30d);
      acc.txnA30d += n(c.txnA30d);
      acc.txnB30d += n(c.txnB30d);
      acc.txnC30d += n(c.txnC30d);
      acc.cogs30d += n(c.cogs30d);
      acc.revenue30d += n(c.revenue30d);
      acc.activeBuckets += n(c.activeBuckets);
      return acc;
    },
    {
      storageBytes: 0,
      egressBytes30d: 0,
      txnA30d: 0,
      txnB30d: 0,
      txnC30d: 0,
      cogs30d: 0,
      revenue30d: 0,
      activeBuckets: 0,
    }
  );
}
