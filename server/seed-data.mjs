// =============================================================================
// seed-data.mjs — Bulk file seeder for existing NeoCloud demo accounts.
//
// Reads credentials from the encrypted credential store, authorizes each
// sub-account, then uploads a large realistic file tree into every bucket.
// Accounts and buckets must already exist (run seed-trial.mjs first).
//
// Target storage per account type:
//   AI accounts   : ~50 GB  (model weights, dataset shards, eval results)
//   SaaS accounts : ~30 GB  (video/media, user uploads, audit logs)
//   Internal      : ~15 GB  (backup archives, infra snapshots)
//   Total         : ~200 GB across 6 accounts
//
// Usage (run from project root on EC2):
//   node server/seed-data.mjs                       # seed all accounts
//   node server/seed-data.mjs --dry-run             # preview without uploading
//   node server/seed-data.mjs --account customer1-west@neocloud-storage.com
//
// Required env vars (loaded from .env automatically):
//   B2_MASTER_KEY_ID          Master application key ID
//   B2_MASTER_APP_KEY         Master application key
//   CREDENTIAL_ENCRYPTION_KEY Decryption key for stored credentials
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN   = process.argv.includes('--dry-run');
const ONLY_ACCT = (() => {
  const i = process.argv.indexOf('--account');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// ─── Env validation ───────────────────────────────────────────────────────────

const MASTER_KEY_ID  = process.env.B2_MASTER_KEY_ID;
const MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY;
const ENC_KEY_HEX    = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!MASTER_KEY_ID || !MASTER_APP_KEY) {
  console.error('ERROR: B2_MASTER_KEY_ID and B2_MASTER_APP_KEY must be set in .env');
  process.exit(1);
}
if (!ENC_KEY_HEX || ENC_KEY_HEX.length < 32) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters');
  process.exit(1);
}

// ─── Credential decryption (mirrors server/credentials.js exactly) ───────────
//
// credentials.js SHA-256s the env var to get the AES key, then stores three
// separate base64 columns: encrypted_application_key, key_iv, key_tag.
// application_key_id is NOT encrypted — stored plaintext.

// SHA-256 the env value to get a 32-byte AES key — mirrors credentials.js deriveKey()
const ENC_KEY = crypto.createHash('sha256').update(ENC_KEY_HEX, 'utf8').digest();

