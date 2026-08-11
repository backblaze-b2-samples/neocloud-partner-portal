// =============================================================================
// reportsArchive — shared reader/parser for the daily Backblaze usage-report
// CSVs (delivered to the `b2-reports-<accountId>` bucket and archived locally).
//
// Extracted from routes/masterB2.js so both the Usage proxy and the MCP usage
// tools parse the reports the same way. The local archive is the single source
// of truth for historical usage: server/data/reports/YYYY-MM-DD/<filename>.csv
//
// Row shape returned by parseCsv / loadArchiveRows:
//   { date, _date, region, groupId, accountId, bucketId, bucketName,
//     storageBytes, egressBytes, uploadBytes, classATxn..classDTxn }
// storageBytes is the END-OF-DAY stored bytes (from the report's `stored_gb`),
// which is the right signal for growth. See Backblaze Partner API Reports docs.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// server/data/reports/YYYY-MM-DD/<filename>.csv
export const ARCHIVE_DIR = path.join(__dirname, 'data', 'reports');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const REAL_NUMERIC = new Set([
  'stored_gb', 'storage_byte_hours', 'uploaded_gb', 'deleted_gb',
  'downloaded_gb', 'downloaded_bytes', 'downloaded_favored_bytes',
  'api_txn_class_a', 'api_txn_class_b', 'api_txn_class_c', 'api_txn_class_d',
]);
const STD_NUMERIC = new Set([
  'storage_bytes_avg', 'upload_bytes', 'download_bytes',
  'class_a_txn', 'class_b_txn', 'class_c_txn', 'class_d_txn',
]);
const GB = 1e9;

// Minimal CSV line splitter (handles quoted fields with embedded commas).
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

// Normalize a date string to YYYY-MM-DD regardless of how Backblaze formatted it.
// Partner/groups CSV uses M/D/YY (e.g. "5/9/26"); standard account CSV uses
// YYYY-MM-DD. Both come out as "2026-05-09" for downstream comparison/sort.
export function normalizeDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year  = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = String(m[1]).padStart(2, '0');
    const day   = String(m[2]).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

// Parse a CSV (partner or standard format) into the unified row shape.
export function parseCsv(text) {
  if (!text) return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const isPartner = headers.includes('stored_gb') || headers.includes('api_txn_class_a');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const raw = {};
    headers.forEach((h, idx) => {
      const v = cells[idx];
      const numSet = isPartner ? REAL_NUMERIC : STD_NUMERIC;
      if (v === undefined || v === '') {
        raw[h] = null;
      } else if (numSet.has(h)) {
        const n = Number(v);
        raw[h] = Number.isFinite(n) ? n : null;
      } else {
        raw[h] = v;
      }
    });

    if (isPartner) {
      rows.push({
        date:         normalizeDate(raw.date),
        region:       raw.reporting_location || raw.region || null,
        groupId:      raw.group_id || null,
        accountId:    raw.account_id || null,
        bucketId:     raw.bucket_id || null,
        bucketName:   raw.bucket_name || null,
        storageBytes: raw.stored_gb   != null ? Math.round(raw.stored_gb * GB)    : null,
        egressBytes:  raw.downloaded_gb != null ? Math.round(raw.downloaded_gb * GB) : null,
        uploadBytes:  raw.uploaded_gb  != null ? Math.round(raw.uploaded_gb * GB)  : null,
        classATxn:    raw.api_txn_class_a != null ? Math.round(raw.api_txn_class_a) : null,
        classBTxn:    raw.api_txn_class_b != null ? Math.round(raw.api_txn_class_b) : null,
        classCTxn:    raw.api_txn_class_c != null ? Math.round(raw.api_txn_class_c) : null,
        classDTxn:    raw.api_txn_class_d != null ? Math.round(raw.api_txn_class_d) : null,
      });
    } else {
      rows.push({
        date:         normalizeDate(raw.date),
        region:       raw.region || raw.reporting_location || null,
        groupId:      null,
        accountId:    raw.account_id || null,
        bucketId:     raw.bucket_id || null,
        bucketName:   raw.bucket_name || null,
        storageBytes: raw.storage_bytes_avg != null ? Math.round(raw.storage_bytes_avg) : null,
        egressBytes:  raw.download_bytes    != null ? Math.round(raw.download_bytes)    : null,
        uploadBytes:  raw.upload_bytes      != null ? Math.round(raw.upload_bytes)      : null,
        classATxn:    raw.class_a_txn != null ? Math.round(raw.class_a_txn) : null,
        classBTxn:    raw.class_b_txn != null ? Math.round(raw.class_b_txn) : null,
        classCTxn:    raw.class_c_txn != null ? Math.round(raw.class_c_txn) : null,
        classDTxn:    raw.class_d_txn != null ? Math.round(raw.class_d_txn) : null,
      });
    }
  }
  return rows;
}

// Returns a Set of already-archived relative paths, e.g. '2026-05-09/Usage.csv'.
export function loadArchivedFilenames() {
  const archived = new Set();
  if (!fs.existsSync(ARCHIVE_DIR)) return archived;
  let dateDirs;
  try { dateDirs = fs.readdirSync(ARCHIVE_DIR); } catch { return archived; }
  for (const dateDir of dateDirs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    let files;
    try { files = fs.readdirSync(path.join(ARCHIVE_DIR, dateDir)); } catch { continue; }
    for (const fname of files) {
      if (fname.toLowerCase().endsWith('.csv')) archived.add(`${dateDir}/${fname}`);
    }
  }
  return archived;
}

// Write a downloaded CSV to the local archive.
export function saveToArchive(fileName, content) {
  const parts   = fileName.split('/');
  const dateDir = parts[0];
  const base    = parts.slice(1).join('/');
  const dir     = path.join(ARCHIVE_DIR, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, base), content, 'utf8');
}

// Read and parse all archived CSVs at/after maxCutoff (a Date). Each row gets
// `_date` (normalized, falling back to the directory name).
export function loadArchiveRows(maxCutoff) {
  const rows = [];
  if (!fs.existsSync(ARCHIVE_DIR)) return rows;
  const cutoffStr = maxCutoff.toISOString().slice(0, 10);

  let dateDirs;
  try { dateDirs = fs.readdirSync(ARCHIVE_DIR); } catch { return rows; }

  for (const dateDir of dateDirs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    if (dateDir < cutoffStr) continue;

    let files;
    try { files = fs.readdirSync(path.join(ARCHIVE_DIR, dateDir)); } catch { continue; }

    for (const fname of files) {
      if (!fname.toLowerCase().endsWith('.csv')) continue;
      const relPath = `${dateDir}/${fname}`;
      try {
        const text = fs.readFileSync(path.join(ARCHIVE_DIR, dateDir, fname), 'utf8');
        const parsed = parseCsv(text);
        parsed.forEach((r) => { r._date = normalizeDate(r.date) || dateDir; });
        rows.push(...parsed);
      } catch (e) {
        console.warn(`[reportsArchive] archive read failed for ${relPath}: ${e.message}`);
      }
    }
  }
  return rows;
}
