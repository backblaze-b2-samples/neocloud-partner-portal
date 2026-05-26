// =============================================================================
// archive-reports.mjs — Daily CSV report archiver.
//
// Backblaze only retains 7 days of usage CSV files in the b2-reports-* bucket.
// This script downloads any files not yet archived locally so the dashboard can
// display 30–90 days of history regardless of B2's retention window.
//
// Archives are saved to: server/data/reports/YYYY-MM-DD/<filename>.csv
//
// The /api/master-b2/reports-csv route merges these local archives with the
// live B2 bucket data so the UI sees a seamless extended history.
//
// Usage (run from project root):
//   node server/archive-reports.mjs            # archive any missing files
//   node server/archive-reports.mjs --dry-run  # preview without writing
//
// Cron (2:30 AM PST = 10:30 UTC — runs before seed-daily at 11:00 UTC):
//   30 10 * * * cd /var/www/backblaze-neocloud-demo && node server/archive-reports.mjs >> /var/log/neocloud-archive.log 2>&1
// =============================================================================

import 'dotenv/config';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN   = process.argv.includes('--dry-run');

// Local archive directory — persists across PM2 restarts / server reboots.
// Structure: server/data/reports/YYYY-MM-DD/<filename>.csv
const ARCHIVE_DIR = path.join(__dirname, 'data', 'reports');

// ─── Env ─────────────────────────────────────────────────────────────────────

const KEY_ID  = process.env.B2_MASTER_KEY_ID;
const APP_KEY = process.env.B2_MASTER_APP_KEY;

if (!KEY_ID || !APP_KEY) {
  console.error('ERROR: B2_MASTER_KEY_ID and B2_MASTER_APP_KEY must be set in .env');
  process.exit(1);
}

// ─── B2 helpers ───────────────────────────────────────────────────────────────

async function b2Authorize() {
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64') },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`b2_authorize_account: ${data.message ?? res.status}`);
  return {
    tok:         data.authorizationToken,
    apiUrl:      data.apiInfo.storageApi.apiUrl,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    accountId:   data.accountId,
  };
}

async function b2Post(apiUrl, tok, endpoint, body) {
  const res = await fetch(`${apiUrl}/b2api/v3/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${endpoint}: ${data.message ?? res.status}`);
  return data;
}

// ─── Archive helpers ──────────────────────────────────────────────────────────

// Returns a Set of already-archived filenames (e.g. '2026-04-28/Usage.csv')
function loadArchivedFilenames() {
  const archived = new Set();
  if (!fs.existsSync(ARCHIVE_DIR)) return archived;
  for (const dateDir of fs.readdirSync(ARCHIVE_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    const dir = path.join(ARCHIVE_DIR, dateDir);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.csv')) archived.add(`${dateDir}/${f}`);
    }
  }
  return archived;
}

function saveToArchive(fileName, content) {
  const parts    = fileName.split('/');
  const dateDir  = parts[0];
  const basename = parts.slice(1).join('/');
  const dir      = path.join(ARCHIVE_DIR, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), content, 'utf8');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const hr = '═'.repeat(64);
  console.log(`\n${hr}`);
  console.log(`  NeoCloud — CSV Report Archiver${DRY_RUN ? '  [DRY RUN]' : ''}`);
  console.log(`  Run: ${new Date().toISOString()}`);
  console.log(hr);

  const auth = await b2Authorize();
  console.log(`\n✓ Authorized  accountId:${auth.accountId}`);

  // Find the reports bucket
  const { buckets } = await b2Post(auth.apiUrl, auth.tok, 'b2_list_buckets', {
    accountId: auth.accountId, bucketTypes: ['all'],
  });
  const bucket = buckets.find(b => b.bucketName === `b2-reports-${auth.accountId}`)
               || buckets.find(b => b.bucketName.startsWith('b2-reports-'));
  if (!bucket) throw new Error('b2-reports-* bucket not found');
  console.log(`✓ Reports bucket: ${bucket.bucketName}`);

  // List all CSV files in the bucket
  let fileList = [];
  let nextFileName;
  do {
    const opts = { bucketId: bucket.bucketId, maxFileCount: 1000 };
    if (nextFileName) opts.startFileName = nextFileName;
    const page = await b2Post(auth.apiUrl, auth.tok, 'b2_list_file_names', opts);
    fileList = fileList.concat(page.files ?? []);
    nextFileName = page.nextFileName || null;
  } while (nextFileName);

  const csvFiles = fileList.filter(f => /^(\d{4}-\d{2}-\d{2})\/[^/]+\.csv$/i.test(f.fileName));
  console.log(`\nFound ${csvFiles.length} CSV file(s) in bucket`);

  // Compare against local archive
  const alreadyArchived = loadArchivedFilenames();
  console.log(`Already archived: ${alreadyArchived.size} file(s) in ${ARCHIVE_DIR}`);

  const toArchive = csvFiles.filter(f => !alreadyArchived.has(f.fileName));
  if (toArchive.length === 0) {
    console.log('\n✓ Nothing new to archive.');
    console.log(`\n${hr}\n`);
    return;
  }

  console.log(`\nArchiving ${toArchive.length} new file(s):`);

  let saved = 0, errors = 0;
  for (const f of toArchive) {
    if (DRY_RUN) {
      console.log(`  [dry] ${f.fileName}  (${(f.contentLength / 1024).toFixed(1)} KB)`);
      saved++;
      continue;
    }
    try {
      const url  = `${auth.downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(f.fileId)}`;
      const text = await fetch(url, { headers: { Authorization: auth.tok } }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
      saveToArchive(f.fileName, text);
      console.log(`  ✓ ${f.fileName}  (${(f.contentLength / 1024).toFixed(1)} KB)`);
      saved++;
    } catch (e) {
      console.error(`  ✗ ${f.fileName}: ${e.message}`);
      errors++;
    }
  }

  // Also prune archive entries older than 90 days so it doesn't grow forever
  if (!DRY_RUN) {
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    let pruned = 0;
    if (fs.existsSync(ARCHIVE_DIR)) {
      for (const dateDir of fs.readdirSync(ARCHIVE_DIR)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateDir) && dateDir < cutoff) {
          fs.rmSync(path.join(ARCHIVE_DIR, dateDir), { recursive: true, force: true });
          pruned++;
        }
      }
    }
    if (pruned > 0) console.log(`\nPruned ${pruned} directory(s) older than 90 days`);
  }

  console.log(`\n${hr}`);
  console.log(`  Archived: ${saved}  Errors: ${errors}`);
  console.log(`${hr}\n`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
