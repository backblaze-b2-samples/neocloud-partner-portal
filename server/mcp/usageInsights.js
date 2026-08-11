// =============================================================================
// usageInsights — server-executed "custom tool" for the MCP chat agent.
//
// Answers storage-growth / usage-trend questions ("which customers grew the
// most/least", "who is shrinking / moving data off") by reusing the daily
// Backblaze usage reports the portal already ingests (b2-reports-* CSVs →
// server/data/reports archive). No re-download from B2.
//
// This is the "querying usage" capability of the storage-workflow MCP track:
// it reads usage/billing report metadata, NOT object contents — so it stays on
// the control-plane side of the agent's guardrail.
//
// Growth signal: per Backblaze Partner API Reports, `stored_gb` is the bytes
// stored AT THE END OF THE DAY. parseCsv maps that to `storageBytes`. Growth =
// (stored bytes on the latest day) − (stored bytes on the earliest day) in the
// window, summed across each account's buckets.
// =============================================================================

import { loadArchiveRows } from '../reportsArchive.js';
import { db } from '../db.js';

const GB = 1e9;
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function humanSize(bytes) {
  if (bytes == null) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${Math.round(n * 100) / 100} ${u[i]}`;
}

// The Anthropic tool definition the agent sees. Prescriptive "use this when…"
// description so the model reaches for it on growth/usage-trend questions.
export const USAGE_GROWTH_TOOL = {
  name: 'account_usage_growth',
  description:
    "Analyze how each sub-account's STORED data has grown or shrunk over a time window, from the daily Backblaze usage reports the portal already ingests. Call this for questions like \"which customers grew the most/least\", \"who is shrinking or moving data off\", or storage-growth trends across accounts. Returns, per account, the start vs current stored bytes, absolute and percent growth, plus egress and transactions over the window. Reads usage/billing report metadata only — never object contents.",
  input_schema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Window length in days (1–90). Default 30.' },
      order: {
        type: 'string',
        enum: ['most_grown', 'least_grown', 'shrinking'],
        description: "Optional ranking. 'most_grown' (default) sorts by largest absolute growth; 'least_grown' ascending; 'shrinking' returns only accounts that lost stored bytes.",
      },
      limit: { type: 'integer', description: 'Max accounts to return (default 50).' },
    },
  },
};

// Best-effort accountId → human label (display name preferred, else email).
// Guarded so a missing table/column never breaks the tool.
function buildNameMap() {
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT account_id, email FROM account_credentials').all()) {
      if (r.account_id && r.email && !map.has(r.account_id)) map.set(r.account_id, r.email);
    }
  } catch { /* table/column may not exist */ }
  try {
    for (const r of db.prepare('SELECT account_id, display_name FROM customer_metadata').all()) {
      if (r.account_id && r.display_name) map.set(r.account_id, r.display_name);
    }
  } catch { /* optional enrichment */ }
  return map;
}

/**
 * Pure: compute per-account storage growth from usage-report rows.
 * @param rows array of { accountId, _date, storageBytes, egressBytes, uploadBytes, classATxn..classDTxn }
 * @returns array sorted by growthBytes desc:
 *   { accountId, firstDate, lastDate, firstBytes, lastBytes, growthBytes, growthPct, egressBytes, uploadBytes, classCTxn, dataPoints }
 */
export function computeAccountGrowth(rows) {
  // accountId → date → summed end-of-day storage bytes (across buckets)
  const dailyStorage = new Map();
  // accountId → window totals
  const totals = new Map();

  for (const r of rows || []) {
    const acct = r.accountId;
    const date = r._date;
    if (!acct || !date) continue;

    if (!dailyStorage.has(acct)) dailyStorage.set(acct, new Map());
    if (r.storageBytes != null) {
      const byDate = dailyStorage.get(acct);
      byDate.set(date, (byDate.get(date) || 0) + r.storageBytes);
    }

    if (!totals.has(acct)) totals.set(acct, { egress: 0, upload: 0, txnC: 0 });
    const t = totals.get(acct);
    t.egress += r.egressBytes || 0;
    t.upload += r.uploadBytes || 0;
    t.txnC   += r.classCTxn  || 0;
  }

  const out = [];
  for (const [acct, byDate] of dailyStorage) {
    const dates = [...byDate.keys()].sort(); // YYYY-MM-DD lexicographic = chronological
    if (dates.length === 0) continue;
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const firstBytes = byDate.get(firstDate);
    const lastBytes = byDate.get(lastDate);
    const growthBytes = lastBytes - firstBytes;
    const growthPct = firstBytes > 0 ? (growthBytes / firstBytes) * 100 : null;
    const t = totals.get(acct) || { egress: 0, upload: 0, txnC: 0 };
    out.push({
      accountId: acct,
      firstDate, lastDate,
      firstBytes, lastBytes,
      growthBytes, growthPct,
      egressBytes: t.egress,
      uploadBytes: t.upload,
      classCTxn: t.txnC,
      dataPoints: dates.length,
    });
  }
  out.sort((a, b) => b.growthBytes - a.growthBytes);
  return out;
}

/**
 * Tool handler invoked by the chat agent. Scope-aware: partner staff get all
 * accounts; a customer user is restricted to their own accountId. Returns a
 * JSON string the model narrates.
 */
export async function runUsageGrowthTool({ session, input = {} }) {
  const days = Math.max(1, Math.min(90, Number(input.days) || 30));
  const order = input.order || 'most_grown';
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 50));

  const maxCutoff = new Date(Date.now() - days * 86_400_000);
  let rows = loadArchiveRows(maxCutoff);

  // Scope: a customer user only sees their own account.
  const scopeAccountId = session?.user?.accountId || null;
  if (scopeAccountId) rows = rows.filter((r) => r.accountId === scopeAccountId);

  if (!rows.length) {
    return JSON.stringify({
      ok: false,
      reason: scopeAccountId
        ? 'No usage-report data is available for this account yet.'
        : 'No usage-report data is ingested yet. Open "Usage & billing" once to pull the daily b2-reports CSVs, or confirm daily reports are enabled for this partner account.',
    });
  }

  const all = computeAccountGrowth(rows);
  const names = buildNameMap();

  let ranked = all;
  if (order === 'least_grown') ranked = [...all].sort((a, b) => a.growthBytes - b.growthBytes);
  else if (order === 'shrinking') ranked = all.filter((a) => a.growthBytes < 0).sort((a, b) => a.growthBytes - b.growthBytes);

  const earliest = all.reduce((m, a) => (m && m < a.firstDate ? m : a.firstDate), null);
  const latest = all.reduce((m, a) => (m && m > a.lastDate ? m : a.lastDate), null);

  const accounts = ranked.slice(0, limit).map((a) => ({
    account: names.get(a.accountId) || a.accountId,
    account_id: a.accountId,
    first_date: a.firstDate,
    last_date: a.lastDate,
    start_gb: round(a.firstBytes / GB),
    current_gb: round(a.lastBytes / GB),
    growth_gb: round(a.growthBytes / GB),
    growth_pct: a.growthPct == null ? null : round(a.growthPct, 1),
    egress_gb_window: round(a.egressBytes / GB),
    class_c_txn_window: a.classCTxn,
    data_points: a.dataPoints,
  }));

  return JSON.stringify({
    ok: true,
    window_days: days,
    earliest_date: earliest,
    latest_date: latest,
    account_count: all.length,
    shrinking_count: all.filter((a) => a.growthBytes < 0).length,
    metric_note: 'growth = end-of-day stored bytes on latest day minus earliest day in window (from the usage report stored_gb). GB = 1e9 bytes.',
    accounts,
  });
}

// ---------------------------------------------------------------------------
// largest_files_in_bucket — biggest objects in a bucket (TJ's example query).
//
// Reads the portal's nightly file index (file_index table: object name, size,
// upload time) — the same data behind the bucket file browser. Object METADATA
// only; never file contents. Scope-checked via object_counts.account_id so a
// customer user can only inspect their own buckets.
// ---------------------------------------------------------------------------

export const LARGEST_FILES_TOOL = {
  name: 'largest_files_in_bucket',
  description:
    "Find the largest files (objects) in a bucket, ranked by size. Call this for questions like \"where are my largest files\", \"what's taking up the most space in <bucket>\", or \"show the biggest objects in <bucket>\". Reads the portal's nightly file index (object name, size, upload time) — never file contents. Provide the bucket by name (preferred) or bucketId; a partial name is matched when unambiguous (otherwise candidate names are returned). Optionally pass a path prefix.",
  input_schema: {
    type: 'object',
    properties: {
      bucket: { type: 'string', description: 'Bucket name (preferred) or bucketId to inspect.' },
      limit: { type: 'integer', description: 'How many of the largest files to return (default 10, max 100).' },
      prefix: { type: 'string', description: 'Optional path prefix to filter to, e.g. "checkpoints/".' },
    },
    required: ['bucket'],
  },
};

export async function runLargestFilesTool({ session, input = {} }) {
  const bucketArg = String(input.bucket || '').trim();
  if (!bucketArg) return JSON.stringify({ ok: false, reason: 'Provide a bucket name or bucketId.' });
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 10));
  const prefix = input.prefix ? String(input.prefix) : '';

  const scopeAccountId = session?.user?.accountId || null;
  const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

  // Resolve name-or-id → { bucketId, accountId, bucketName } via object_counts:
  // exact match first, then a unique partial-name (fuzzy) match. For a customer
  // user the search is restricted to their own account, so it can't be used to
  // discover other accounts' bucket names.
  let resolved = null;
  try {
    const acctClause = scopeAccountId ? ' AND account_id = ?' : '';
    const acctArgs = scopeAccountId ? [scopeAccountId] : [];
    resolved = db
      .prepare(`SELECT bucket_id, account_id, bucket_name FROM object_counts WHERE (bucket_name = ? OR bucket_id = ?)${acctClause} LIMIT 1`)
      .get(bucketArg, bucketArg, ...acctArgs);

    if (!resolved) {
      const like = `%${escapeLike(bucketArg)}%`;
      const matches = db
        .prepare(`SELECT bucket_id, account_id, bucket_name FROM object_counts WHERE bucket_name LIKE ? ESCAPE '\\'${acctClause} ORDER BY bucket_name LIMIT 25`)
        .all(like, ...acctArgs);
      if (matches.length === 1) {
        resolved = matches[0];
      } else if (matches.length > 1) {
        return JSON.stringify({
          ok: false,
          reason: `"${bucketArg}" matches ${matches.length} buckets — please be more specific.`,
          candidates: matches.slice(0, 15).map((m) => m.bucket_name),
        });
      }
    }
  } catch { /* table may be empty */ }

  const bucketId = resolved?.bucket_id || bucketArg;
  const bucketName = resolved?.bucket_name || bucketArg;
  const ownerAccountId = resolved?.account_id || null;

  // Scope: a customer user may only inspect buckets in their own account.
  if (scopeAccountId && ownerAccountId !== scopeAccountId) {
    return JSON.stringify({ ok: false, reason: `Bucket "${bucketName}" is not in your account's scope.` });
  }

  let indexedAt = null;
  try {
    indexedAt = db.prepare('SELECT MAX(indexed_at) AS ts FROM file_index WHERE bucket_id = ?').get(bucketId)?.ts || null;
  } catch { /* ignore */ }

  let rows = [];
  try {
    if (prefix) {
      const like = prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      rows = db
        .prepare("SELECT file_name, size, uploaded_at, content_type FROM file_index WHERE bucket_id = ? AND file_name LIKE ? ESCAPE '\\' ORDER BY size DESC LIMIT ?")
        .all(bucketId, like, limit);
    } else {
      rows = db
        .prepare('SELECT file_name, size, uploaded_at, content_type FROM file_index WHERE bucket_id = ? ORDER BY size DESC LIMIT ?')
        .all(bucketId, limit);
    }
  } catch {
    return JSON.stringify({ ok: false, reason: 'The file index is unavailable.' });
  }

  if (!rows.length) {
    return JSON.stringify({
      ok: false,
      bucket: bucketName,
      bucket_id: bucketId,
      indexed_at: indexedAt,
      reason: indexedAt
        ? 'No files match in this bucket.'
        : 'This bucket has not been indexed yet (the nightly file-index job has not walked it). Trigger a sync from the bucket view, or try again later.',
    });
  }

  const files = rows.map((r) => ({
    name: r.file_name,
    size: humanSize(r.size),
    size_bytes: r.size,
    uploaded_at: r.uploaded_at,
    content_type: r.content_type,
  }));

  return JSON.stringify({
    ok: true,
    bucket: bucketName,
    bucket_id: bucketId,
    indexed_at: indexedAt,
    returned: files.length,
    note: 'Sizes are object byte sizes from the nightly file index; indexed_at is when this bucket was last walked.',
    files,
  });
}

