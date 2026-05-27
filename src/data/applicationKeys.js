// Demo application keys. In production:
//   POST /b2api/v4/b2_list_keys
// Reference: https://www.backblaze.com/apidocs/b2-list-keys
//
// Key fields returned by the API: accountId, applicationKeyId, keyName,
// capabilities[], bucketIds[], namePrefix, expirationTimestamp.
//
// IMPORTANT: There is NO `lastUsed` (or any timestamp-of-last-use) field on
// b2_list_keys. To answer "when was this key last used", you must mine
// Bucket Access Logs and take the max timestamp where `identity` equals
// `identity:applicationKey:<applicationKeyId>`. We derive that in the
// adapter (see ../api/b2Adapter.js → getKeyLastUsed) and the UI shows it
// as "from access logs" when available, or "—" otherwise.
//
// For security, the secret `applicationKey` is only returned ONCE on
// b2_create_key — never shown again. We display it as masked here.

export const ALL_CAPABILITIES = [
  'listBuckets', 'readBucketInfo', 'writeBucketInfo', 'deleteBuckets',
  'listFiles', 'readFiles', 'shareFiles', 'writeFiles', 'deleteFiles',
  'readBucketEncryption', 'writeBucketEncryption',
  'readBucketRetentions', 'writeBucketRetentions',
  'readBucketReplications', 'writeBucketReplications',
  'readBucketNotifications', 'writeBucketNotifications',
  'bypassGovernance',
];

