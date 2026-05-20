// =============================================================================
// seed-daily.mjs — Daily activity simulator for NeoCloud demo accounts.
//
// Runs once per day (via cron at 3 AM PST / 11:00 UTC) to simulate realistic
// production behavior across all customer accounts. Each account receives a
// stable behavioral profile; a per-day hash introduces natural variance.
//
// Profiles (assigned by hash of accountId — stable across runs):
//   dormant   (≈15%) — no uploads, no downloads. Churned / paused account.
//   declining (≈15%) — no ingest; occasional downloads; deletes a few files.
//   active    (≈50%) — daily log/metric uploads + moderate egress.
//   high      (≈20%) — heavy daily uploads + large egress. Power user.
//
// Daily variance: deterministic hash of (accountId + date) drives upload count,
// file sizes, and egress volume — so every day looks different but the script
// is fully idempotent (datestamped paths; re-running the same date is safe).
//
// Usage (run from project root on EC2):
//   node server/seed-daily.mjs                       # simulate today
//   node server/seed-daily.mjs --dry-run             # preview without I/O
//   node server/seed-daily.mjs --date 2026-05-10     # back-fill a past date
//   node server/seed-daily.mjs --account u@host.com  # single account only
//
// Cron (3 AM PST = 11:00 UTC):
//   0 11 * * * cd /var/www/backblaze-neocloud-demo && node server/seed-daily.mjs >> /var/log/neocloud-daily-seed.log 2>&1
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from './db.js';

// ─── CLI flags ────────────────────────────────────────────────────────────────

const DRY_RUN   = process.argv.includes('--dry-run');
const DATE_ARG  = (() => { const i = process.argv.indexOf('--date');    return i !== -1 ? process.argv[i + 1] : null; })();
const ONLY_ACCT = (() => { const i = process.argv.indexOf('--account'); return i !== -1 ? process.argv[i + 1] : null; })();

const TODAY = DATE_ARG ?? new Date().toISOString().slice(0, 10);

// ─── Env validation ───────────────────────────────────────────────────────────

const ENC_KEY_HEX = process.env.CREDENTIAL_ENCRYPTION_KEY;
if (!ENC_KEY_HEX || ENC_KEY_HEX.length < 32) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters');
  process.exit(1);
}
const ENC_KEY = crypto.createHash('sha256').update(ENC_KEY_HEX, 'utf8').digest();

// ─── Credential store ─────────────────────────────────────────────────────────

function loadCredentials() {
  const rows = db.prepare('SELECT * FROM account_credentials ORDER BY created_at').all();
  return rows.map((r) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(r.key_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(r.key_tag, 'base64'));
    const applicationKey = Buffer.concat([
      decipher.update(Buffer.from(r.encrypted_application_key, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return {
      accountId:        r.account_id,
      email:            r.email,
      groupId:          r.group_id,
      region:           r.region,
      applicationKeyId: r.application_key_id,
      applicationKey,
    };
  });
}

// ─── B2 helpers ───────────────────────────────────────────────────────────────

async function b2Authorize(keyId, appKey) {
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` },
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

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

async function uploadSmall(uploadUrl, authToken, fileName, buf, contentType) {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:       authToken,
      'X-Bz-File-Name':    encodePath(fileName),
      'Content-Type':      contentType,
      'Content-Length':    String(buf.length),
      'X-Bz-Content-Sha1': sha1(buf),
      'X-Bz-Info-source':  'neocloud-daily-sim',
    },
    body: buf,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`upload(${fileName}): ${data.message ?? res.status}`);
  return data;
}

async function uploadMedium(apiUrl, authToken, bucketId, fileName, contentType, totalBytes) {
  const PART = 20 * 1024 * 1024;
  const started = await b2Post(apiUrl, authToken, 'b2_start_large_file', {
    bucketId, fileName, contentType,
    fileInfo: { 'src_last_modified_millis': String(Date.now()), source: 'neocloud-daily-sim' },
  });

  const parts = [];
  let offset = 0, partNum = 1;
  while (offset < totalBytes) {
    parts.push({ partNum, size: Math.min(PART, totalBytes - offset) });
    offset += parts[parts.length - 1].size;
    partNum++;
  }

  const sha1s = new Array(parts.length);
  let done = 0;

  for (let i = 0; i < parts.length; i += 3) {
    await Promise.all(parts.slice(i, i + 3).map(async ({ partNum, size }) => {
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
      if (!pres.ok) throw new Error(`part ${partNum}: ${pdata.message ?? pres.status}`);
      sha1s[partNum - 1] = sha1(buf);
      done += size;
      process.stdout.write(`\r         ↑ ${fileName}  ${fmtBytes(done)}/${fmtBytes(totalBytes)}  `);
    }));
  }
  process.stdout.write('\n');
  return b2Post(apiUrl, authToken, 'b2_finish_large_file', { fileId: started.fileId, partSha1Array: sha1s });
}

// Download a byte range of an existing file to generate Class B + egress.
// Returns actual bytes downloaded (0 if file not found / empty bucket).
async function downloadRange(downloadUrl, authToken, bucketName, fileName, rangeBytes) {
  const url = `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodePath(fileName)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authToken,
      Range: `bytes=0-${rangeBytes - 1}`,
    },
  });
  if (res.status === 404 || res.status === 416) return 0; // file gone / range too big — skip silently
  if (!res.ok && res.status !== 206) throw new Error(`download(${fileName}): ${res.status}`);
  const buf = await res.arrayBuffer();
  return buf.byteLength;
}