// ---------------------------------------------------------------------------
// egress_leaders — who is pulling the most data OUT of B2 (downloaded bytes)
// over a period (default: current calendar month to date). Same usage-report
// source as account_usage_growth; egress = the report's downloaded_gb.
// ---------------------------------------------------------------------------

export const EGRESS_LEADERS_TOOL = {
  name: 'egress_leaders',
  description:
    "Rank who is pulling the most data OUT of Backblaze (egress / downloaded bytes) over a period — by default the current calendar month to date. Call this for questions like \"who are my egress leaders this month\", \"which customers are downloading the most\", or \"where is my egress concentrated\". Returns the top accounts (or buckets) by downloaded bytes, each with its share of total egress. Reads the daily usage reports — usage/billing metadata, not object data.",
  input_schema: {
    type: 'object',
    properties: {
      by: { type: 'string', enum: ['account', 'bucket'], description: "Rank by 'account' (default) or individual 'bucket'." },
      days: { type: 'integer', description: 'Rolling window length in days (1–90). Omit to use the current calendar month to date.' },
      limit: { type: 'integer', description: 'How many leaders to return (default 15, max 100).' },
    },
  },
};

/** Pure: group usage rows and sum egress (and upload, class-C txn) per key. */
export function computeEgressLeaders(rows, { by = 'account' } = {}) {
  const groups = new Map();
  for (const r of rows || []) {
    const key = by === 'bucket' ? (r.bucketId || r.bucketName) : r.accountId;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { key, accountId: r.accountId || null, bucketName: r.bucketName || null, egress: 0, upload: 0, txnC: 0 });
    }
    const g = groups.get(key);
    g.egress += r.egressBytes || 0;
    g.upload += r.uploadBytes || 0;
    g.txnC += r.classCTxn || 0;
  }
  return [...groups.values()].sort((a, b) => b.egress - a.egress);
}

