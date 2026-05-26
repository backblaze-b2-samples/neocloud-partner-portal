// =============================================================================
// seed-master-buckets.mjs — Creates and seeds 6 master-account buckets.
//
// Bucket layout (all on the master B2 account):
//   nc-master-archive-west-1  private, SSE-B2, lifecycle (delete 90d after hiding)
//   nc-master-archive-west-2  private, SSE-B2, lifecycle (delete 90d after hiding)
//   nc-master-media-west-3    private, SSE-B2, lifecycle (delete 90d after hiding)
//   nc-master-logs-west-4     private, SSE-B2, lifecycle (delete 90d after hiding)
//   nc-master-assets-east     allPublic  (no lifecycle — CDN-facing)
//   nc-master-data-eu         private, SSE-B2  (no lifecycle — long-term cold store)
//
// Each bucket is seeded with ~150 GB of synthetic data.
//
// Usage (run from project root on EC2):
//   node server/seed-master-buckets.mjs            # live run
//   node server/seed-master-buckets.mjs --dry-run  # preview, no API calls
//
// Required env vars (loaded from .env automatically):
//   B2_MASTER_KEY_ID   Master application key ID
//   B2_MASTER_APP_KEY  Master application key
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';

const DRY_RUN   = process.argv.includes('--dry-run');
const SEEDED_AT = new Date().toISOString();

// ─── Env validation ───────────────────────────────────────────────────────────

const MASTER_KEY_ID  = process.env.B2_MASTER_KEY_ID;
const MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY;

if (!MASTER_KEY_ID || !MASTER_APP_KEY) {
  console.error('ERROR: B2_MASTER_KEY_ID and B2_MASTER_APP_KEY must be set in .env');
  process.exit(1);
}

// ─── Bucket definitions ───────────────────────────────────────────────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;

// B2 requires BOTH lifecycle fields present; set unused one to null.
const STANDARD_LIFECYCLE = [
  { fileNamePrefix: '', daysFromUploadingUntilHiding: null, daysFromHidingUntilDeleting: 90 },
];

const BUCKET_DEFS = [
  // ── 4 × US West (private, SSE, lifecycle) ──────────────────────────────────
  {
    name:       'nc-master-archive-west-1',
    bucketType: 'allPrivate',
    sse:        true,
    lifecycle:  STANDARD_LIFECYCLE,
    label:      'US West — Primary Archive',
  },
  {
    name:       'nc-master-archive-west-2',
    bucketType: 'allPrivate',
    sse:        true,
    lifecycle:  STANDARD_LIFECYCLE,
    label:      'US West — DR Archive',
  },
  {
    name:       'nc-master-media-west-3',
    bucketType: 'allPrivate',
    sse:        true,
    lifecycle:  STANDARD_LIFECYCLE,
    label:      'US West — Media / Video',
  },
  {
    name:       'nc-master-logs-west-4',
    bucketType: 'allPrivate',
    sse:        true,
    lifecycle:  STANDARD_LIFECYCLE,
    label:      'US West — Log Archives',
  },
  // ── 1 × US East (public, no lifecycle) ─────────────────────────────────────
  {
    name:       'nc-master-assets-east',
    bucketType: 'allPublic',
    sse:        false,
    lifecycle:  null,
    label:      'US East — Public CDN Assets',
  },
  // ── 1 × EU (private, SSE, no lifecycle — cold store) ───────────────────────
  {
    name:       'nc-master-data-eu',
    bucketType: 'allPrivate',
    sse:        true,
    lifecycle:  null,
    label:      'EU — Cold Data Store',
  },
];

// ─── File plans (~150 GB per bucket) ─────────────────────────────────────────

