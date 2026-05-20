// =============================================================================
// Backblaze Daily Usage CSV Parser
// =============================================================================
// Backblaze delivers daily usage data as CSV files in a special account-only
// bucket: b2-reports-$ACCOUNTID/YYYY-MM-DD/Usage.csv
//
// Reference: https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports
//
// There is no JSON usage API. Storage bytes, egress, and Class A/B/C transaction
// counts are ONLY available through this CSV. This parser turns the CSV text
// into structured rows suitable for charting and aggregation.
//
// Real-world column set may vary slightly between accounts and versions.
// Backblaze documents that additional columns may be added over time, so this
// parser is tolerant of unknown columns and never errors on them.
// =============================================================================

const NUMERIC_COLUMNS = new Set([
  'storage_bytes_avg',
  'upload_bytes',
  'download_bytes',
  'class_a_txn',
  'class_b_txn',
  'class_c_txn',
]);

/**
 * Parse a daily usage CSV string into typed rows.
 * @param {string} csv - raw CSV text
 * @returns {Array<Object>} rows
 */
export function parseDailyUsageCsv(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      const raw = cells[idx];
      if (raw === undefined || raw === '') {
        row[h] = null;
      } else if (NUMERIC_COLUMNS.has(h)) {
        const n = Number(raw);
        row[h] = Number.isFinite(n) ? n : null;
      } else {
        row[h] = raw;
      }
    });
    rows.push(row);
  }

  return rows;
}

// =============================================================================
// Standard B2 Account Usage CSV parser
// =============================================================================
// Parses YYYY-MM-DD/Usage.csv from the b2-reports-<accountId> bucket.
// This is the standard (non-partner) format delivered for regular B2 accounts.
//
// Columns (as of 2026 — Backblaze may add more; unknown columns are ignored):
//   date, bucket_id, bucket_name, bucket_type, account_id,
//   storage_bytes_avg, upload_bytes, download_bytes,
//   class_a_txn, class_b_txn, class_c_txn
//
// Reference: https://www.backblaze.com/docs/cloud-storage-usage-reports
// =============================================================================

const STANDARD_NUMERIC = new Set([
  'storage_bytes_avg',
  'upload_bytes',
  'download_bytes',
  'class_a_txn',
  'class_b_txn',
  'class_c_txn',
]);

/**
 * Parse a standard B2 account Usage.csv into the same shape as
 * parseBackblazeGroupUsageCsv so both can feed fetchUsageFromReportsBucket.
 *
 * @param {string} csv - raw CSV text
 * @returns {Array} rows with { date, region, storageBytes, egressBytes,
 *                              uploadBytes, classATxn, classBTxn, classCTxn,
 *                              accountId, bucketId, bucketName }
 */
export function parseStandardUsageCsv(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const raw = {};
    headers.forEach((h, idx) => {
      const v = cells[idx];
      if (v === undefined || v === '') {
        raw[h] = null;
      } else if (STANDARD_NUMERIC.has(h)) {
        const n = Number(v);
        raw[h] = Number.isFinite(n) ? n : null;
      } else {
        raw[h] = v;
      }
    });

    rows.push({
      date:        raw.date                           || null,
      // Standard account CSVs may use either 'region' or 'reporting_location'
      region:      raw.region || raw.reporting_location || null,
      groupId:     null,
      accountId:   raw.account_id   || null,
      bucketId:    raw.bucket_id    || null,
      bucketName:  raw.bucket_name  || null,
      storageBytes: raw.storage_bytes_avg != null ? Math.round(raw.storage_bytes_avg) : null,
      egressBytes:  raw.download_bytes    != null ? Math.round(raw.download_bytes)    : null,
      uploadBytes:  raw.upload_bytes      != null ? Math.round(raw.upload_bytes)      : null,
      classATxn:   raw.class_a_txn != null ? Math.round(raw.class_a_txn) : null,
      classBTxn:   raw.class_b_txn != null ? Math.round(raw.class_b_txn) : null,
      classCTxn:   raw.class_c_txn != null ? Math.round(raw.class_c_txn) : null,
    });
  }
  return rows;
}

// Minimal CSV splitter — handles quoted fields with embedded commas.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"' && cur === '') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Roll up parsed rows by a given key.
 * @param {Array<Object>} rows
 * @param {string} keyCol - column to group by (e.g. 'sub_account_id', 'region')
 */