export async function runEgressLeadersTool({ session, input = {} }) {
  const by = input.by === 'bucket' ? 'bucket' : 'account';
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 15));

  // Period: explicit rolling `days`, else the current calendar month to date.
  let cutoff, periodLabel;
  if (input.days) {
    const days = Math.max(1, Math.min(90, Number(input.days)));
    cutoff = new Date(Date.now() - days * 86_400_000);
    periodLabel = `last ${days} days`;
  } else {
    const now = new Date();
    cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    periodLabel = `month to date (${cutoff.toISOString().slice(0, 7)})`;
  }

  let rows = loadArchiveRows(cutoff);
  const scopeAccountId = session?.user?.accountId || null;
  if (scopeAccountId) rows = rows.filter((r) => r.accountId === scopeAccountId);

  if (!rows.length) {
    return JSON.stringify({
      ok: false,
      reason: scopeAccountId
        ? 'No usage-report data for this account in the period.'
        : 'No usage-report data ingested yet. Open "Usage & billing" once to pull the daily b2-reports CSVs.',
    });
  }

  const ranked = computeEgressLeaders(rows, { by });
  const totalEgress = ranked.reduce((s, g) => s + g.egress, 0);
  const names = buildNameMap();

  const leaders = ranked.slice(0, limit).map((g) => ({
    [by]: by === 'bucket' ? (g.bucketName || g.key) : (names.get(g.accountId) || g.accountId),
    ...(by === 'bucket' ? { account: names.get(g.accountId) || g.accountId } : {}),
    egress_gb: round(g.egress / GB),
    share_pct: totalEgress > 0 ? round((g.egress / totalEgress) * 100, 1) : null,
    upload_gb: round(g.upload / GB),
    class_c_txn: g.txnC,
  }));

  return JSON.stringify({
    ok: true,
    period: periodLabel,
    rank_by: by,
    total_egress_gb: round(totalEgress / GB),
    leader_count: ranked.length,
    note: 'egress = downloaded (billable) bytes summed over the period, from the usage report downloaded_gb. GB = 1e9 bytes.',
    leaders,
  });
}