// List up to `maxCount` file names in a bucket (generates Class C transactions).
async function listFiles(apiUrl, authToken, accountId, bucketId, maxCount = 50) {
  try {
    const data = await b2Post(apiUrl, authToken, 'b2_list_file_names', {
      bucketId, maxFileCount: maxCount,
    });
    return data.files ?? [];
  } catch {
    return [];
  }
}

// Delete a file version (used by declining accounts).
async function deleteFile(apiUrl, authToken, fileName, fileId) {
  return b2Post(apiUrl, authToken, 'b2_delete_file_version', { fileName, fileId });
}

// ─── Deterministic profile & variance ────────────────────────────────────────

// Stable per-account profile — same account always behaves the same way.
// Distribution: dormant 15% | declining 15% | active 50% | high 20%
function assignProfile(accountId) {
  const h = crypto.createHash('sha256').update(String(accountId)).digest().readUInt8(0);
  if (h < 38)  return 'dormant';    // 0–37   ≈ 15%
  if (h < 77)  return 'declining';  // 38–76  ≈ 15%
  if (h < 204) return 'active';     // 77–203 ≈ 50%
  return 'high';                     // 204–255 ≈ 20%
}

// Per-day variance — different amounts each day, but reproducible.
function dailyVariance(accountId, dateStr) {
  const h = crypto.createHash('sha256').update(`${accountId}:${dateStr}`).digest();
  return {
    ingestFactor: 0.55 + (h.readUInt8(0) / 255) * 0.90,  // 0.55 → 1.45
    egressFactor: 0.40 + (h.readUInt8(1) / 255) * 1.20,  // 0.40 → 1.60
    skip:         h.readUInt8(2) < 18,                     // ≈ 7%: even active accounts miss a day
    spike:        h.readUInt8(3) > 235,                    // ≈ 8%: burst day (2× normal)
    deleteCount:  1 + (h.readUInt8(4) % 3),               // 1–3 files deleted (declining only)
  };
}

// ─── Daily file generators ────────────────────────────────────────────────────
// Returns { files: [{path, buf, type}], mediumFile?: {path, bytes, type} }
// Files use datestamped paths so re-running the same date is a no-op in effect.

const MB = 1024 * 1024;

function rand(h, offset, min, max) {
  // deterministic int in [min, max] using one byte of the hash
  return min + Math.round((h.readUInt8(offset % 32) / 255) * (max - min));
}