export const APPLICATION_KEYS = [
  {
    applicationKeyId: '0042c8a4f1e9b32',
    keyName: 'lumora-checkpoint-writer-prod',
    customerId: 'sub-7f3a91',
    bucketIds: ['4a8b1d3f7c2e9a0b6d4e3f51'],
    bucketName: 'lumora-training-checkpoints',
    capabilities: ['writeFiles', 'readFiles', 'listFiles'],
    namePrefix: 'checkpoints/',
    expirationTimestamp: 1782259200000,
    expirationDate: '2026-06-01',
    createdAt: '2025-12-12T18:42:00Z',
    posture: 'good',
  },
  {
    applicationKeyId: '0093d17b8c4f019',
    keyName: 'northwind-render-batch-rw',
    customerId: 'sub-2c8e44',
    bucketIds: ['8d2e7f1a3b4c5d6e9f0a8b1c', '1a3b5c7d9e0f2a4b6c8d0e1f'],
    bucketName: 'northwind-render-frames-prod + 1',
    capabilities: ['writeFiles', 'readFiles', 'listFiles', 'deleteFiles'],
    namePrefix: '',
    expirationTimestamp: null,
    expirationDate: null,
    createdAt: '2024-08-19T09:11:00Z',
    posture: 'attention',  // long-lived, broad caps
  },
  {
    applicationKeyId: '0124a91e2d8f604',
    keyName: 'mercato-tenant-scoped-readonly',
    customerId: 'sub-9d2f17',
    bucketIds: ['2b4c6d8e0f1a3b5c7d9e1f3a'],
    bucketName: 'mercato-customer-objects',
    capabilities: ['readFiles', 'listFiles', 'readBucketInfo'],
    namePrefix: 'tenants/acme/',
    expirationTimestamp: 1761417600000,
    expirationDate: '2025-10-26',
    createdAt: '2025-04-26T14:20:00Z',
    posture: 'expired',
  },
  {
    applicationKeyId: '0188c3f4e5d2a07',
    keyName: 'halcyon-pretrain-readonly-eu',
    customerId: 'sub-4b5c08',
    bucketIds: ['3c5d7e9f1a2b4c6d8e0f2a4b', '4d6e8f0a1b3c5d7e9f1a3b5c'],
    bucketName: 'halcyon-foundation-checkpoints + 1',
    capabilities: ['readFiles', 'listFiles', 'readBucketInfo'],
    namePrefix: '',
    expirationTimestamp: 1798502400000,
    expirationDate: '2026-12-04',
    createdAt: '2026-01-10T16:08:00Z',
    posture: 'good',
  },
  {
    applicationKeyId: '0211f8b1c2e9d40',
    keyName: 'tessera-snapshot-writer',
    customerId: 'sub-1a7e63',
    bucketIds: ['5e7f9a1b2c4d6e8f0a2b4c6d'],
    bucketName: 'tessera-vector-snapshots',
    capabilities: ['writeFiles', 'readFiles', 'listFiles'],
    namePrefix: 'snapshots/',
    expirationTimestamp: 1761504000000,
    expirationDate: '2025-10-27',
    createdAt: '2025-04-27T20:11:00Z',
    posture: 'good',
  },
  {
    applicationKeyId: '0299e2d4f1c8b03',
    keyName: 'aerie-edge-cdn-public-reader',
    customerId: 'sub-6e0d29',
    bucketIds: ['6f8a0b1c3d5e7f9a1b3c5d7e'],
    bucketName: 'aerie-stream-origin',
    capabilities: ['readFiles', 'listFiles'],
    namePrefix: '',
    expirationTimestamp: null,
    expirationDate: null,
    createdAt: '2024-07-04T12:00:00Z',
    posture: 'good',
  },
  {
    applicationKeyId: '0344b1e8a2c7f09',
    keyName: 'boreal-genomics-master-DEPRECATED',
    customerId: 'sub-3f9b51',
    bucketIds: [],
    bucketName: '(account-wide)',
    capabilities: ['listBuckets', 'writeFiles', 'readFiles', 'listFiles', 'deleteFiles', 'deleteBuckets', 'writeBucketInfo'],
    namePrefix: '',
    expirationTimestamp: null,
    expirationDate: null,
    createdAt: '2023-05-12T10:00:00Z',
    posture: 'risk',  // master-equivalent, no expiry, stale
  },
  {
    applicationKeyId: '0418c7e2b9d5a16',
    keyName: 'pylon-fleet-uploader',
    customerId: 'sub-8c1a44',
    bucketIds: ['8b0c2d3e5f7a9b1c3d5e7f9a'],
    bucketName: 'pylon-sensor-fleet-data',
    capabilities: ['writeFiles', 'listFiles'],
    namePrefix: 'lidar/',
    expirationTimestamp: 1772236800000,
    expirationDate: '2026-02-27',
    createdAt: '2025-09-01T08:30:00Z',
    posture: 'expired',
  },
  {
    // Demo state: access logs ENABLED on scoped bucket, but this key ID does
    // not appear in the sample access log → shows "No activity observed since
    // logging was enabled." Distinguishes "no telemetry" from "no usage."
    applicationKeyId: '0501d8f2a3b9c14',
    keyName: 'tessera-snapshot-reader-new',
    customerId: 'sub-1a7e63',
    bucketIds: ['5e7f9a1b2c4d6e8f0a2b4c6d'],
    bucketName: 'tessera-vector-snapshots',
    capabilities: ['readFiles', 'listFiles'],
    namePrefix: '',
    expirationTimestamp: 1798502400000,
    expirationDate: '2026-12-04',
    createdAt: '2026-05-01T14:00:00Z',
    posture: 'good',
  },
];

// =============================================================================
// PER-EVENT ACTIVITY — sources of truth
// =============================================================================
// Three real ways to get per-key / per-request activity from Backblaze:
//
//   1. Bucket Access Logs (S3 PutBucketLogging) — per-request audit records
//      delivered to a destination bucket on a best-effort basis. Each record
//      includes the identity field (identity:applicationKey:<id>, etc.),
//      so this is the source for "when was a key last used". Parsed by
//      ../api/accessLogParser.js. Docs:
//        https://www.backblaze.com/docs/cloud-storage-bucket-access-logs
//
//   2. Daily Usage CSV — per-bucket per-day Class A/B/C/D aggregates only.
//      Useful for activity volume but not per-event detail.
//
//   3. Event Notifications — real-time HTTP webhooks fired when objects are
//      created/deleted/hidden. The lowest-latency option for streaming
//      activity to your own backend.
// =============================================================================
