// =============================================================================
// check-data.mjs — Report stored data per sub-account.
//
// Walks every credential in account_credentials, authorizes each sub-account,
// and tallies bytes + bucket + file counts. Prints a sorted table at the end:
//
//   STATUS  EMAIL                              BUCKETS  FILES         BYTES
//   data    customer1-east@neocloud.com              3   1,204    52.4 GB
//   empty   customer-new@neocloud.com                1       0       0  B
//
// Read-only — uploads nothing. Safe to run any time.
//
// Usage (run on the EC2 host):
//   node server/check-data.mjs
//   node server/check-data.mjs --account customer1-east@neocloud.com
//   node server/check-data.mjs --json
//
// Required env vars (loaded from .env):
//   CREDENTIAL_ENCRYPTION_KEY  Decryption key for stored credentials
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from './db.js';

const ONLY_ACCT  = (() => {
  const i = process.argv.indexOf('--account');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const JSON_OUT  = process.argv.includes('--json');
const ENC_RAW   = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!ENC_RAW || ENC_RAW.length < 32) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 chars');
  process.exit(1);
}

// SHA-256 the env value to get a 32-byte AES key — mirrors credentials.js deriveKey()
const ENC_KEY = crypto.createHash('sha256').update(ENC_RAW, 'utf8').digest();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function fmtBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

// ─── Per-account walk ─────────────────────────────────────────────────────────

async function checkAccount(cred) {
  let sub;
  try {
    sub = await b2Authorize(cred.applicationKeyId, cred.applicationKey);
  } catch (e) {
    return { ...cred, error: `auth: ${e.message}` };
  }

  let buckets;
  try {
    const data = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_buckets', { accountId: sub.accountId });
    buckets = data.buckets ?? [];
  } catch (e) {
    return { ...cred, error: `list_buckets: ${e.message}` };
  }

  let totalBytes = 0;
  let totalFiles = 0;

  for (const b of buckets) {
    // Paginate b2_list_file_names. Cap at 50k files per bucket to avoid spending
    // an hour on a single huge bucket — anything past that is "definitely has data".
    let startFileName = null;
    let pages = 0;
    while (true) {
      const data = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_file_names', {
        bucketId:     b.bucketId,
        startFileName,
        maxFileCount: 10_000,
      });
      const files = data.files ?? [];
      for (const f of files) totalBytes += (f.contentLength ?? 0);
      totalFiles += files.length;
      startFileName = data.nextFileName || null;
      pages += 1;
      if (!startFileName) break;
      if (pages >= 5) break; // 50k files — enough to classify as non-empty
    }
  }

  return {
    ...cred,
    bucketCount: buckets.length,
    totalBytes,
    totalFiles,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let creds = loadCredentials();
  if (ONLY_ACCT) creds = creds.filter((c) => c.email === ONLY_ACCT || c.accountId === ONLY_ACCT);
  if (creds.length === 0) {
    console.error('No credentials match.');
    process.exit(1);
  }

  if (!JSON_OUT) {
    console.log(`\nChecking ${creds.length} account(s)…`);
  }

  // Run concurrently (5 at a time) — each account hits its own auth endpoint.
  const results = [];
  const queue = [...creds];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const cred = queue.shift();
      const r = await checkAccount(cred);
      results.push(r);
      if (!JSON_OUT) {
        const status = r.error ? '✗' : (r.totalBytes > 0 ? '·' : '○');
        process.stdout.write(status);
      }
    }
  });
  await Promise.all(workers);

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Sort: errors first, then empty, then by bytes ascending.
  results.sort((a, b) => {
    if (a.error && !b.error) return -1;
    if (!a.error && b.error) return 1;
    return (a.totalBytes ?? 0) - (b.totalBytes ?? 0);
  });

  console.log('\n');
  console.log('STATUS  REGION       EMAIL                                            BUCKETS    FILES        BYTES');
  console.log('──────  ───────────  ───────────────────────────────────────────────  ───────  ───────  ───────────');

  let withData = 0, empty = 0, errored = 0, totalBytes = 0;

  for (const r of results) {
    const email   = (r.email || r.accountId).padEnd(47).slice(0, 47);
    const region  = (r.region || '—').padEnd(11);
    if (r.error) {
      errored++;
      console.log(`ERROR   ${region}  ${email}    error: ${r.error}`);
      continue;
    }
    const bytes   = fmtBytes(r.totalBytes).padStart(11);
    const files   = fmtNum(r.totalFiles).padStart(7);
    const buckets = String(r.bucketCount).padStart(7);
    if (r.totalBytes > 0) {
      withData++;
      totalBytes += r.totalBytes;
      console.log(`data    ${region}  ${email}  ${buckets}  ${files}  ${bytes}`);
    } else {
      empty++;
      console.log(`empty   ${region}  ${email}  ${buckets}  ${files}  ${bytes}`);
    }
  }

  console.log('──────  ───────────  ───────────────────────────────────────────────  ───────  ───────  ───────────');
  console.log(`\nSummary: ${withData} with data · ${empty} empty · ${errored} errored · ${fmtBytes(totalBytes)} total\n`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