function decryptApplicationKey(encryptedApplicationKey, keyIv, keyTag) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENC_KEY,
    Buffer.from(keyIv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(keyTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedApplicationKey, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ─── Load credentials from DB ─────────────────────────────────────────────────

// db imported from ./db.js — schema is initialised automatically on import.

function loadCredentials() {
  const rows = db.prepare('SELECT * FROM account_credentials ORDER BY created_at').all();
  return rows.map((r) => ({
    accountId:        r.account_id,
    email:            r.email,
    groupId:          r.group_id,
    region:           r.region,
    applicationKeyId: r.application_key_id,   // plaintext
    applicationKey:   decryptApplicationKey(
      r.encrypted_application_key,
      r.key_iv,
      r.key_tag,
    ),
  }));
}

// ─── B2 helpers ───────────────────────────────────────────────────────────────

async function b2Authorize(keyId, appKey) {
  const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  const res   = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`b2_authorize_account: ${data.message ?? res.status}`);
  return {
    authToken: data.authorizationToken,
    apiUrl:    data.apiInfo.storageApi.apiUrl,
    accountId: data.accountId,
  };
}

async function b2Post(apiUrl, authToken, endpoint, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/b2api/v3/${endpoint}`, {
      method:  'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${endpoint}: ${data.message ?? res.status}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${endpoint}: timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// Upload a file ≤ 5 GB in a single request (content is generated on the fly)
async function uploadSmall(uploadUrl, authToken, fileName, content, contentType) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:           authToken,
      'X-Bz-File-Name':        encodePath(fileName),
      'Content-Type':          contentType,
      'Content-Length':        String(buf.length),
      'X-Bz-Content-Sha1':     sha1(buf),
      'X-Bz-Info-environment': 'demo',
    },
    body: buf,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`upload (${fileName}): ${data.message ?? res.status}`);
  return data;
}

// Upload a large file using concurrent multipart uploads.
// Parts are uploaded PART_CONCURRENCY at a time; each worker fetches its own
// upload URL (required by B2 — URLs are single-use per connection).
async function uploadLarge(apiUrl, authToken, bucketId, fileName, contentType, totalBytes, { log }) {
  const PART             = 20 * 1024 * 1024;  // 20 MB parts — good balance of throughput vs. memory
  const PART_CONCURRENCY = 4;                 // 4 concurrent part uploads

  const started = await b2Post(apiUrl, authToken, 'b2_start_large_file', {
    bucketId, fileName, contentType,
    fileInfo: { 'src_last_modified_millis': String(Date.now()) },
  });

  // Build the list of parts up front
  const parts = [];
  let offset = 0, partNum = 1;
  while (offset < totalBytes) {
    const size = Math.min(PART, totalBytes - offset);
    parts.push({ partNum, size });
    offset += size;
    partNum++;
  }

  const sha1s    = new Array(parts.length);
  let bytesDone  = 0;

  async function uploadPart({ partNum, size }) {
    const buf     = crypto.randomBytes(size);
    const partUrl = await b2Post(apiUrl, authToken, 'b2_get_upload_part_url', { fileId: started.fileId });
    const pres    = await fetch(partUrl.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization:       partUrl.authorizationToken,
        'X-Bz-Part-Number':  String(partNum),
        'Content-Length':    String(size),
        'X-Bz-Content-Sha1': sha1(buf),
      },
      body: buf,
    });
    const pdata = await pres.json();
    if (!pres.ok) throw new Error(`upload_part ${partNum}: ${pdata.message ?? pres.status}`);
    sha1s[partNum - 1] = sha1(buf);
    bytesDone += size;
    const pct = Math.round((bytesDone / totalBytes) * 100);
    process.stdout.write(`\r         ↑ ${fileName}  ${fmt(bytesDone)} / ${fmt(totalBytes)}  ${pct}%  `);
  }

  // Process parts in sliding window of PART_CONCURRENCY
  for (let i = 0; i < parts.length; i += PART_CONCURRENCY) {
    await Promise.all(parts.slice(i, i + PART_CONCURRENCY).map(uploadPart));
  }

  process.stdout.write('\n');
  return b2Post(apiUrl, authToken, 'b2_finish_large_file', { fileId: started.fileId, partSha1Array: sha1s });
}

function fmt(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

// Get or refresh an upload URL, retrying on expiry
async function getUploadUrl(apiUrl, authToken, bucketId) {
  return b2Post(apiUrl, authToken, 'b2_get_upload_url', { bucketId });
}

// Upload a batch of small files into one bucket, refreshing the upload URL as needed
async function uploadBatch(apiUrl, authToken, bucketId, files) {
  let urlData = await getUploadUrl(apiUrl, authToken, bucketId);
  for (const f of files) {
    if (DRY_RUN) { console.log(`    [dry] ${f.path}  (${fmt(f.size ?? (Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(f.content ?? '')))})`); continue; }
    try {
      const content = f.content ?? crypto.randomBytes(f.size);
      await uploadSmall(urlData.uploadUrl, urlData.authorizationToken, f.path, content, f.type);
      console.log(`         ↑ ${f.path}  (${fmt(Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content))})`);
    } catch (e) {
      if (/expired|bad_auth/i.test(e.message)) {
        urlData = await getUploadUrl(apiUrl, authToken, bucketId);
        const content = f.content ?? crypto.randomBytes(f.size);
        await uploadSmall(urlData.uploadUrl, urlData.authorizationToken, f.path, content, f.type);
        console.log(`         ↑ ${f.path}  (retry)`);
      } else {
        console.error(`    ✗ ${f.path}: ${e.message}`);
      }
    }
  }
}

// ─── File tree definitions ────────────────────────────────────────────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Returns { smallFiles, largeFiles } for a bucket
function filePlan(bucketName, accountType, seq) {
  // seq = index of the account within its type (0, 1, …)
  const s = seq;

  // ── AI: model checkpoints + datasets ──────────────────────────────────────
  if (accountType === 'ai' && bucketName.includes('checkpoints')) return {
    small: [
      { path: `checkpoints/run-${s + 1}00/epoch-001/config.json`,
        content: JSON.stringify({ epoch: 1, lr: 1e-3, loss: 0.8841, acc: 0.6210, timestamp: new Date().toISOString() }, null, 2),
        type: 'application/json' },
      { path: `checkpoints/run-${s + 1}00/epoch-010/config.json`,
        content: JSON.stringify({ epoch: 10, lr: 5e-4, loss: 0.2901, acc: 0.8917, timestamp: new Date().toISOString() }, null, 2),
        type: 'application/json' },
      { path: `checkpoints/run-${s + 1}00/epoch-020/config.json`,
        content: JSON.stringify({ epoch: 20, lr: 1e-4, loss: 0.1831, acc: 0.9344, timestamp: new Date().toISOString(), best: true }, null, 2),
        type: 'application/json' },
      { path: `eval/run-${s + 1}00/metrics.json`,
        content: JSON.stringify({ bleu: 0.783, rouge1: 0.841, rouge2: 0.712, rougeL: 0.801, perplexity: 4.12 }, null, 2),
        type: 'application/json' },
      { path: `eval/run-${s + 1}00/confusion-matrix.csv`,
        content: 'class,tp,fp,fn\nlabel_0,4821,132,97\nlabel_1,3944,88,221\nlabel_2,5102,41,78\n',
        type: 'text/csv' },
    ],
    large: [
      { path: `checkpoints/run-${s + 1}00/epoch-010/model.safetensors`,  bytes: 14 * GB, type: 'application/octet-stream' },
      { path: `checkpoints/run-${s + 1}00/epoch-020/model.safetensors`,  bytes: 14 * GB, type: 'application/octet-stream' },
      { path: `checkpoints/run-${s + 1}00/epoch-020/optimizer.pt`,       bytes: 6 * GB,  type: 'application/octet-stream' },
    ],
  };

  if (accountType === 'ai' && bucketName.includes('datasets')) return {
    small: [
      { path: 'datasets/raw/manifest.json',
        content: JSON.stringify({ shards: 20, totalRows: 8_200_000, schema: ['id','text','label','source'], created: new Date().toISOString() }, null, 2),
        type: 'application/json' },
      { path: 'datasets/processed/vocab.json',
        content: JSON.stringify({ size: 50257, unk: '<unk>', pad: '<pad>', bos: '<s>', eos: '</s>' }, null, 2),
        type: 'application/json' },
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `datasets/raw/shard-${String(i + 1).padStart(3, '0')}.parquet`,
        size: 120 * MB,
        type: 'application/octet-stream',
      })),
    ],
    large: [
      { path: 'datasets/processed/train-embeddings.bin',  bytes: 8 * GB, type: 'application/octet-stream' },
      { path: 'datasets/processed/val-embeddings.bin',    bytes: 2 * GB, type: 'application/octet-stream' },
    ],
  };

  if (accountType === 'ai' && bucketName.includes('embeddings')) return {
    small: [
      { path: 'embeddings/metadata.json',
        content: JSON.stringify({ model: 'sentence-transformer-v3', dims: 768, vectors: 4_000_000, indexType: 'HNSW', created: new Date().toISOString() }, null, 2),
        type: 'application/json' },
      { path: 'embeddings/index-stats.json',
        content: JSON.stringify({ M: 16, efConstruction: 200, efSearch: 64, size: '12.4 GB', built: new Date().toISOString() }, null, 2),
        type: 'application/json' },
    ],
    large: [
      { path: 'embeddings/index-v3.bin',  bytes: 12 * GB, type: 'application/octet-stream' },
      { path: 'embeddings/raw-v3.bin',    bytes: 4 * GB,  type: 'application/octet-stream' },
    ],
  };

  // ── SaaS: media / video ────────────────────────────────────────────────────
  if (accountType === 'saas' && bucketName.includes('uploads')) return {
    small: [
      ...Array.from({ length: 30 }, (_, i) => ({
        path: `uploads/images/2026/05/${String(i + 1).padStart(2, '0')}/product-${1000 + i}.jpg`,
        size: 800 * 1024,
        type: 'image/jpeg',
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `uploads/documents/2026/05/${String(i + 1).padStart(2, '0')}/invoice-2026-${1000 + i}.pdf`,
        size: 400 * 1024,
        type: 'application/pdf',
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        path: `logs/2026/05/${String(i % 7 + 1).padStart(2, '0')}/access-${i}.log`,
        content: Array.from({ length: 100 }, (_, j) => `[2026-05-${String(i % 7 + 1).padStart(2,'0')}T${String(j % 24).padStart(2,'0')}:00:00Z] GET /api/v1/products/${j} 200 ${20 + j}ms`).join('\n') + '\n',
        type: 'text/plain',
      })),
    ],
    large: [
      { path: 'uploads/video/2026/05/01/webinar-q2-kickoff.mp4', bytes: 4 * GB,  type: 'video/mp4' },
      { path: 'uploads/video/2026/05/07/product-demo-v2.mp4',   bytes: 2 * GB,  type: 'video/mp4' },
    ],
  };

  if (accountType === 'saas' && bucketName.includes('assets')) return {
    small: [
      { path: 'assets/app.js',        size: 2 * MB,    type: 'application/javascript' },
      { path: 'assets/app.css',       size: 400 * 1024, type: 'text/css' },
      { path: 'assets/logo-2x.png',   size: 150 * 1024, type: 'image/png' },
      { path: 'assets/logo-dark.png', size: 120 * 1024, type: 'image/png' },
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `assets/icons/icon-${i + 1}.svg`,
        content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="${6 + i % 4}"/></svg>`,
        type: 'image/svg+xml',
      })),
    ],
    large: [],
  };

  if (accountType === 'saas' && bucketName.includes('audit')) return {
    small: Array.from({ length: 60 }, (_, i) => ({
      path: `audit/2026/${String(Math.floor(i / 30) + 4).padStart(2,'0')}/${String((i % 30) + 1).padStart(2,'0')}/events.log`,
      content: Array.from({ length: 200 }, (_, j) =>
        `[2026-05-${String((i % 30) + 1).padStart(2,'0')}T${String(j % 24).padStart(2,'0')}:${String(j % 60).padStart(2,'0')}:00Z] user:u${1000 + j} action:${['login','view','export','update'][j % 4]} resource:r${j} ip:203.0.113.${j % 256} result:success`
      ).join('\n') + '\n',
      type: 'text/plain',
    })),
    large: [
      { path: 'audit/archive/2026-q1-events.tar.gz', bytes: 3 * GB, type: 'application/gzip' },
    ],
  };

  // ── Internal: backup archives ──────────────────────────────────────────────
  if (accountType === 'internal' && bucketName.includes('sysbackups')) return {
    small: [
      ...Array.from({ length: 14 }, (_, i) => ({
        path: `manifests/restore-point-2026-04-${String(i + 1).padStart(2,'0')}.json`,
        content: JSON.stringify({ type: 'full', sourceHost: `prod-app-0${(i % 3) + 1}`, sizeBytes: (50 + i) * GB, checksum: crypto.randomBytes(20).toString('hex'), created: `2026-04-${String(i + 1).padStart(2,'0')}T02:00:00Z` }, null, 2),
        type: 'application/json',
      })),
      ...Array.from({ length: 14 }, (_, i) => ({
        path: `backups/incremental/2026-05-${String(i + 1).padStart(2,'0')}/delta.manifest`,
        content: `delta_base: 2026-04-${String(i + 1).padStart(2,'0')}\ndelta_size_bytes: ${(200 + i * 50) * MB}\n`,
        type: 'text/plain',
      })),
    ],
    large: [
      { path: 'backups/daily/2026-04-28/system-full.tar.gz',    bytes: 12 * GB, type: 'application/gzip' },
      { path: 'backups/daily/2026-05-01/system-full.tar.gz',    bytes: 13 * GB, type: 'application/gzip' },
      { path: 'backups/daily/2026-05-07/system-full.tar.gz',    bytes: 13 * GB, type: 'application/gzip' },
      { path: 'backups/database/2026-05-07/postgres-prod.dump', bytes: 4 * GB,  type: 'application/octet-stream' },
    ],
  };

  if (accountType === 'internal' && bucketName.includes('infra')) return {
    small: [
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `releases/v1.${i + 2}.0/manifest.json`,
        content: JSON.stringify({ version: `1.${i + 2}.0`, builtAt: `2026-0${Math.floor(i / 3) + 2}-${String((i % 28) + 1).padStart(2,'0')}T12:00:00Z`, sha256: crypto.randomBytes(32).toString('hex') }, null, 2),
        type: 'application/json',
      })),
      { path: 'configs/network-topology.json',
        content: JSON.stringify({ version: '2.0', subnets: ['10.0.1.0/24','10.0.2.0/24','10.0.3.0/24'], vpnPeers: 3, updated: new Date().toISOString() }, null, 2),
        type: 'application/json' },
      { path: 'configs/terraform.tfstate',
        content: JSON.stringify({ version: 4, serial: 142, resources: Array.from({ length: 20 }, (_, i) => ({ type: `aws_${['s3_bucket','ec2_instance','rds_instance','iam_role'][i % 4]}`, name: `resource-${i}` })) }, null, 2),
        type: 'application/json' },
    ],
    large: [
      { path: 'releases/artifacts/v1.10.0/app-bundle.tar.gz',  bytes: 800 * MB, type: 'application/gzip' },
      { path: 'releases/artifacts/v1.11.0/app-bundle.tar.gz',  bytes: 850 * MB, type: 'application/gzip' },
    ],
  };

  // Default fallback
  return {
    small: [{ path: 'README.md', content: `# NeoCloud Demo Bucket\nSeeded: ${new Date().toISOString()}\n`, type: 'text/markdown' }],
    large: [],
  };
}