export function rollupBy(rows, keyCol) {
  const map = new Map();
  for (const row of rows) {
    const k = row[keyCol] ?? '__unknown__';
    if (!map.has(k)) {
      map.set(k, {
        [keyCol]: k,
        storage_bytes_avg: 0,
        upload_bytes: 0,
        download_bytes: 0,
        class_a_txn: 0,
        class_b_txn: 0,
        class_c_txn: 0,
        days: 0,
      });
    }
    const acc = map.get(k);
    acc.storage_bytes_avg = Math.max(acc.storage_bytes_avg, row.storage_bytes_avg || 0);
    acc.upload_bytes += row.upload_bytes || 0;
    acc.download_bytes += row.download_bytes || 0;
    acc.class_a_txn += row.class_a_txn || 0;
    acc.class_b_txn += row.class_b_txn || 0;
    acc.class_c_txn += row.class_c_txn || 0;
    acc.days += 1;
  }
  return Array.from(map.values());
}

/**
 * Convert raw CSV bytes into pricing-ready cost figures using current
 * Backblaze public pricing (2026).
 *
 * Pricing reference: https://www.backblaze.com/cloud-storage/pricing
 *   - Storage:  $6.95 / TB-month  ($0.00695 / GB-month)
 *   - Egress:   first 3x stored = free, then $0.01 / GB
 *   - Class A (uploads):       always free
 *   - Class B (downloads):     always free
 *   - Class C (list/metadata): always free
 *   - Class D (notifications): first 2,500/day free, then $0.004 / 10,000
 *
 * NOTE: Resellers typically negotiate volume pricing — these are list prices.
 */
export const PRICING = {
  storagePerGbMonth: 0.00695,   // $6.95 / TB-month
  egressFreeMultiplier: 3,
  egressPerGb: 0.01,
  classDFreePerDay: 2500,
  classDPer10k: 0.004,          // first 2,500/day free, then $0.004 / 10,000
};

export function estimateCost({ storageBytesAvg, downloadBytes, classDTxn, days = 30 }) {
  const storageGb = (storageBytesAvg || 0) / 1e9;
  const downloadGb = (downloadBytes || 0) / 1e9;
  const freeEgressGb = storageGb * PRICING.egressFreeMultiplier;
  const billableEgressGb = Math.max(0, downloadGb - freeEgressGb);
  const freeD = PRICING.classDFreePerDay * days;
  const billableD = Math.max(0, (classDTxn || 0) - freeD);
  return {
    storageCost: storageGb * PRICING.storagePerGbMonth,
    egressCost: billableEgressGb * PRICING.egressPerGb,
    classDCost: (billableD / 10000) * PRICING.classDPer10k,
    get total() {
      return this.storageCost + this.egressCost + this.classDCost;
    },
  };
}

// Convenience: load the bundled sample CSV via fetch (Vite serves /src files).
export async function loadSampleCsv() {
  // Imported as raw string at build time:
  const mod = await import('../data/sampleDailyUsage.csv?raw');
  return mod.default;
}

// =============================================================================
// Real Backblaze Group Usage CSV Parser
// =============================================================================
// Parses the actual CSV files that Backblaze writes to b2-reports-<accountId>.
// File pattern: YYYY-MM-DD/usage.group-<groupId>.<region>.csv
//
// Real column set (as of April 2026 — per Backblaze Partner API docs):
//   date, group_id, account_id, bucket_id, bucket_name, reporting_location,
//   stored_gb, storage_byte_hours, uploaded_gb, downloaded_gb,
//   api_txn_class_a, api_txn_class_b, api_txn_class_c
//
// Reference: https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports
//
// Returns rows shaped consistently with what the UI expects:
//   { date, region, storageBytes, egressBytes, uploadBytes,
//     classATxn, classBTxn, classCTxn, groupId, accountId, bucketId, bucketName }

const REAL_NUMERIC = new Set([
  'stored_gb',
  'storage_byte_hours',
  'uploaded_gb',
  'downloaded_gb',
  'api_txn_class_a',
  'api_txn_class_b',
  'api_txn_class_c',
]);

const GB_TO_BYTES = 1e9;

export function parseBackblazeGroupUsageCsv(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const raw = {};
    headers.forEach((h, idx) => {
      const v = cells[idx];
      if (v === undefined || v === '') {
        raw[h] = null;
      } else if (REAL_NUMERIC.has(h)) {
        const n = Number(v);
        raw[h] = Number.isFinite(n) ? n : null;
      } else {
        raw[h] = v;
      }
    });

    // Map to the shape the UI uses
    rows.push({
      date: raw.date || null,
      region: raw.reporting_location || null,
      groupId: raw.group_id || null,
      accountId: raw.account_id || null,
      bucketId: raw.bucket_id || null,
      bucketName: raw.bucket_name || null,
      // stored_gb × 1e9 → bytes; use storage_byte_hours for a daily average if present
      storageBytes: raw.stored_gb != null ? Math.round(raw.stored_gb * GB_TO_BYTES) : null,
      egressBytes: raw.downloaded_gb != null ? Math.round(raw.downloaded_gb * GB_TO_BYTES) : null,
      uploadBytes: raw.uploaded_gb != null ? Math.round(raw.uploaded_gb * GB_TO_BYTES) : null,
      classATxn: raw.api_txn_class_a != null ? Math.round(raw.api_txn_class_a) : null,
      classBTxn: raw.api_txn_class_b != null ? Math.round(raw.api_txn_class_b) : null,
      classCTxn: raw.api_txn_class_c != null ? Math.round(raw.api_txn_class_c) : null,
    });
  }
  return rows;
}

