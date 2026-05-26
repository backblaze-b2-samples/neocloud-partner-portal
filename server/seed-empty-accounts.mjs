// =============================================================================
// seed-empty-accounts.mjs — Lightweight bucket + file seeder for empty accounts.
//
// Walks every credential in account_credentials. For any account with zero
// buckets, creates 2 buckets and uploads ~100-400 MB of realistic-looking
// demo files. Skips accounts that already have buckets — idempotent.
//
// No multipart uploads; everything is a single PUT. Designed to take ~1 minute
// per account so the demo portal looks populated quickly.
//
// Usage (run on the EC2 host):
//   node server/seed-empty-accounts.mjs
//   node server/seed-empty-accounts.mjs --dry-run
//   node server/seed-empty-accounts.mjs --account customer1-east@neocloud-storage.com
//
// Required env vars (loaded from .env):
//   CREDENTIAL_ENCRYPTION_KEY  Decryption key for stored credentials
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from './db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_ACCT = (() => {
  const i = process.argv.indexOf('--account');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const ENC_RAW = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!ENC_RAW || ENC_RAW.length < 32) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 chars');
  process.exit(1);
}

// SHA-256 the env value to derive a 32-byte AES key (mirrors credentials.js)
const ENC_KEY = crypto.createHash('sha256').update(ENC_RAW, 'utf8').digest();

const MB = 1024 * 1024;
const KB = 1024;

// ─── Decryption ───────────────────────────────────────────────────────────────

