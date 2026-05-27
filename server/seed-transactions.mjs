// =============================================================================
// seed-transactions.mjs — Generates Class A / B / C transactions per account.
//
// Class A = uploads        — POST b2_upload_file
// Class B = downloads      — GET  b2_download_file_by_name
// Class C = list / metadata — POST b2_list_buckets, b2_list_file_names,
//                                  b2_get_file_info
//
// Purpose: keep the daily Usage CSV showing live transaction volume across
// every sub-account, even on days when seed-daily.mjs marks an account as
// "dormant". Designed to be cheap — tiny uploads, no storage growth (uploads
// land under a `transactions/` prefix that a daily lifecycle rule can sweep).
//
// Usage (run from project root on EC2):
//   node server/seed-transactions.mjs              # all accounts
//   node server/seed-transactions.mjs --dry-run    # preview only
//   node server/seed-transactions.mjs --account user@host.com
//
// Cron — every hour at :15
//   15 * * * * cd /var/www/backblaze-neocloud-demo && node server/seed-transactions.mjs >> /var/log/neocloud-transactions.log 2>&1
//
// Required env vars (loaded from .env automatically):
//   CREDENTIAL_ENCRYPTION_KEY   Decryption key for stored credentials
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env relative to this file so the script works regardless of CWD
// (PM2 may launch it from /home/ec2-user, not the project root).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import crypto from 'node:crypto';
import { db } from './db.js';

const DRY_RUN  = process.argv.includes('--dry-run');
const ONLY_ACCT = (() => {
  const i = process.argv.indexOf('--account');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const ENC_RAW  = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!ENC_RAW || ENC_RAW.length < 32) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 chars');
  process.exit(1);
}

// SHA-256 the env value to derive a 32-byte AES key (mirrors credentials.js).
const ENC_KEY = crypto.createHash('sha256').update(ENC_RAW, 'utf8').digest();

// ─── Credentials ──────────────────────────────────────────────────────────────

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
    region:           r.region,
    applicationKeyId: r.application_key_id,
    applicationKey:   decryptApplicationKey(r.encrypted_application_key, r.key_iv, r.key_tag),
  }));
}

// ─── B2 API helpers ───────────────────────────────────────────────────────────

async function b2Authorize(keyId, appKey) {
  const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  const res   = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`b2_authorize_account: ${data.message ?? res.status}`);
  return {
    authToken:   data.authorizationToken,
    apiUrl:      data.apiInfo.storageApi.apiUrl,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    accountId:   data.accountId,
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

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function uploadSmall(uploadUrl, authToken, fileName, content, contentType) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:         authToken,
      'X-Bz-File-Name':      encodePath(fileName),
      'Content-Type':        contentType,
      'Content-Length':      String(buf.length),
      'X-Bz-Content-Sha1':   sha1(buf),
      'X-Bz-Info-source':    'seed-transactions',
    },
    body: buf,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`upload ${fileName}: ${data.message ?? res.status}`);
  return data;
}

async function downloadByName(downloadUrl, authToken, bucketName, fileName) {
  const url = `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodePath(fileName)}`;
  const res = await fetch(url, { headers: { Authorization: authToken } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`download ${bucketName}/${fileName}: ${res.status} ${txt.slice(0, 100)}`);
  }
  // Consume body so the connection releases cleanly.
  await res.arrayBuffer();
}

// ─── Per-account activity ─────────────────────────────────────────────────────

// Tunable ranges — every value below is picked at random per account per run
// so the Usage CSV doesn't show suspiciously uniform numbers. Modest by default
// so the script finishes in seconds per account and doesn't bloat storage.
const CLASS_A_RANGE = [3, 25];      // uploads per account
const CLASS_B_RANGE = [2, 18];      // downloads per account
const CLASS_C_LIST_RANGE = [1, 4];  // b2_list_file_names calls per bucket
const UPLOAD_BYTES_RANGE = [512, 8 * 1024];  // 0.5 KB – 8 KB per upload

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const rand = (n) => crypto.randomBytes(n);