// ─── Account type inference ───────────────────────────────────────────────────
// Group IDs: 165914 = internal, 165915 = AI customers, 165916 = SaaS customers

function inferType(cred) {
  if (cred.groupId === '165914') return 'internal';
  if (cred.groupId === '165915') return 'ai';
  if (cred.groupId === '165916') return 'saas';
  return 'saas';  // safe default
}

// seq is the 0-based index of this account within its type group.
// Computed in main() so file paths are varied across accounts of the same type.
function computeSeqMap(creds) {
  const counters = {};
  const map = new Map();
  for (const c of creds) {
    const t = inferType(c);
    counters[t] = (counters[t] ?? 0);
    map.set(c, counters[t]++);
  }
  return map;
}

function inferSubType(email) {
  if (email.includes('johnson')) return 'backup';
  if (email.includes('rivera')) return 'infra';
  return null;
}

// ─── Per-account seeding ──────────────────────────────────────────────────────

async function seedData(cred, seq = 0) {
  const tag   = `[${cred.email}]`;
  const atype = inferType(cred);

  console.log(`\n${tag}  type:${atype}  region:${cred.region}`);

  // Authorize sub-account
  let sub;
  try {
    sub = await b2Authorize(cred.applicationKeyId, cred.applicationKey);
    console.log(`  ✓ Authorized  accountId:${sub.accountId}`);
  } catch (e) {
    console.error(`  ✗ Auth failed: ${e.message}`);
    return;
  }

  // List buckets
  let buckets;
  try {
    const data = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_buckets', { accountId: sub.accountId });
    buckets = data.buckets ?? [];
    console.log(`  ✓ Found ${buckets.length} bucket(s): ${buckets.map(b => b.bucketName).join(', ')}`);
  } catch (e) {
    console.error(`  ✗ list_buckets failed: ${e.message}`);
    return;
  }

  let totalBytes = 0;

  for (const bucket of buckets) {
    const { bucketId, bucketName } = bucket;
    const { small, large } = filePlan(bucketName, atype, seq);

    const smallBytes = small.reduce((s, f) => {
      const c = f.content;
      return s + (f.size ?? (c == null ? 0 : Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c)));
    }, 0);
    const largeBytes = large.reduce((s, f) => s + f.bytes, 0);
    const bucketTotal = smallBytes + largeBytes;

    console.log(`\n  ── ${bucketName}  (${fmt(smallBytes)} small + ${fmt(largeBytes)} large = ${fmt(bucketTotal)})`);

    if (DRY_RUN) {
      for (const f of small) console.log(`    [dry-small] ${f.path}  ${fmt(f.size ?? Buffer.byteLength(f.content ?? ''))}`);
      for (const f of large) console.log(`    [dry-large] ${f.path}  ${fmt(f.bytes)}`);
      totalBytes += bucketTotal;
      continue;
    }

    // Upload small files
    if (small.length > 0) {
      await uploadBatch(sub.apiUrl, sub.authToken, bucketId, small);
    }

    // Upload large files (multipart, 2 files concurrently per bucket)
    const LARGE_CONCURRENCY = 2;
    for (let i = 0; i < large.length; i += LARGE_CONCURRENCY) {
      await Promise.all(large.slice(i, i + LARGE_CONCURRENCY).map(async (lf) => {
        try {
          await uploadLarge(sub.apiUrl, sub.authToken, bucketId, lf.path, lf.type, lf.bytes, { log: console.log });
          console.log(`    ✓ ${lf.path}  (${fmt(lf.bytes)})`);
        } catch (e) {
          console.error(`    ✗ ${lf.path}: ${e.message}`);
        }
      }));
    }

    totalBytes += bucketTotal;
  }

  console.log(`  ── done  total: ${fmt(totalBytes)}`);
  return totalBytes;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const hr = '═'.repeat(64);
  console.log(`\n${hr}`);
  console.log(`  NeoCloud B2 — Bulk Data Seed${DRY_RUN ? '  [DRY RUN]' : ''}`);
  console.log(`  Time : ${new Date().toISOString()}`);
  console.log(hr);

  let creds = loadCredentials();
  if (!creds.length) {
    console.error('ERROR: No credentials found in DB. Run seed-trial.mjs first.');
    process.exit(1);
  }
  if (ONLY_ACCT) {
    creds = creds.filter(c => c.email === ONLY_ACCT);
    if (!creds.length) {
      console.error(`ERROR: No credential found for ${ONLY_ACCT}`);
      process.exit(1);
    }
  }

  console.log(`\nFound ${creds.length} account(s) in DB:`);
  for (const c of creds) console.log(`  ${c.email}  (${c.region})`);

  // Compute per-type sequence numbers so each account gets varied file paths
  const seqMap = computeSeqMap(creds);

  let grandTotal = 0;
  for (const cred of creds) {
    const bytes = await seedData(cred, seqMap.get(cred) ?? 0);
    if (bytes) grandTotal += bytes;
  }

  console.log(`\n${hr}`);
  console.log(`  ${DRY_RUN ? 'Dry-run' : 'Seed'} complete.  Grand total: ${fmt(grandTotal)}`);
  console.log(`${hr}\n`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