function filePlan(bucketName) {
  if (bucketName === 'nc-master-archive-west-1') return {
    small: [
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `manifests/restore-point-2026-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}.json`,
        content: JSON.stringify({
          type: 'full', sourceHost: `prod-app-0${(i % 4) + 1}`,
          sizeBytes: (45 + i) * GB, checksum: crypto.randomBytes(20).toString('hex'),
          created: `2026-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T02:00:00Z`,
        }, null, 2),
        type: 'application/json',
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `backups/incremental/2026-04-${String(i + 1).padStart(2, '0')}/delta.manifest`,
        content: `delta_base: 2026-03-${String(i + 1).padStart(2, '0')}\ndelta_size_bytes: ${(250 + i * 40) * MB}\n`,
        type: 'text/plain',
      })),
    ],
    large: [
      { path: 'backups/daily/2026-04-01/system-full.tar.gz',         bytes: 30 * GB, type: 'application/gzip' },
      { path: 'backups/daily/2026-04-15/system-full.tar.gz',         bytes: 30 * GB, type: 'application/gzip' },
      { path: 'backups/daily/2026-05-01/system-full.tar.gz',         bytes: 30 * GB, type: 'application/gzip' },
      { path: 'backups/daily/2026-05-07/system-full.tar.gz',         bytes: 30 * GB, type: 'application/gzip' },
      { path: 'backups/database/2026-05-07/postgres-prod.dump',      bytes: 20 * GB, type: 'application/octet-stream' },
      { path: 'backups/database/2026-05-07/postgres-analytics.dump', bytes: 10 * GB, type: 'application/octet-stream' },
    ],
  };

  if (bucketName === 'nc-master-archive-west-2') return {
    small: [
      ...Array.from({ length: 15 }, (_, i) => ({
        path: `dr/manifests/site-b-restore-${String(i + 1).padStart(3, '0')}.json`,
        content: JSON.stringify({
          drTarget: 'us-east-1', sourceRegion: 'us-west', rpoMinutes: 60,
          lastVerified: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T04:00:00Z`,
          sizeBytes: (40 + i) * GB, checksum: crypto.randomBytes(20).toString('hex'),
        }, null, 2),
        type: 'application/json',
      })),
    ],
    large: [
      { path: 'dr/snapshots/2026-03-01/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'dr/snapshots/2026-03-15/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'dr/snapshots/2026-04-01/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'dr/snapshots/2026-04-15/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'dr/snapshots/2026-05-01/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'dr/snapshots/2026-05-07/vol-001.snap', bytes: 25 * GB, type: 'application/octet-stream' },
    ],
  };

  if (bucketName === 'nc-master-media-west-3') return {
    small: [
      ...Array.from({ length: 30 }, (_, i) => ({
        path: `thumbnails/2026/05/${String((i % 7) + 1).padStart(2, '0')}/thumb-${1000 + i}.jpg`,
        size: 150 * 1024,
        type: 'image/jpeg',
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `metadata/videos/video-${1000 + i}.json`,
        content: JSON.stringify({
          id: `vid-${1000 + i}`, title: `NeoCloud Demo Video ${i + 1}`,
          duration: 1800 + i * 60, resolution: '1920x1080', codec: 'h264',
          sizeBytes: (3 + (i % 4)) * GB,
          uploadedAt: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
        }, null, 2),
        type: 'application/json',
      })),
    ],
    large: [
      { path: 'originals/2026/04/webinar-q1-review.mp4',       bytes: 30 * GB, type: 'video/mp4' },
      { path: 'originals/2026/04/product-launch-keynote.mp4',  bytes: 40 * GB, type: 'video/mp4' },
      { path: 'originals/2026/05/engineering-all-hands.mp4',   bytes: 35 * GB, type: 'video/mp4' },
      { path: 'originals/2026/05/customer-summit-day1.mp4',    bytes: 45 * GB, type: 'video/mp4' },
    ],
  };

  if (bucketName === 'nc-master-logs-west-4') return {
    small: [
      ...Array.from({ length: 60 }, (_, i) => ({
        path: `access-logs/2026/${String(Math.floor(i / 30) + 4).padStart(2, '0')}/${String((i % 30) + 1).padStart(2, '0')}/nginx-access.log.gz`,
        size: 80 * MB,
        type: 'application/gzip',
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        path: `app-logs/2026/${String(Math.floor(i / 30) + 4).padStart(2, '0')}/${String((i % 30) + 1).padStart(2, '0')}/api-server.log.gz`,
        size: 40 * MB,
        type: 'application/gzip',
      })),
    ],
    large: [
      { path: 'archives/2026-q1-access-logs.tar.gz',    bytes: 30 * GB, type: 'application/gzip' },
      { path: 'archives/2026-q1-app-logs.tar.gz',       bytes: 20 * GB, type: 'application/gzip' },
      { path: 'archives/2026-04-access-logs.tar.gz',    bytes: 20 * GB, type: 'application/gzip' },
      { path: 'archives/2026-04-app-logs.tar.gz',       bytes: 15 * GB, type: 'application/gzip' },
      { path: 'archives/security/2026-q1-audit.tar.gz', bytes: 15 * GB, type: 'application/gzip' },
    ],
  };

  if (bucketName === 'nc-master-assets-east') return {
    small: [
      { path: 'assets/app.js',          size: 3 * MB,     type: 'application/javascript' },
      { path: 'assets/app.css',         size: 500 * 1024, type: 'text/css' },
      { path: 'assets/vendor.js',       size: 5 * MB,     type: 'application/javascript' },
      { path: 'assets/logo.png',        size: 80 * 1024,  type: 'image/png' },
      { path: 'assets/logo-dark.png',   size: 75 * 1024,  type: 'image/png' },
      ...Array.from({ length: 50 }, (_, i) => ({
        path: `assets/icons/icon-${String(i + 1).padStart(3, '0')}.svg`,
        content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="${5 + (i % 5)}"/></svg>`,
        type: 'image/svg+xml',
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        path: `images/product/product-${String(1000 + i).padStart(5, '0')}.webp`,
        size: 200 * 1024,
        type: 'image/webp',
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        path: `images/avatars/avatar-${String(i + 1).padStart(4, '0')}.png`,
        size: 30 * 1024,
        type: 'image/png',
      })),
    ],
    large: [
      { path: 'video/homepage-hero-loop.mp4',              bytes: 8  * GB, type: 'video/mp4' },
      { path: 'video/product-tour-2026.mp4',               bytes: 12 * GB, type: 'video/mp4' },
      { path: 'video/onboarding-walkthrough.mp4',          bytes: 10 * GB, type: 'video/mp4' },
      { path: 'datasets/public-sample-embeddings.bin',     bytes: 20 * GB, type: 'application/octet-stream' },
      { path: 'datasets/public-benchmark-results.tar.gz',  bytes: 20 * GB, type: 'application/gzip' },
      { path: 'releases/sdk/neocloud-sdk-v2.tar.gz',       bytes: 15 * GB, type: 'application/gzip' },
      { path: 'releases/cli/neocloud-cli-v2.tar.gz',       bytes: 10 * GB, type: 'application/gzip' },
      { path: 'fonts/neocloud-icons-v3.woff2',             bytes: 5  * GB, type: 'font/woff2' },
    ],
  };

  if (bucketName === 'nc-master-data-eu') return {
    small: [
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `exports/gdpr/user-data-export-${String(i + 1).padStart(4, '0')}.json`,
        content: JSON.stringify({
          exportId: crypto.randomBytes(8).toString('hex'),
          region: 'eu-central', requestedAt: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
          status: 'complete', recordCount: 15000 + i * 1000,
        }, null, 2),
        type: 'application/json',
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `compliance/gdpr-report-2026-${String(i + 1).padStart(2, '0')}.pdf`,
        size: 500 * 1024,
        type: 'application/pdf',
      })),
      { path: 'compliance/data-processing-agreement-v3.pdf', size: 1 * MB, type: 'application/pdf' },
      { path: 'compliance/schrems-ii-assessment.pdf',        size: 2 * MB, type: 'application/pdf' },
    ],
    large: [
      { path: 'analytics/2026-q1-events.parquet',          bytes: 25 * GB, type: 'application/octet-stream' },
      { path: 'analytics/2026-q1-sessions.parquet',        bytes: 20 * GB, type: 'application/octet-stream' },
      { path: 'analytics/2026-04-events.parquet',          bytes: 15 * GB, type: 'application/octet-stream' },
      { path: 'ml-features/user-embeddings-eu-v2.bin',     bytes: 30 * GB, type: 'application/octet-stream' },
      { path: 'ml-features/content-embeddings-eu-v1.bin',  bytes: 30 * GB, type: 'application/octet-stream' },
      { path: 'cold-archive/2025-full-eu-dataset.tar.gz',  bytes: 30 * GB, type: 'application/gzip' },
    ],
  };

  return { small: [], large: [] };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function sha1hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function b2Authorize(keyId, appKey) {
  const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
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

async function uploadSmall(uploadUrl, authToken, fileName, content, contentType) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:           authToken,
      'X-Bz-File-Name':        encodePath(fileName),
      'Content-Type':          contentType,
      'Content-Length':        String(buf.length),
      'X-Bz-Content-Sha1':     sha1hex(buf),
      'X-Bz-Info-environment': 'demo',
      'X-Bz-Info-seeded-at':   encodeURIComponent(SEEDED_AT),
    },
    body: buf,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`upload (${fileName}): ${data.message ?? res.status}`);
  return data;
}