async function seedAccountTransactions(cred) {
  const tag = `[${cred.email}]`;
  // Per-run, per-account targets — each account gets its own randomized counts.
  const targetA      = randInt(CLASS_A_RANGE[0], CLASS_A_RANGE[1]);
  const targetB      = randInt(CLASS_B_RANGE[0], CLASS_B_RANGE[1]);
  const listsPerBkt  = randInt(CLASS_C_LIST_RANGE[0], CLASS_C_LIST_RANGE[1]);
  let sub;
  try {
    sub = await b2Authorize(cred.applicationKeyId, cred.applicationKey);
  } catch (e) {
    console.error(`${tag} auth: ${e.message}`);
    return { error: e.message };
  }

  // ── Class C: list buckets ──────────────────────────────────────────────────
  let buckets;
  try {
    const listResp = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_buckets', { accountId: sub.accountId });
    buckets = listResp.buckets || [];
  } catch (e) {
    console.error(`${tag} list_buckets: ${e.message}`);
    return { error: e.message };
  }
  if (buckets.length === 0) {
    console.log(`${tag} no buckets — skipping`);
    return { classA: 0, classB: 0, classC: 1 };
  }

  let classA = 0, classB = 0, classC = 1; // 1 = the list_buckets call above

  // ── Class C: per-bucket file listings ──────────────────────────────────────
  const fileSamples = [];
  for (const b of buckets) {
    if (DRY_RUN) { classC += listsPerBkt; continue; }
    for (let i = 0; i < listsPerBkt; i++) {
      try {
        const r = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_file_names', {
          bucketId: b.bucketId, maxFileCount: 20,
        });
        classC++;
        // Collect filenames for Class B downloads later.
        for (const f of r.files || []) {
          if (fileSamples.length < targetB * 2 && (f.contentLength || 0) < 200_000) {
            fileSamples.push({ bucketName: b.bucketName, fileName: f.fileName });
          }
        }
      } catch (e) {
        // Continue with other buckets if one fails.
        console.warn(`${tag}   list_file_names ${b.bucketName}: ${e.message}`);
      }
    }
  }

  // ── Class A: uploads to the first bucket under transactions/ prefix ────────
  const targetBucket = buckets[0];
  if (!DRY_RUN) {
    let uploadInfo;
    try {
      uploadInfo = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId: targetBucket.bucketId });
      classC++; // get_upload_url is Class C
    } catch (e) {
      console.warn(`${tag}   get_upload_url: ${e.message}`);
    }
    if (uploadInfo) {
      const stamp = ts();
      for (let i = 0; i < targetA; i++) {
        const fileName = `transactions/${stamp}/heartbeat-${String(i).padStart(2, '0')}.bin`;
        try {
          const size = randInt(UPLOAD_BYTES_RANGE[0], UPLOAD_BYTES_RANGE[1]);
          await uploadSmall(uploadInfo.uploadUrl, uploadInfo.authorizationToken, fileName, rand(size), 'application/octet-stream');
          classA++;
        } catch (e) {
          console.warn(`${tag}   upload ${fileName}: ${e.message}`);
        }
      }
    }
  } else {
    classA = targetA;
  }

  // ── Class B: downloads of files we sampled during listings ─────────────────
  if (!DRY_RUN) {
    const picks = fileSamples.sort(() => Math.random() - 0.5).slice(0, targetB);
    for (const p of picks) {
      try {
        await downloadByName(sub.downloadUrl, sub.authToken, p.bucketName, p.fileName);
        classB++;
      } catch (e) {
        console.warn(`${tag}   download ${p.bucketName}/${p.fileName}: ${e.message}`);
      }
    }
  } else {
    classB = Math.min(targetB, fileSamples.length || targetB);
  }

  console.log(`${tag} A=${classA}  B=${classB}  C=${classC}`);
  return { classA, classB, classC };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let creds = loadCredentials();
  if (ONLY_ACCT) creds = creds.filter((c) => c.email === ONLY_ACCT || c.accountId === ONLY_ACCT);
  if (creds.length === 0) {
    console.error('No credentials match.');
    process.exit(1);
  }

  console.log(`Generating transactions for ${creds.length} account(s)${DRY_RUN ? ' (dry-run)' : ''}…\n`);

  let totalA = 0, totalB = 0, totalC = 0, errors = 0;

  // 5 accounts in parallel — modest enough not to hammer B2 rate limits.
  const queue = [...creds];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      if (!c) return;
      const r = await seedAccountTransactions(c);
      if (r.error) errors++;
      else {
        totalA += r.classA || 0;
        totalB += r.classB || 0;
        totalC += r.classC || 0;
      }
    }
  });
  await Promise.all(workers);

  console.log(`\nDone. Class A=${totalA}  B=${totalB}  C=${totalC}  errors=${errors}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