// =============================================================================
// CSV BUILDERS — generate Backblaze-shaped Usage.csv files
// =============================================================================
// Used by the per-customer "Download usage CSV" button. Mirrors the column set
// of the real Daily Usage CSV so anything that consumes the real file will
// also consume what we generate here.

const USAGE_COLUMNS = [
  'date', 'group_id', 'sub_account_id', 'bucket_id', 'bucket_name', 'region',
  'storage_bytes_avg', 'upload_bytes', 'download_bytes',
  'class_a_txn', 'class_b_txn', 'class_c_txn',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Build a CSV string from a list of usage rows. Rows must have keys matching
 * USAGE_COLUMNS (any extra keys are ignored).
 */
export function buildUsageCsv(rows) {
  const lines = [USAGE_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(USAGE_COLUMNS.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Trigger a browser download of arbitrary text content.
 */
export function downloadText(filename, content, mime = 'text/csv') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Derive an "activity" view of the daily usage CSV.
 *
 * IMPORTANT: Backblaze B2 does NOT publish per-request access logs. There is
 * no PutBucketLogging / GetBucketLogging on the S3-compatible API and no
 * b2_log_* endpoint on the Native API. The closest approximation is the
 * Class A / B / C transaction counts that appear per-bucket per-day in the
 * daily Usage.csv. For real per-event activity (object created, deleted, etc.)
 * you must configure Backblaze Event Notifications, which fire HTTP webhooks
 * to a destination you control:
 *   https://www.backblaze.com/docs/cloud-storage-event-notifications
 *
 * This function takes parsed CSV rows and returns a per-bucket-per-day
 * activity timeline suitable for charting and tabular display.
 *
 * @param {Array<Object>} rows - parseDailyUsageCsv output
 * @param {Object} opts
 * @param {string} [opts.subAccountId] - filter to a single customer
 * @param {string} [opts.bucketId] - filter to a single bucket
 * @returns {Array<{date, bucketId, bucketName, classA, classB, classC, total}>}
 */
export function activityFromCsv(rows, { subAccountId, bucketId } = {}) {
  return rows
    .filter((r) => !subAccountId || r.sub_account_id === subAccountId)
    .filter((r) => !bucketId || r.bucket_id === bucketId)
    .map((r) => ({
      date: r.date,
      bucketId: r.bucket_id,
      bucketName: r.bucket_name,
      region: r.region,
      classA: r.class_a_txn || 0,
      classB: r.class_b_txn || 0,
      classC: r.class_c_txn || 0,
      total: (r.class_a_txn || 0) + (r.class_b_txn || 0) + (r.class_c_txn || 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Build a synthetic per-customer daily usage CSV for a given window of days.
 * In production this would be a passthrough of the actual b2-reports-$ACCT
 * CSV file filtered for one customer.
 */
export function buildCustomerUsageCsv(customer, buckets, days = 30) {
  const today = new Date('2026-04-25T00:00:00Z');
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    for (const b of buckets) {
      const factor = 0.92 + Math.sin((i + b.bucketName.length) / 5) * 0.10;
      const dailyEgress = (customer.egressBytes30d / days) * (b.storageBytes / customer.storageBytes) * factor;
      const dailyUpload = dailyEgress * 0.18;
      const txnA = Math.round((customer.txnA30d / days) * (b.storageBytes / customer.storageBytes));
      const txnB = Math.round((customer.txnB30d / days) * (b.storageBytes / customer.storageBytes));
      const txnC = Math.round((customer.txnC30d / days) * (b.storageBytes / customer.storageBytes));
      rows.push({
        date,
        group_id: customer.groupId,
        sub_account_id: customer.accountId,
        bucket_id: b.bucketId,
        bucket_name: b.bucketName,
        region: b.region,
        storage_bytes_avg: Math.round(b.storageBytes * factor),
        upload_bytes: Math.round(dailyUpload),
        download_bytes: Math.round(dailyEgress),
        class_a_txn: txnA,
        class_b_txn: txnB,
        class_c_txn: txnC,
      });
    }
  }
  return buildUsageCsv(rows);
}