// ---------------------------------------------------------------------------
// bucket_lifecycle_hygiene — find buckets accumulating STALE data (old objects)
// that likely need a lifecycle / expiration rule. Reads the nightly file index
// (object upload times). Lifecycle rules themselves live on the live bucket
// config, so the agent should confirm via the MCP bucket tools before
// proposing a change.
// ---------------------------------------------------------------------------

export const LIFECYCLE_HYGIENE_TOOL = {
  name: 'bucket_lifecycle_hygiene',
  description:
    "Find buckets accumulating STALE data — lots of old objects that likely need a lifecycle/expiration rule (or have outgrown the one they have). Call this for \"which buckets have stale data\", \"where should I add lifecycle rules\", \"what's old and can be cleaned up\", or storage cost-hygiene questions. Returns buckets ranked by stale bytes, with the share of data older than the threshold. Reads the nightly file index (object metadata, not contents). To confirm whether a flagged bucket actually has a lifecycle rule, follow up with the MCP bucket tools; applying a rule via b2_update_bucket is a gated change.",
  input_schema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Objects last uploaded more than this many days ago count as stale (default 30). If a query returns nothing stale, the response reports the oldest object age so you can retry with a smaller threshold.' },
      limit: { type: 'integer', description: 'How many buckets to return (default 15, max 100).' },
    },
  },
};