function generateDailyFiles(bucketName, accountType, profile, dateStr, accountId) {
  const h = crypto.createHash('sha256').update(`${accountId}:${bucketName}:${dateStr}:files`).digest();
  const d = dateStr;

  if (profile === 'dormant' || profile === 'declining') return { files: [] };

  const fileCount = profile === 'high'
    ? rand(h, 0, 8, 18)
    : rand(h, 0, 3, 7);

  // Medium file only on high-activity accounts, ~25% of days
  const mediumFile = (profile === 'high' && h.readUInt8(10) > 191)
    ? { bytes: rand(h, 11, 80, 280) * MB, type: 'application/octet-stream' }
    : null;

  const files = [];

  // ── AI buckets ──────────────────────────────────────────────────────────────
  if (accountType === 'ai' && bucketName.includes('checkpoints')) {
    const runId  = `run-${1000 + (h.readUInt8(1) % 20)}`;
    const epoch  = 20 + (h.readUInt8(2) % 80);
    const loss   = (0.05 + (h.readUInt8(3) / 255) * 0.25).toFixed(4);
    const acc    = (0.92 + (h.readUInt8(4) / 255) * 0.07).toFixed(4);
    files.push({
      path: `checkpoints/${runId}/epoch-${String(epoch).padStart(3,'0')}/metrics-${d}.json`,
      buf:  Buffer.from(JSON.stringify({ epoch, loss, acc, lr: 5e-5, step: epoch * 1000, ts: d }, null, 2), 'utf8'),
      type: 'application/json',
    });
    if (fileCount > 2) files.push({
      path: `eval/${runId}/daily-eval-${d}.json`,
      buf:  Buffer.from(JSON.stringify({ date: d, bleu: (0.78 + (h.readUInt8(5)/255)*0.1).toFixed(3), perplexity: (3.8 + (h.readUInt8(6)/255)*1.5).toFixed(2) }, null, 2), 'utf8'),
      type: 'application/json',
    });
    for (let i = 2; i < fileCount; i++) files.push({
      path: `checkpoints/${runId}/epoch-${String(epoch + i).padStart(3,'0')}/grad-${d}-${i}.bin`,
      buf:  crypto.randomBytes(rand(h, i + 7, 2, 12) * MB),
      type: 'application/octet-stream',
    });
    if (mediumFile) mediumFile.path = `checkpoints/${runId}/epoch-${String(epoch).padStart(3,'0')}/model-delta-${d}.safetensors`;
  }

  else if (accountType === 'ai' && bucketName.includes('datasets')) {
    const shardId = 100 + (h.readUInt8(1) % 50);
    files.push({
      path: `datasets/raw/shard-${shardId}-${d}.parquet`,
      buf:  crypto.randomBytes(rand(h, 2, 80, 200) * MB),
      type: 'application/octet-stream',
    });
    files.push({
      path: `datasets/processed/manifest-${d}.json`,
      buf:  Buffer.from(JSON.stringify({ date: d, newShards: fileCount - 1, totalRows: 8_200_000 + shardId * 10_000 }, null, 2), 'utf8'),
      type: 'application/json',
    });
    for (let i = 2; i < fileCount; i++) files.push({
      path: `datasets/raw/shard-${shardId + i}-${d}.parquet`,
      buf:  crypto.randomBytes(rand(h, i + 3, 60, 180) * MB),
      type: 'application/octet-stream',
    });
    if (mediumFile) mediumFile.path = `datasets/processed/embeddings-delta-${d}.bin`;
  }

  else if (accountType === 'ai') {
    // Embeddings or other AI bucket
    for (let i = 0; i < fileCount; i++) files.push({
      path: `daily/${d}/batch-${String(i).padStart(3,'0')}.bin`,
      buf:  crypto.randomBytes(rand(h, i + 1, 5, 30) * MB),
      type: 'application/octet-stream',
    });
    if (mediumFile) mediumFile.path = `daily/${d}/index-update.bin`;
  }

  // ── SaaS buckets ────────────────────────────────────────────────────────────
  else if (accountType === 'saas' && bucketName.includes('uploads')) {
    const imgCount = rand(h, 1, 5, 20);
    for (let i = 0; i < imgCount; i++) files.push({
      path: `uploads/images/${d}/img-${String(i + 1).padStart(4,'0')}.jpg`,
      buf:  crypto.randomBytes(rand(h, i + 2, 300, 1200) * 1024),
      type: 'image/jpeg',
    });
    for (let i = imgCount; i < fileCount; i++) files.push({
      path: `logs/${d}/access-${String(i - imgCount).padStart(2,'0')}.log`,
      buf:  Buffer.from(
        Array.from({ length: rand(h, i + 10, 50, 300) }, (_, j) =>
          `[${d}T${String(j % 24).padStart(2,'0')}:00:00Z] GET /api/v1/resource/${j} 200 ${15 + j % 80}ms`
        ).join('\n') + '\n',
        'utf8'
      ),
      type: 'text/plain',
    });
    if (mediumFile) mediumFile.path = `uploads/video/${d}/recording-${h.readUInt8(20)}.mp4`;
  }

  else if (accountType === 'saas' && bucketName.includes('audit')) {
    for (let i = 0; i < fileCount; i++) files.push({
      path: `audit/${d}/events-${String(i).padStart(2,'0')}.log`,
      buf:  Buffer.from(
        Array.from({ length: rand(h, i + 1, 100, 500) }, (_, j) =>
          `[${d}T${String(j % 24).padStart(2,'0')}:${String(j % 60).padStart(2,'0')}:00Z] user:u${1000 + j % 500} action:${['login','view','export','update','delete'][j % 5]} resource:r${j % 200} result:${j % 20 === 0 ? 'denied' : 'success'}`
        ).join('\n') + '\n',
        'utf8'
      ),
      type: 'text/plain',
    });
  }

  else if (accountType === 'saas') {
    for (let i = 0; i < fileCount; i++) files.push({
      path: `daily/${d}/payload-${String(i).padStart(3,'0')}.bin`,
      buf:  crypto.randomBytes(rand(h, i + 1, 1, 8) * MB),
      type: 'application/octet-stream',
    });
  }

  // ── Internal buckets ────────────────────────────────────────────────────────
  else if (accountType === 'internal' && bucketName.includes('sysbackups')) {
    const size = rand(h, 1, 200, 600) * MB;
    files.push({
      path: `backups/incremental/${d}/delta.tar.gz`,
      buf:  crypto.randomBytes(size),
      type: 'application/gzip',
    });
    files.push({
      path: `manifests/restore-point-${d}.json`,
      buf:  Buffer.from(JSON.stringify({ date: d, type: 'incremental', sizeBytes: size, checksum: crypto.randomBytes(20).toString('hex') }, null, 2), 'utf8'),
      type: 'application/json',
    });
    for (let i = 2; i < fileCount; i++) files.push({
      path: `backups/incremental/${d}/part-${String(i).padStart(2,'0')}.tar.gz`,
      buf:  crypto.randomBytes(rand(h, i + 2, 50, 300) * MB),
      type: 'application/gzip',
    });
    if (mediumFile) mediumFile.path = `backups/daily/${d}/system-snapshot.tar.gz`;
  }

  else if (accountType === 'internal') {
    const ver = `v1.${12 + (h.readUInt8(1) % 8)}.${h.readUInt8(2) % 10}`;
    files.push({
      path: `releases/${ver}/manifest.json`,
      buf:  Buffer.from(JSON.stringify({ version: ver, builtAt: `${d}T12:00:00Z`, sha256: crypto.randomBytes(32).toString('hex') }, null, 2), 'utf8'),
      type: 'application/json',
    });
    for (let i = 1; i < fileCount; i++) files.push({
      path: `daily/${d}/artifact-${String(i).padStart(2,'0')}.tar.gz`,
      buf:  crypto.randomBytes(rand(h, i + 3, 20, 150) * MB),
      type: 'application/gzip',
    });
    if (mediumFile) mediumFile.path = `releases/${ver}/app-bundle.tar.gz`;
  }

  // ── Default ─────────────────────────────────────────────────────────────────
  else {
    for (let i = 0; i < fileCount; i++) files.push({
      path: `daily/${d}/file-${String(i).padStart(3,'0')}.bin`,
      buf:  crypto.randomBytes(rand(h, i + 1, 1, 10) * MB),
      type: 'application/octet-stream',
    });
  }

  return { files, mediumFile };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtBytes(b) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}