function decryptApplicationKey(encryptedApplicationKey, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedApplicationKey, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function loadCredentials() {
  const rows = db.prepare('SELECT * FROM account_credentials ORDER BY email').all();
  return rows.map((r) => ({
    accountId:        r.account_id,
    email:            r.email,
    groupId:          r.group_id,
    region:           r.region,
    applicationKeyId: r.application_key_id,
    applicationKey:   decryptApplicationKey(r.encrypted_application_key, r.key_iv, r.key_tag),
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

async function b2Post(apiUrl, authToken, endpoint, body) {
  const res = await fetch(`${apiUrl}/b2api/v3/${endpoint}`, {
    method:  'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${endpoint}: ${data.message ?? res.status}`);
  return data;
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

async function uploadFile(uploadUrl, authToken, fileName, content, contentType) {
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

// ─── Demo plan ────────────────────────────────────────────────────────────────

function inferType(cred) {
  if (cred.groupId === '165914') return 'internal';
  if (cred.groupId === '165915') return 'ai';
  if (cred.groupId === '165916') return 'saas';
  return 'saas';
}

// Bucket names must be globally unique; suffix with first 6 chars of accountId.
function bucketNames(cred, type) {
  const local  = cred.email.split('@')[0].replace(/[._]/g, '-');
  const suffix = cred.accountId.slice(0, 6);
  if (type === 'ai') {
    return [`${local}-checkpoints-${suffix}`, `${local}-datasets-${suffix}`];
  }
  if (type === 'internal') {
    return [`${local}-backups-${suffix}`, `${local}-infra-${suffix}`];
  }
  return [`${local}-uploads-${suffix}`, `${local}-archive-${suffix}`];
}

// Generate ~100-400 MB across small + medium files per bucket.
// Variable per-account so the demo isn't uniform.
function filePlan(bucketName, type, seq) {
  const mediumSize = 80 * MB + (seq % 5) * 20 * MB;          // 80-160 MB
  const altMedium  = 60 * MB + ((seq + 1) % 4) * 30 * MB;    // 60-150 MB

  if (type === 'ai' && bucketName.includes('checkpoints')) {
    return {
      small: [
        { path: `run-${seq + 1}00/config.json`,
          content: JSON.stringify({ epoch: 20, lr: 1e-4, loss: 0.183, acc: 0.934, seeded: new Date().toISOString() }, null, 2),
          type: 'application/json' },
        { path: `run-${seq + 1}00/metrics.csv`,
          content: 'epoch,loss,acc\n1,0.88,0.62\n10,0.29,0.89\n20,0.18,0.93\n',
          type: 'text/csv' },
        { path: 'README.md',
          content: `# Checkpoint bucket\nSeeded ${new Date().toISOString()}\n`,
          type: 'text/markdown' },
      ],
      medium: [
        { path: `run-${seq + 1}00/model.safetensors`, bytes: mediumSize, type: 'application/octet-stream' },
        { path: `run-${seq + 1}00/optimizer.pt`,      bytes: altMedium,  type: 'application/octet-stream' },
      ],
    };
  }
  if (type === 'ai' && bucketName.includes('datasets')) {
    return {
      small: [
        { path: 'manifest.json',
          content: JSON.stringify({ shards: 10, schema: ['id', 'text', 'label'], seeded: new Date().toISOString() }, null, 2),
          type: 'application/json' },
        ...Array.from({ length: 4 }, (_, i) => ({
          path: `raw/shard-${String(i + 1).padStart(3, '0')}.parquet`,
          bytes: 5 * MB,
          type: 'application/octet-stream',
        })),
      ],
      medium: [
        { path: 'embeddings/train.bin', bytes: mediumSize, type: 'application/octet-stream' },
      ],
    };
  }
  if (type === 'internal' && bucketName.includes('backups')) {
    return {
      small: Array.from({ length: 5 }, (_, i) => ({
        path: `manifests/restore-2026-05-${String(i + 1).padStart(2, '0')}.json`,
        content: JSON.stringify({ type: 'full', host: `prod-app-0${i + 1}`, sizeBytes: 50 * 1024 * MB, seeded: new Date().toISOString() }, null, 2),
        type: 'application/json',
      })),
      medium: [
        { path: 'daily/2026-05-07/system-full.tar.gz', bytes: mediumSize, type: 'application/gzip' },
      ],
    };
  }
  if (type === 'internal' && bucketName.includes('infra')) {
    return {
      small: [
        { path: 'configs/network.json',
          content: JSON.stringify({ version: '2.0', subnets: ['10.0.1.0/24', '10.0.2.0/24'], seeded: new Date().toISOString() }, null, 2),
          type: 'application/json' },
        { path: 'configs/terraform.tfstate',
          content: JSON.stringify({ version: 4, serial: 142 }, null, 2),
          type: 'application/json' },
      ],
      medium: [
        { path: 'releases/app-bundle-v1.10.tar.gz', bytes: altMedium, type: 'application/gzip' },
      ],
    };
  }
  if (type === 'saas' && bucketName.includes('uploads')) {
    return {
      small: [
        ...Array.from({ length: 6 }, (_, i) => ({
          path: `images/2026/05/product-${1000 + i}.jpg`,
          bytes: 200 * KB,
          type: 'image/jpeg',
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          path: `documents/invoice-${2000 + i}.pdf`,
          bytes: 300 * KB,
          type: 'application/pdf',
        })),
      ],
      medium: [
        { path: 'video/webinar-q2.mp4', bytes: mediumSize, type: 'video/mp4' },
      ],
    };
  }
  if (type === 'saas' && bucketName.includes('archive')) {
    return {
      small: Array.from({ length: 8 }, (_, i) => ({
        path: `audit/2026-05/events-${String(i + 1).padStart(2, '0')}.log`,
        content: Array.from({ length: 50 }, (_, j) =>
          `[2026-05-${String(i + 1).padStart(2, '0')}T${String(j % 24).padStart(2, '0')}:00:00Z] user:u${1000 + j} action:view`
        ).join('\n') + '\n',
        type: 'text/plain',
      })),
      medium: [
        { path: 'archive/2026-q1-events.tar.gz', bytes: altMedium, type: 'application/gzip' },
      ],
    };
  }
  // Default fallback
  return {
    small: [{ path: 'README.md', content: `# Demo Bucket\nSeeded ${new Date().toISOString()}\n`, type: 'text/markdown' }],
    medium: [{ path: 'sample/data.bin', bytes: mediumSize, type: 'application/octet-stream' }],
  };
}

function fmtBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

// Pre-generated 1-MB block of pseudo-random bytes. Re-used to construct larger
// buffers via concatenation — generating fresh random bytes for hundreds of MB
// is needlessly slow and CPU-heavy.
const ONE_MB_RANDOM = crypto.randomBytes(MB);

function makeBuffer(size) {
  if (size <= MB) return crypto.randomBytes(size);
  const fullChunks  = Math.floor(size / MB);
  const remainder   = size - fullChunks * MB;
  const parts = [];
  for (let i = 0; i < fullChunks; i++) parts.push(ONE_MB_RANDOM);
  if (remainder) parts.push(ONE_MB_RANDOM.subarray(0, remainder));
  return Buffer.concat(parts);
}

// ─── Per-account seeding ─────────────────────────────────────────────────────

async function seedAccount(cred, seq) {
  const tag  = `[${cred.email}]`;
  const type = inferType(cred);

  let sub;
  try {
    sub = await b2Authorize(cred.applicationKeyId, cred.applicationKey);
  } catch (e) {
    console.error(`${tag} auth failed: ${e.message}`);
    return { ...cred, error: e.message };
  }

  // Idempotent guard: skip only if buckets ALREADY contain files.
  // Accounts where bucket-creation succeeded but uploads failed (or were killed
  // mid-run) have empty buckets — those still need seeding.
  const listResp = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_buckets', { accountId: sub.accountId });
  const existingBuckets = listResp.buckets ?? [];

  if (existingBuckets.length > 0) {
    // Probe each bucket for any file. First hit short-circuits the check.
    let anyFiles = false;
    for (const b of existingBuckets) {
      const probe = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_file_names', {
        bucketId: b.bucketId, maxFileCount: 1,
      });
      if ((probe.files ?? []).length > 0) { anyFiles = true; break; }
    }
    if (anyFiles) {
      console.log(`${tag} SKIP — already has ${existingBuckets.length} bucket(s) with files`);
      return { ...cred, skipped: true };
    }
    console.log(`${tag} REFILL — ${existingBuckets.length} empty bucket(s), uploading files`);
  }

  const buckets = [...existingBuckets];

  // Only create buckets if the account has none.
  if (existingBuckets.length === 0) {
    const [name1, name2] = bucketNames(cred, type);
    for (const bucketName of [name1, name2]) {
      if (DRY_RUN) {
        console.log(`${tag}   [dry] would create bucket: ${bucketName}`);
        buckets.push({ bucketId: 'dry-run', bucketName });
        continue;
      }
      try {
        const created = await b2Post(sub.apiUrl, sub.authToken, 'b2_create_bucket', {
          accountId:  sub.accountId,
          bucketName,
          bucketType: 'allPrivate',
        });
        buckets.push(created);
        console.log(`${tag}   ✓ created bucket: ${bucketName}`);
      } catch (e) {
        console.error(`${tag}   ✗ create_bucket ${bucketName}: ${e.message}`);
      }
    }
  }

  let totalBytes = 0;

  for (const b of buckets) {
    const plan = filePlan(b.bucketName, type, seq);
    const fileList = [
      ...plan.small.map((f) => ({ ...f, size: f.bytes ?? Buffer.byteLength(f.content ?? '') })),
      ...plan.medium.map((f) => ({ ...f, size: f.bytes })),
    ];
    const bucketBytes = fileList.reduce((s, f) => s + f.size, 0);

    if (DRY_RUN) {
      console.log(`${tag}   [dry] ${b.bucketName}: ${fileList.length} files, ${fmtBytes(bucketBytes)}`);
      totalBytes += bucketBytes;
      continue;
    }

    // Get a fresh upload URL per bucket
    const uploadInfo = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId: b.bucketId });

    for (const f of fileList) {
      const content = f.content != null ? f.content : makeBuffer(f.bytes);
      try {
        await uploadFile(uploadInfo.uploadUrl, uploadInfo.authorizationToken, f.path, content, f.type);
        totalBytes += f.size;
      } catch (e) {
        console.error(`${tag}     ✗ ${f.path}: ${e.message}`);
      }
    }
    console.log(`${tag}   ✓ ${b.bucketName}: uploaded ${fileList.length} files (${fmtBytes(bucketBytes)})`);
  }

  console.log(`${tag} done — total ${fmtBytes(totalBytes)}`);
  return { ...cred, totalBytes, bucketCount: buckets.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let creds = loadCredentials();
  if (ONLY_ACCT) creds = creds.filter((c) => c.email === ONLY_ACCT || c.accountId === ONLY_ACCT);
  if (creds.length === 0) {
    console.error('No credentials match.');
    process.exit(1);
  }

  console.log(`Seeding ${creds.length} account(s)${DRY_RUN ? ' (dry-run)' : ''}…\n`);

  // Modest concurrency — 3 accounts at a time. Each account is sequential
  // internally (creating buckets then uploading files in series).
  const queue = creds.map((c, i) => ({ cred: c, seq: i }));
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await seedAccount(next.cred, next.seq);
    }
  });
  await Promise.all(workers);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
