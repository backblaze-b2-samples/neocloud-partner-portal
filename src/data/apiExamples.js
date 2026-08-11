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
    id: 'create-bucket',
    category: 'Buckets',
    name: 'Create bucket',
    description: 'Provision a new private bucket for a customer with default SSE-B2 encryption, Object Lock, and a lifecycle rule in a single call. bucketName must be globally unique across all of Backblaze B2.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_create_bucket',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
        bucketName: 'lumora-prod-app-data',
        bucketType: 'allPrivate',
        bucketInfo: { workload: 'app-data' },
        fileLockEnabled: true,
        defaultServerSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
        lifecycleRules: [
          { fileNamePrefix: '', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 30 },
        ],
      },
    },
    response: {
      status: 200,
      body: {
        accountId: '7f3a91d2c4b8',
        bucketId: '9f2c1a7e4d8b3c0a5e6f2d14',
        bucketName: 'lumora-prod-app-data',
        bucketType: 'allPrivate',
        bucketInfo: { workload: 'app-data' },
        corsRules: [],
        defaultServerSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
        fileLockConfiguration: { isFileLockEnabled: true, defaultRetention: { mode: null, period: null } },
        lifecycleRules: [
          { fileNamePrefix: '', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 30 },
        ],
        options: ['s3'],
        revision: 1,
      },
    },
  },
  {
    id: 'update-bucket',
    category: 'Buckets',
    name: 'Update bucket (lifecycle & retention)',
    description: 'Modify an existing bucket — here, set lifecycle rules and a default governance Object Lock retention. Pass ifRevisionIs to make the update conditional on the current revision (optimistic concurrency).',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_update_bucket',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
        defaultRetention: { mode: 'governance', period: { duration: 30, unit: 'days' } },
        lifecycleRules: [
          { fileNamePrefix: 'checkpoints/', daysFromUploadingToHiding: 7, daysFromHidingToDeleting: 30 },
        ],
        ifRevisionIs: 14,
      },
    },
    response: {
      status: 200,
      body: {
        accountId: '7f3a91d2c4b8',
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
        bucketName: 'lumora-training-checkpoints',
        bucketType: 'allPrivate',
        fileLockConfiguration: { isFileLockEnabled: true, defaultRetention: { mode: 'governance', period: { duration: 30, unit: 'days' } } },
        lifecycleRules: [
          { fileNamePrefix: 'checkpoints/', daysFromUploadingToHiding: 7, daysFromHidingToDeleting: 30 },
        ],
        options: ['s3'],
        revision: 15,
      },
    },
  },
  {
    id: 'delete-bucket',
    category: 'Buckets',
    name: 'Delete bucket',
    description: 'Delete a bucket. The bucket must be empty (no current or hidden file versions) or the call fails with bucket_not_empty. Irreversible.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_delete_bucket',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        accountId: '7f3a91d2c4b8',
        bucketId: '9f2c1a7e4d8b3c0a5e6f2d14',
      },
    },
    response: {
      status: 200,
      body: {
        accountId: '7f3a91d2c4b8',
        bucketId: '9f2c1a7e4d8b3c0a5e6f2d14',
        bucketName: 'lumora-prod-app-data',
        bucketType: 'allPrivate',
        lifecycleRules: [],
        revision: 3,
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
    id: 'delete-key',
    category: 'Keys',
    name: 'Delete application key',
    description: 'Revoke an application key by applicationKeyId. Any client still using it immediately starts receiving 401 unauthorized. Irreversible — create a replacement key first to avoid downtime.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_delete_key',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        applicationKeyId: '0042c8a4f1e9b32',
      },
    },
    response: {
      status: 200,
      body: {
        applicationKeyId: '0042c8a4f1e9b32',
        accountId: '7f3a91d2c4b8',
        keyName: 'lumora-checkpoint-writer-prod',
        capabilities: ['writeFiles', 'readFiles', 'listFiles'],
        bucketIds: ['4a8b1d3f7c2e9a0b6d4e3f51'],
        namePrefix: 'checkpoints/',
      },
    },
  },
  {
    id: 'list-files',
    category: 'Files',
    name: 'List file versions',
    description: 'Iterate file versions in a bucket. Useful for computing storage totals or building inventory. Class C list calls are free. Prefer the daily usage CSV for storage aggregates.',
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
    id: 'get-upload-url',
    category: 'Files',
    name: 'Get upload URL',
    description: 'Step 1 of the native upload flow. Returns a one-shot uploadUrl and uploadAuthToken bound to a single bucket. Get a fresh URL per upload thread; on a 503/timeout, request a new one and retry.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_get_upload_url',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
      },
    },
    response: {
      status: 200,
      body: {
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
        uploadUrl: 'https://pod-005-1042-17.backblaze.com/b2api/v4/b2_upload_file/4a8b1d3f7c2e9a0b6d4e3f51/c005_v0512007_t0034',
        authorizationToken: '4_0042c8a4f1e9b32_upl_01234567890_a1b2c3',
      },
    },
  },
  {
    id: 'upload-file',
    category: 'Files',
    name: 'Upload file',
    description: 'Step 2 — POST the raw file bytes to the uploadUrl from b2_get_upload_url. The object key is the X-Bz-File-Name header (URL-encoded); X-Bz-Content-Sha1 lets B2 verify integrity. Object data flows directly to B2, not through the control plane.',
    request: {
      method: 'POST',
      url: 'https://pod-005-1042-17.backblaze.com/b2api/v4/b2_upload_file/4a8b1d3f7c2e9a0b6d4e3f51/c005_v0512007_t0034',
      headers: {
        Authorization: '<uploadAuthToken>',
        'X-Bz-File-Name': 'checkpoints/llama3-70b-step-58400.pt',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '142817392640',
        'X-Bz-Content-Sha1': 'a7c91f0b3e5d8246b1f0c9a2d4e6f8170b3c5d9e',
      },
      body: '<raw file bytes — 142817392640 bytes of checkpoints/llama3-70b-step-58400.pt>',
    },
    response: {
      status: 200,
      body: {
        fileId: '4_z4a8b1d3f7c2e9a0b6d4e3f51_f1180e6c2a31b09c1_d20260426_m084412',
        fileName: 'checkpoints/llama3-70b-step-58400.pt',
        accountId: '7f3a91d2c4b8',
        bucketId: '4a8b1d3f7c2e9a0b6d4e3f51',
        contentLength: 142817392640,
        contentSha1: 'a7c91f0b3e5d8246b1f0c9a2d4e6f8170b3c5d9e',
        contentType: 'application/octet-stream',
        uploadTimestamp: 1745654652000,
        action: 'upload',
      },
    },
  },
  {
    id: 'download-file',
    category: 'Files',
    name: 'Download file by name',
    description: 'Retrieve object bytes by bucket name + file name. Class B download. For private buckets, pass an authorizationToken or a b2_get_download_authorization token. Bytes stream directly from the download host.',
    request: {
      method: 'GET',
      url: 'https://f005.backblazeb2.com/file/lumora-training-checkpoints/checkpoints/llama3-70b-step-58400.pt',
      headers: {
        Authorization: '<authorizationToken>',
      },
      body: null,
    },
    response: {
      status: 200,
      body: '<binary object content — 142817392640 bytes; fileId, contentSha1, and contentType are returned in X-Bz-* response headers>',
    },
  },
  {
    id: 'delete-file',
    category: 'Files',
    name: 'Delete file version',
    description: 'Permanently delete a single file version by fileName + fileId. Irreversible. On a bucket with Object Lock, a locked version cannot be deleted until its retention period expires.',
    request: {
      method: 'POST',
      url: 'https://api005.backblazeb2.com/b2api/v4/b2_delete_file_version',
      headers: {
        Authorization: '<authorizationToken>',
        'Content-Type': 'application/json',
      },
      body: {
        fileName: 'checkpoints/llama3-70b-step-58400.pt',
        fileId: '4_z4a8b1d3f7c2e9a0b6d4e3f51_f1180e6c2a31b09c1_d20260426_m084412',
      },
    },
    response: {
      status: 200,
      body: {
        fileId: '4_z4a8b1d3f7c2e9a0b6d4e3f51_f1180e6c2a31b09c1_d20260426_m084412',
        fileName: 'checkpoints/llama3-70b-step-58400.pt',
      },
    },
  },
  {
    id: 'partner-authorize',
    category: 'Partner',
    name: 'Authorize partner account',
    description: 'Exchange partner application-key credentials for an authorization token. Use the returned authorizationToken and apiUrl for all subsequent Partner API calls.',
    request: {
      method: 'GET',
      url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
      headers: {
        Authorization: 'Basic ' + btoa('PARTNER_KEY_ID:PARTNER_APPLICATION_KEY'),
      },
      body: null,
    },
    response: {
      status: 200,
      body: {
        accountId: 'PARTNER_ACCOUNT_ID',
        apiUrl: 'https://<apiUrl>',
        authorizationToken: '4_0123456789abcdef_01234567_acct_partnertoken',
        allowed: {
          capabilities: ['listGroups', 'manageGroups', 'readGroupMembers', 'writeGroupMembers'],
          buckets: null,
          namePrefix: null,
        },
      },
    },
  },
  {
    id: 'partner-list-groups',
    category: 'Partner',
    name: 'List partner groups',
    description: 'Partner API v3 — list Groups under your partner account. Each Group can contain up to 5,000 sub-account members. Requires Backblaze Partner Program enrollment.',
    request: {
      method: 'GET',
      url: 'https://<apiUrl>/b2api/v3/b2_list_groups?accountId=PARTNER_ACCOUNT_ID',
      headers: {
        Authorization: '<partnerAuthToken>',
      },
      body: null,
    },
    response: {
      status: 200,
      body: {
        groups: [
          {
            groupId: 'neocloud-internal',
            groupName: 'Internal / IT',
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
    name: 'List group members',
    description: 'List sub-accounts in a Group. Use this to populate customer dashboards in a reseller portal.',
    request: {
      method: 'GET',
      url: 'https://<apiUrl>/b2api/v3/b2_list_group_members?groupId=neocloud-internal',
      headers: {
        Authorization: '<partnerAuthToken>',
      },
      body: null,
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
    id: 'partner-create-member',
    category: 'Partner',
    name: 'Create group member',
    description: 'Add a new sub-account to a Group. Creates a Backblaze account for the email address if one does not already exist, then adds it as a Group member.',
    request: {
      method: 'POST',
      url: 'https://<apiUrl>/b2api/v3/b2_create_group_member',
      headers: {
        Authorization: '<partnerAuthToken>',
        'Content-Type': 'application/json',
      },
      body: {
        groupId: 'neocloud-internal',
        email: 'newcustomer@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
      },
    },
    response: {
      status: 200,
      body: {
        accountId: 'c9a04e1f3b72',
        email: 'newcustomer@example.com',
        groupId: 'neocloud-internal',
        addedTimestamp: 1747267200000,
      },
    },
  },
  {
    id: 'partner-eject-member',
    category: 'Partner',
    name: 'Eject group member',
    description: 'Remove a sub-account from a Group. The sub-account continues to exist and retains its data; it simply loses Group membership and partner billing.',
    request: {
      method: 'POST',
      url: 'https://<apiUrl>/b2api/v3/b2_eject_group_member',
      headers: {
        Authorization: '<partnerAuthToken>',
        'Content-Type': 'application/json',
      },
      body: {
        groupId: 'neocloud-internal',
        accountId: '7f3a91d2c4b8',
      },
    },
    response: {
      status: 200,
      body: {},
    },
  },
  {
    id: 'usage-csv',
    category: 'Reports',
    name: 'Read daily usage CSV',
    description: 'Daily usage data is delivered as a CSV file in a special b2-reports-$ACCOUNTID bucket. There is no JSON usage API. Use this for storage trends, egress, and Class A/B/C/D transaction counts. Class D (event notifications) was added by Backblaze in 2026.',
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
      body: '<text/csv>\ndate,group_id,sub_account_id,bucket_id,bucket_name,region,storage_bytes_avg,upload_bytes,download_bytes,class_a_txn,class_b_txn,class_c_txn,class_d_txn\n2026-04-25,neocloud-internal,7f3a91d2c4b8,4a8b1d3f7c2e9a0b6d4e3f51,lumora-training-checkpoints,us-east-005,1849000000000000,23900000000000,9100000000000,15100000,2310000,448000,2820\n...',
    },
  },
];