async function uploadLarge(apiUrl, authToken, bucketId, fileName, contentType, totalBytes) {
  const PART             = 20 * 1024 * 1024;
  const PART_CONCURRENCY = 4;

  const started = await b2Post(apiUrl, authToken, 'b2_start_large_file', {
    bucketId, fileName, contentType,
    fileInfo: { 'src_last_modified_millis': String(Date.now()) },
  });

  const parts = [];
  let offset = 0, partNum = 1;
  while (offset < totalBytes) {
    const size = Math.min(PART, totalBytes - offset);
    parts.push({ partNum, size });
    offset += size;
    partNum++;
  }

  const sha1s   = new Array(parts.length);
  let bytesDone = 0;

  async function uploadPart({ partNum, size }) {
    const buf     = crypto.randomBytes(size);
    const partUrl = await b2Post(apiUrl, authToken, 'b2_get_upload_part_url', { fileId: started.fileId });
    const pres    = await fetch(partUrl.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization:       partUrl.authorizationToken,
        'X-Bz-Part-Number':  String(partNum),
        'Content-Length':    String(size),
        'X-Bz-Content-Sha1': sha1hex(buf),
      },
      body: buf,
    });
    const pdata = await pres.json();
    if (!pres.ok) throw new Error(`upload_part ${partNum}: ${pdata.message ?? pres.status}`);
    sha1s[partNum - 1] = sha1hex(buf);
    bytesDone += size;
    const pct = Math.round((bytesDone / totalBytes) * 100);
    process.stdout.write(`\r      ↑ ${fileName}  ${fmt(bytesDone)} / ${fmt(totalBytes)}  ${pct}%  `);
  }

  for (let i = 0; i < parts.length; i += PART_CONCURRENCY) {
    await Promise.all(parts.slice(i, i + PART_CONCURRENCY).map(uploadPart));
  }

  process.stdout.write('\n');
  return b2Post(apiUrl, authToken, 'b2_finish_large_file', { fileId: started.fileId, partSha1Array: sha1s });
}