function inferType(cred) {
  if (cred.groupId === '165914') return 'internal';
  if (cred.groupId === '165915') return 'ai';
  return 'saas';
}

// ─── Per-account simulation ───────────────────────────────────────────────────

async function simulateAccount(cred, dateStr) {
  const tag     = `[${cred.email}]`;
  const atype   = inferType(cred);
  const profile = assignProfile(cred.accountId);
  const v       = dailyVariance(cred.accountId, dateStr);

  console.log(`\n${tag}  type:${atype}  profile:${profile}  date:${dateStr}`);

  // Dormant accounts: log and skip entirely
  if (profile === 'dormant') {
    console.log('  ↷ dormant — skipping');
    return { uploadBytes: 0, egressBytes: 0, deletes: 0 };
  }

  // All other profiles occasionally skip a day (variance)
  if (v.skip && profile !== 'declining') {
    console.log('  ↷ skip day (variance)');
    return { uploadBytes: 0, egressBytes: 0, deletes: 0 };
  }

  // Authorize
  let sub;
  try {
    sub = await b2Authorize(cred.applicationKeyId, cred.applicationKey);
    console.log(`  ✓ authorized  accountId:${sub.accountId}`);
  } catch (e) {
    console.error(`  ✗ auth failed: ${e.message}`);
    return { uploadBytes: 0, egressBytes: 0, deletes: 0 };
  }

  // List buckets
  let buckets = [];
  try {
    const data = await b2Post(sub.apiUrl, sub.authToken, 'b2_list_buckets', { accountId: sub.accountId });
    buckets = data.buckets ?? [];
    console.log(`  ✓ ${buckets.length} bucket(s): ${buckets.map(b => b.bucketName).join(', ')}`);
  } catch (e) {
    console.error(`  ✗ list_buckets: ${e.message}`);
    return { uploadBytes: 0, egressBytes: 0, deletes: 0 };
  }

  let totalUpload = 0;
  let totalEgress = 0;
  let totalDeletes = 0;

  for (const bucket of buckets) {
    const { bucketId, bucketName } = bucket;
    console.log(`\n  ── ${bucketName}`);

    // ── List existing files (generates Class C) ──────────────────────────────
    const existingFiles = await listFiles(sub.apiUrl, sub.authToken, sub.accountId, bucketId);
    console.log(`     listed ${existingFiles.length} file(s)`);

    // ── Declining: delete a few files, do light egress, no uploads ───────────
    if (profile === 'declining') {
      // Small download pass first
      const candidates = existingFiles.filter(f => f.contentLength > 0).slice(0, 3);
      for (const f of candidates) {
        const rangeBytes = Math.min(f.contentLength, 2 * MB);
        if (DRY_RUN) { console.log(`     [dry] download range ${fmtBytes(rangeBytes)} from ${f.fileName}`); continue; }
        try {
          const got = await downloadRange(sub.downloadUrl, sub.authToken, bucketName, f.fileName, rangeBytes);
          totalEgress += got;
          if (got > 0) console.log(`     ↓ ${fmtBytes(got)} from ${f.fileName}`);
        } catch (e) { console.error(`     ✗ download: ${e.message}`); }
      }
      // Delete some older files
      const deleteTargets = existingFiles
        .filter(f => !f.fileName.startsWith('daily/') || f.fileName < `daily/${dateStr}`)
        .slice(0, v.deleteCount);
      for (const f of deleteTargets) {
        if (DRY_RUN) { console.log(`     [dry] delete ${f.fileName}`); continue; }
        try {
          await deleteFile(sub.apiUrl, sub.authToken, f.fileName, f.fileId);
          totalDeletes++;
          console.log(`     ✗ deleted ${f.fileName}`);
        } catch (e) { console.error(`     ✗ delete failed: ${e.message}`); }
      }
      continue; // no uploads for declining
    }

    // ── Active & High: upload daily files ────────────────────────────────────
    const { files, mediumFile } = generateDailyFiles(bucketName, atype, profile, dateStr, cred.accountId);

    // Scale file counts and sizes by daily variance factor (spike = 2× normal)
    const scaledFiles = v.spike
      ? [...files, ...files.slice(0, Math.ceil(files.length / 2))]
      : files;

    if (scaledFiles.length > 0) {
      let uploadUrl;
      try {
        uploadUrl = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId });
      } catch (e) { console.error(`     ✗ get_upload_url: ${e.message}`); continue; }

      for (const f of scaledFiles) {
        const buf = Buffer.isBuffer(f.buf)
          ? f.buf
          : Buffer.from(f.buf ?? crypto.randomBytes(MB));

        if (DRY_RUN) { console.log(`     [dry] upload ${f.path}  (${fmtBytes(buf.length)})`); totalUpload += buf.length; continue; }

        try {
          await uploadSmall(uploadUrl.uploadUrl, uploadUrl.authorizationToken, f.path, buf, f.type);
          console.log(`     ↑ ${f.path}  (${fmtBytes(buf.length)})`);
          totalUpload += buf.length;
        } catch (e) {
          // Refresh upload URL on auth expiry
          if (/expired|bad_auth/i.test(e.message)) {
            try {
              uploadUrl = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId });
              await uploadSmall(uploadUrl.uploadUrl, uploadUrl.authorizationToken, f.path, buf, f.type);
              totalUpload += buf.length;
            } catch (e2) { console.error(`     ✗ ${f.path}: ${e2.message}`); }
          } else { console.error(`     ✗ ${f.path}: ${e.message}`); }
        }
      }
    }

    // Medium file upload (high-activity accounts only)
    if (mediumFile && !DRY_RUN) {
      try {
        const spikeMult = v.spike ? 1.5 : v.ingestFactor;
        const bytes     = Math.round(mediumFile.bytes * spikeMult);
        console.log(`     ↑ ${mediumFile.path}  (${fmtBytes(bytes)}) [multipart]`);
        await uploadMedium(sub.apiUrl, sub.authToken, bucketId, mediumFile.path, mediumFile.type, bytes);
        totalUpload += bytes;
      } catch (e) { console.error(`     ✗ medium upload: ${e.message}`); }
    } else if (mediumFile && DRY_RUN) {
      console.log(`     [dry] upload ${mediumFile.path}  (${fmtBytes(mediumFile.bytes)}) [multipart]`);
    }

    // ── Egress: download byte ranges from existing files (Class B) ────────────
    const downloadTargets = existingFiles.filter(f => f.contentLength > MB).slice(0, profile === 'high' ? 10 : 4);
    const egressPerFile   = profile === 'high'
      ? Math.round(rand(crypto.createHash('sha256').update(`${cred.accountId}:${bucketName}:egress:${dateStr}`).digest(), 0, 20, 60) * MB * v.egressFactor)
      : Math.round(rand(crypto.createHash('sha256').update(`${cred.accountId}:${bucketName}:egress:${dateStr}`).digest(), 0, 5, 20) * MB * v.egressFactor);

    for (const f of downloadTargets) {
      const rangeBytes = Math.min(f.contentLength, egressPerFile);
      if (DRY_RUN) { console.log(`     [dry] download range ${fmtBytes(rangeBytes)} from ${f.fileName}`); totalEgress += rangeBytes; continue; }
      try {
        const got = await downloadRange(sub.downloadUrl, sub.authToken, bucketName, f.fileName, rangeBytes);
        totalEgress += got;
        if (got > 0) console.log(`     ↓ ${fmtBytes(got)} from ${f.fileName}`);
      } catch (e) { console.error(`     ✗ download: ${e.message}`); }
    }
  }

  console.log(`  ── done  upload:${fmtBytes(totalUpload)}  egress:${fmtBytes(totalEgress)}  deletes:${totalDeletes}`);
  return { uploadBytes: totalUpload, egressBytes: totalEgress, deletes: totalDeletes };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const hr = '═'.repeat(68);
  console.log(`\n${hr}`);
  console.log(`  NeoCloud B2 — Daily Activity Simulator${DRY_RUN ? '  [DRY RUN]' : ''}`);
  console.log(`  Date : ${TODAY}`);
  console.log(`  Run  : ${new Date().toISOString()}`);
  console.log(hr);

  let creds = loadCredentials();
  if (!creds.length) {
    console.error('ERROR: No credentials found in DB. Run seed-trial.mjs first.');
    process.exit(1);
  }
  if (ONLY_ACCT) {
    creds = creds.filter(c => c.email === ONLY_ACCT);
    if (!creds.length) { console.error(`ERROR: No credential found for ${ONLY_ACCT}`); process.exit(1); }
  }

  // Log profile summary
  const profileCount = {};
  for (const c of creds) {
    const p = assignProfile(c.accountId);
    profileCount[p] = (profileCount[p] ?? 0) + 1;
  }
  console.log(`\nAccounts: ${creds.length} total`);
  for (const [p, n] of Object.entries(profileCount)) {
    console.log(`  ${p.padEnd(10)} ${n}`);
  }

  let grandUpload = 0, grandEgress = 0, grandDeletes = 0, errors = 0;

  for (const cred of creds) {
    try {
      const result = await simulateAccount(cred, TODAY);
      grandUpload  += result.uploadBytes;
      grandEgress  += result.egressBytes;
      grandDeletes += result.deletes;
    } catch (e) {
      console.error(`\nFATAL [${cred.email}]: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n${hr}`);
  console.log(`  ${DRY_RUN ? 'Dry-run' : 'Simulation'} complete.`);
  console.log(`  Uploaded : ${fmtBytes(grandUpload)}`);
  console.log(`  Egress   : ${fmtBytes(grandEgress)}`);
  console.log(`  Deletes  : ${grandDeletes} file(s)`);
  if (errors) console.log(`  Errors   : ${errors} account(s) failed`);
  console.log(hr + '\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