export async function runLifecycleHygieneTool({ session, input = {} }) {
  const days = Math.max(1, Math.min(3650, Number(input.days) || 30));
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 15));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const scopeAccountId = session?.user?.accountId || null;

  let rows = [];
  try {
    const sql = `
      SELECT fi.bucket_id AS bucketId,
             oc.bucket_name AS bucketName,
             oc.account_id AS accountId,
             COUNT(*) AS objects,
             COALESCE(SUM(fi.size), 0) AS bytes,
             SUM(CASE WHEN fi.uploaded_at IS NOT NULL AND fi.uploaded_at < ? THEN 1 ELSE 0 END) AS staleObjects,
             COALESCE(SUM(CASE WHEN fi.uploaded_at IS NOT NULL AND fi.uploaded_at < ? THEN fi.size ELSE 0 END), 0) AS staleBytes,
             MIN(fi.uploaded_at) AS oldest
      FROM file_index fi
      ${scopeAccountId ? 'JOIN' : 'LEFT JOIN'} object_counts oc ON oc.bucket_id = fi.bucket_id
      ${scopeAccountId ? 'WHERE oc.account_id = ?' : ''}
      GROUP BY fi.bucket_id
      ORDER BY staleBytes DESC
      LIMIT ?`;
    const args = scopeAccountId ? [cutoff, cutoff, scopeAccountId, limit] : [cutoff, cutoff, limit];
    rows = db.prepare(sql).all(...args);
  } catch {
    return JSON.stringify({ ok: false, reason: 'The file index is unavailable.' });
  }

  const stale = rows.filter((r) => r.staleBytes > 0);
  if (!stale.length) {
    // Report how old the oldest object actually is, so the model can retry with
    // a smaller threshold instead of concluding there's nothing to clean up.
    let oldestDays = null;
    try {
      const oldest = scopeAccountId
        ? db.prepare('SELECT MIN(fi.uploaded_at) ts FROM file_index fi JOIN object_counts oc ON oc.bucket_id = fi.bucket_id WHERE oc.account_id = ? AND fi.uploaded_at IS NOT NULL').get(scopeAccountId)?.ts
        : db.prepare('SELECT MIN(uploaded_at) ts FROM file_index WHERE uploaded_at IS NOT NULL').get()?.ts;
      if (oldest) oldestDays = Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000);
    } catch { /* ignore */ }
    return JSON.stringify({
      ok: false,
      oldest_object_age_days: oldestDays,
      reason: oldestDays != null
        ? `No objects older than ${days} days. The oldest indexed object is about ${oldestDays} days old — retry with a smaller threshold (e.g. days: ${Math.max(1, Math.floor(oldestDays / 2))}) to surface cleanup candidates.`
        : `No indexed buckets have objects older than ${days} days (or the nightly file-index job has not run yet).`,
    });
  }

  const names = buildNameMap();
  const buckets = stale.map((r) => ({
    bucket: r.bucketName || r.bucketId,
    account: r.accountId ? (names.get(r.accountId) || r.accountId) : null,
    objects: r.objects,
    total: humanSize(r.bytes),
    stale_objects: r.staleObjects,
    stale: humanSize(r.staleBytes),
    stale_gb: round(r.staleBytes / GB),
    stale_share_pct: r.bytes > 0 ? round((r.staleBytes / r.bytes) * 100, 1) : null,
    oldest_object: r.oldest,
  }));

  return JSON.stringify({
    ok: true,
    stale_threshold_days: days,
    bucket_count: buckets.length,
    note: `"stale" = objects last uploaded more than ${days} days ago, from the nightly file index. A high stale share suggests a missing or too-loose lifecycle rule; confirm the bucket's lifecycleRules via the MCP bucket tools before proposing a change.`,
    buckets,
  });
}
