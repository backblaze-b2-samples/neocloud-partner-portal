// Example API requests and responses for the embedded API Console.
// Each example mirrors a real Backblaze endpoint shape so customers can
// learn the API surface from inside the dashboard.
//
// References:
//   - B2 Native API: https://www.backblaze.com/apidocs
//   - Partner API:    https://www.backblaze.com/docs/cloud-storage-partner-api

export const API_EXAMPLES = [
  {
    id: 'authorize',
    category: 'Auth',
    name: 'Authorize account',
    description: 'Exchange your application key for an authorization token, apiUrl, and downloadUrl. Tokens expire after 24 hours.',
    request: {
      method: 'GET',
      url: 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account',
      headers: {
        Authorization: 'Basic ' + btoa('YOUR_KEY_ID:YOUR_APPLICATION_KEY'),
      },
      body: null,
    },
    response: {
      status: 200,
      body: {
        accountId: '7f3a91d2c4b8',
        apiUrl: 'https://api005.backblazeb2.com',
        downloadUrl: 'https://f005.backblazeb2.com',
        recommendedPartSize: 100000000,
        absoluteMinimumPartSize: 5000000,
        authorizationToken: '4_0042c8a4f1e9b32_01234567890_acct_a1b2c3d4e5f6g7h8',
        allowed: {
          buckets: null,
          capabilities: ['listBuckets', 'readFiles', 'writeFiles', 'listFiles'],
          namePrefix: null,
        },
      },
    },
  },
  {
    id: 'list-buckets',
    category: 'Buckets',
    name: 'List buckets',
    description: 'Returns bucket metadata including lifecycle rules, encryption, file lock, and CORS. Does NOT return object counts or storage bytes.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_list_buckets',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
      },
    },
    response: {
      status: 200,
      body: {
        buckets: [
          {
            accountId: '7f3a91d2c4b8',
            bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
            bucketName: 'lumora-training-checkpoints',
            bucketType: 'allPrivate',
            bucketInfo: { workload: 'training' },
            corsRules: [],
            defaultServerSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
            fileLockConfiguration: { isFileLockEnabled: true, defaultRetention: { mode: 'governance', period: { duration: 30, unit: 'days' } } },
            lifecycleRules: [
              { fileNamePrefix: 'checkpoints/', daysFromHidingToDeleting: 30, daysFromUploadingToHiding: null },
            ],
            options: ['s3'],
            revision: 14,
          },
        ],
      },
    },
  },
  {
    id: 'create-key',
    category: 'Keys',
    name: 'Create application key',
    description: 'Create a least-privilege application key scoped to specific buckets, capabilities, and an optional name prefix. The secret is returned ONCE — store it immediately.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_create_key',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
        keyName: 'lumora-checkpoint-writer-prod',
        capabilities: ['writeFiles', 'readFiles', 'listFiles'],
        bucketIds: ['4a8b1d3f7c2e9a0b6d4e3f51'],
        namePrefix: 'checkpoints/',
        validDurationInSeconds: 7776000,
      },
    },
    response: {
      status: 200,
      body: {
        accountId: '7f3a91d2c4b8',
        applicationKeyId: '0042c8a4f1e9b32',
        applicationKey: 'K005************************************',
        keyName: 'lumora-checkpoint-writer-prod',
        capabilities: ['writeFiles', 'readFiles', 'listFiles'],
        bucketIds: ['4a8b1d3f7c2e9a0b6d4e3f51'],
        namePrefix: 'checkpoints/',
        expirationTimestamp: 1782259200000,
      },
    },
  },
  {
    id: 'list-keys',
    category: 'Keys',
    name: 'List application keys',
    description: 'List all application keys on the account. The secret applicationKey field is NEVER returned by this call — only on b2_create_key.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_list_keys',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
        maxKeyCount: 100,
      },
    },
    response: {
      status: 200,
      body: {
        keys: [
          {
            applicationKeyId: '0042c8a4f1e9b32',
            keyName: 'lumora-checkpoint-writer-prod',
            capabilities: ['writeFiles', 'readFiles', 'listFiles'],
            bucketIds: ['4a8b1d3f7c2e9a0b6d4e3f51'],
            namePrefix: 'checkpoints/',
            expirationTimestamp: 1782259200000,
          },
        ],
        nextApplicationKeyId: null,
      },
    },
  },
  {
    id: 'list-files',
    category: 'Files',
    name: 'List file versions',
    description: 'Iterate file versions in a bucket. Useful for computing storage totals or building inventory — but Class C transactions add up. Prefer the daily usage CSV for aggregates.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_list_file_versions',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
        prefix: 'checkpoints/',
        maxFileCount: 1000,
      },
    },
    response: {
      status: 200,
      body: {
        files: [
          {
            fileId: '4_z4a8b1d3f7c2e9a0b6d4e3f51_f1180e6c2a31b09c1_d20260425_m191408',
            fileName: 'checkpoints/llama3-70b-step-58200.pt',
            contentLength: 142817392640,
            contentType: 'application/octet-stream',
            uploadTimestamp: 1745609648000,
            action: 'upload',
            serverSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
          },
        ],
        nextFileName: 'checkpoints/llama3-70b-step-58300.pt',
        nextFileId: '4_z4a8b1d3f7c2e9a0b6d4e3f51_f1180e6c2a31b09c1_d20260425_m191542',
      },
    },
  },
  {
    id: 'partner-list-groups',
    category: 'Partner',
    name: 'List partner groups',
    description: 'Partner API v3 — list Groups under your partner account. Each Group can contain up to 5,000 sub-account members. Requires Backblaze Partner Program enrollment.',
    request: {
      method: 'POST',
      url: 'https://api123.backblazeb2.com/b2api/v3/b2_list_groups',
      headers: {
        Authorization: '<partnerAuthToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: 'PARTNER_ACCOUNT_ID',
        maxGroupCount: 100,
      },
    },
    response: {
      status: 200,
      body: {
        groups: [
          {
            groupId: 'kevinco-resellers',
            groupName: 'KevinCo Reseller Tier',
            createdTimestamp: 1718323200000,
            memberCount: 8,
          },
        ],
        nextGroupId: null,
      },
    },
  },
  {
    id: 'partner-list-members',
    category: 'Partner',
    name: 'List partner group members',
    description: 'List sub-accounts in a Group. Use this to populate customer dashboards in a reseller portal.',
    request: {
      method: 'POST',
      url: 'https://api123.backblazeb2.com/b2api/v3/b2_list_group_members',
      headers: {
        Authorization: '<partnerAuthToken>',
        'Content-Type': 'application/json',
      },
      body: {
        groupId: 'kevinco-resellers',
        maxMemberCount: 5000,
      },
    },
    response: {
      status: 200,
      body: {
        members: [
          { accountId: '7f3a91d2c4b8', email: 'platform@lumora.ai', addedTimestamp: 1723420800000 },
          { accountId: '4b5c08fa726d', email: 'infra@halcyonmodels.com', addedTimestamp: 1714435200000 },
        ],
        nextMemberId: null,
      },
    },
  },
  {
    id: 'usage-csv',
    category: 'Reports',
    name: 'Read daily usage CSV',
    description: 'Daily usage data is delivered as a CSV file in a special b2-reports-$ACCOUNTID bucket. There is no JSON usage API. Use this for storage trends, egress, and Class A/B/C transaction counts.',
    request: {
      method: 'GET',
      url: 'https://f005.backblazeb2.com/file/b2-reports-7f3a91d2c4b8/2026-04-25/Usage.csv',
      headers: {
        Authorization: '<authorizationToken>',
      },
      body: null,
    },
    response: {
      status: 200,
      body: '<text/csv>\ndate,group_id,sub_account_id,bucket_id,bucket_name,region,storage_bytes_avg,upload_bytes,download_bytes,class_a_txn,class_b_txn,class_c_txn\n2026-04-25,kevinco-resellers,7f3a91d2c4b8,4a8b1d3f7c2e9a0b6d4e3f51,lumora-training-checkpoints,us-east-005,1849000000000000,23900000000000,9100000000000,15100000,2310000,448000\n...',
    },
  },
];