async function uploadBatch(apiUrl, authToken, bucketId, files) {
  let urlData = await b2Post(apiUrl, authToken, 'b2_get_upload_url', { bucketId });
  for (const f of files) {
    if (DRY_RUN) {
      const size = f.size ?? (f.content ? (Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(f.content)) : 0);
      console.log(`    [dry] ${f.path}  (${fmt(size)})`);
      continue;
    }
    try {
      const content = f.content ?? crypto.randomBytes(f.size);
      await uploadSmall(urlData.uploadUrl, urlData.authorizationToken, f.path, content, f.type);
      const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
      console.log(`      ↑ ${f.path}  (${fmt(size)})`);
    } catch (e) {
      if (/expired|bad_auth/i.test(e.message)) {
        urlData = await b2Post(apiUrl, authToken, 'b2_get_upload_url', { bucketId });
        const content = f.content ?? crypto.randomBytes(f.size);
        await uploadSmall(urlData.uploadUrl, urlData.authorizationToken, f.path, content, f.type);
        console.log(`      ↑ ${f.path}  [retry]`);
      } else {
        console.error(`    ✗ ${f.path}: ${e.message}`);
      }
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const hr = '═'.repeat(66);
  console.log(`\n${hr}`);
  console.log(`  NeoCloud B2 — Master Bucket Seed${DRY_RUN ? '  [DRY RUN — no API calls]' : ''}`);
  console.log(`  Buckets  : ${BUCKET_DEFS.length}  (4 US West · 1 US East · 1 EU)`);
  console.log(`  Target   : ~150 GB per bucket`);
  console.log(`  Time     : ${SEEDED_AT}`);
  console.log(hr);

  let auth;
  if (!DRY_RUN) {
    try {
      auth = await b2Authorize(MASTER_KEY_ID, MASTER_APP_KEY);
      console.log(`\n✓ Master authorized  accountId:${auth.accountId}`);
    } catch (err) {
      console.error(`FATAL: master auth failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log('\n(DRY RUN — skipping auth)');
  }

  let grandTotal = 0;

  for (const def of BUCKET_DEFS) {
    console.log(`\n── ${def.name}  [${def.label}]`);

    const { small, large } = filePlan(def.name);
    const smallBytes = small.reduce((s, f) => {
      const c = f.content;
      return s + (f.size ?? (c == null ? 0 : Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c)));
    }, 0);
    const largeBytes = large.reduce((s, f) => s + f.bytes, 0);
    const total = smallBytes + largeBytes;
    const lcLabel = def.lifecycle ? 'delete 90d after hiding' : 'none';
    console.log(`   ${def.bucketType} · SSE:${def.sse} · lifecycle:${lcLabel}`);
    console.log(`   Files: ${small.length} small (${fmt(smallBytes)}) + ${large.length} large (${fmt(largeBytes)}) = ${fmt(total)}`);

    if (DRY_RUN) {
      for (const f of small) {
        const size = f.size ?? (f.content ? (Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(f.content)) : 0);
        console.log(`   [dry-small] ${f.path}  ${fmt(size)}`);
      }
      for (const f of large) console.log(`   [dry-large] ${f.path}  ${fmt(f.bytes)}`);
      grandTotal += total;
      continue;
    }

    // Create bucket
    let bucketId;
    try {
      const body = {
        accountId:  auth.accountId,
        bucketName: def.name,
        bucketType: def.bucketType,
      };
      if (def.sse) {
        body.defaultServerSideEncryption = { mode: 'SSE-B2', algorithm: 'AES256' };
      }
      const bucket = await b2Post(auth.apiUrl, auth.authToken, 'b2_create_bucket', body);
      bucketId = bucket.bucketId;
      const flags = [def.bucketType, def.sse && 'SSE-B2'].filter(Boolean).join(', ');
      console.log(`  ✓ Bucket created  bucketId:${bucketId}  (${flags})`);
    } catch (err) {
      console.error(`  ✗ b2_create_bucket ${def.name}: ${err.message}`);
      continue;
    }

    // Apply lifecycle rules
    if (def.lifecycle?.length) {
      try {
        await b2Post(auth.apiUrl, auth.authToken, 'b2_update_bucket', {
          accountId:      auth.accountId,
          bucketId,
          lifecycleRules: def.lifecycle,
        });
        console.log(`  ✓ Lifecycle applied  (delete 90d after hiding)`);
      } catch (err) {
        console.error(`  ✗ Lifecycle ${def.name}: ${err.message}`);
      }
    }

    // Upload small files
    if (small.length > 0) {
      console.log(`  Uploading ${small.length} small files…`);
      await uploadBatch(auth.apiUrl, auth.authToken, bucketId, small);
    }

    // Upload large files (2 concurrent)
    if (large.length > 0) {
      console.log(`  Uploading ${large.length} large files…`);
      const LARGE_CONCURRENCY = 2;
      for (let i = 0; i < large.length; i += LARGE_CONCURRENCY) {
        await Promise.all(large.slice(i, i + LARGE_CONCURRENCY).map(async (lf) => {
          try {
            await uploadLarge(auth.apiUrl, auth.authToken, bucketId, lf.path, lf.type, lf.bytes);
            console.log(`    ✓ ${lf.path}  (${fmt(lf.bytes)})`);
          } catch (e) {
            console.error(`    ✗ ${lf.path}: ${e.message}`);
          }
        }));
      }
    }

    grandTotal += total;
    console.log(`  ── done  bucket total: ${fmt(total)}`);
  }

  console.log(`\n${hr}`);
  console.log(`  ${DRY_RUN ? 'Dry-run' : 'Seed'} complete.  Grand total: ${fmt(grandTotal)}`);
  console.log(`${hr}\n`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
