# Backblaze B2 — Claude Knowledge Base

Drop this file into any project as `CLAUDE.md` (or import it into one) to give Claude
accurate, production-tested context about the B2 Native API, Partner API, CSV reports,
and the non-obvious gotchas discovered while building real dashboards against it.

---

## What B2 is (and isn't)

B2 is object storage — one hot storage class only. There is no cold/archive/infrequent-access
tier like AWS S3 Glacier or GCS Nearline. Lifecycle rules on B2 only **hide** and **delete**
files; they cannot transition objects to a cheaper class.

B2 has two API surfaces:
- **B2 Native API** — B2-specific endpoints (`/b2api/v4/...`). Preferred for everything the S3-compatible layer doesn't cover (key management, bucket metadata, reports, Partner API).
- **S3-compatible API** — AWS-style endpoints (`s3.<region>.backblazeb2.com`). Use for workloads already using S3 SDKs, SigV4 signing, or features like `PutBucketLogging`.

They are separate auth surfaces. A key that works on the Native API does not automatically work on the S3-compatible layer without SigV4 signing.

---

## Authentication — b2_authorize_account

**Endpoint:** `GET https://api.backblazeb2.com/b2api/v4/b2_authorize_account`
**Auth:** HTTP Basic with `applicationKeyId:applicationKey`

**API v4 response shape** (changed from v2/v3 — easy to get wrong):

```json
{
  "accountId": "...",
  "authorizationToken": "...",
  "apiInfo": {
    "storageApi": {
      "apiUrl":      "https://api005.backblazeb2.com",
      "downloadUrl": "https://f005.backblazeb2.com",
      "s3ApiUrl":    "https://s3.us-west-004.backblazeb2.com"
    },
    "groupsApi": {
      "groupsApiUrl": "https://api005.backblazeb2.com"
    }
  }
}
```

In v2/v3, `apiUrl` and `downloadUrl` were top-level fields. In v4 they are nested under
`apiInfo.storageApi`. If your code reads `response.apiUrl` directly it will get `undefined`.

For Partner/Groups API calls, use `apiInfo.groupsApi.groupsApiUrl` — not `storageApi.apiUrl`.

The token is valid for at most 24 hours. Cache it; re-authorize only on expiry or 401.

---

## CORS — Proxy All Native API Calls Server-Side

Do not design a browser SPA to call the B2 Native API directly. B2 does not send CORS
headers that allow arbitrary browser origins for most Native API endpoints, including
`b2_authorize_account`, `b2_get_upload_url`, `b2_start_large_file`,
`b2_get_upload_part_url`, and `b2_finish_large_file`.

**Route everything through a server-side proxy.**

- The Download URL (`f###.backblazeb2.com`) requires an `Authorization` header for private buckets, which triggers a CORS preflight that B2 will not satisfy for system buckets like `b2-reports-*`.
- For private browser downloads (where a direct download link is needed), use `b2_get_download_authorization` and pass the returned token as a URL query parameter rather than as an `Authorization` header.

**Practical proxy pattern:**
```
Browser → GET /b2-proxy/b2api/v4/b2_authorize_account → nginx → api.backblazeb2.com
Browser → POST /api/master-b2/reports-csv → Express → f###.backblazeb2.com (server-side)
```

Nginx handles the URL rewrite (`/b2-proxy` → `https://api.backblazeb2.com`).
Express handles downloads that require auth headers.

---

## Buckets — b2_list_buckets

**What the API returns:** bucket metadata only — name, type, encryption config, lifecycle
rules, CORS rules, Object Lock settings, replication config.

**What the API does NOT return:** storage bytes, object count, last-modified timestamp.
Those are not exposed by `b2_list_buckets`. To get them you must either:
1. Iterate all file versions and sum (expensive, not practical for dashboards), or
2. Parse the daily usage CSV report (see below).

**Key fields:**
- `bucketType`: `"allPublic"` or `"allPrivate"`
- `defaultServerSideEncryption.value.mode`: `"SSE-B2"`, `"SSE-C"`, or absent (no encryption) — note the nested `.value.` layer
- `fileLockConfiguration.value.isFileLockEnabled`: boolean — note the nested `.value.` layer
- `lifecycleRules`: array; B2 rules only hide/delete, no storage-class transitions
- `replicationConfiguration.asReplicationSource.replicationRules[0].destinationBucketId`

`b2_list_buckets` returns **all buckets in a single response** — there is no server-side
pagination. Client-side pagination is fine for display.

---

## Application Keys — b2_list_keys / b2_create_key

**b2_list_keys** returns `keys[]`. Each key has:
- `applicationKeyId` — public identifier (safe to display)
- `capabilities` — array of strings: `readFiles`, `writeFiles`, `deleteFiles`,
  `listBuckets`, `writeBucketInfo`, `deleteBuckets`, `readBucketEncryption`,
  `writeBucketEncryption`, `readFileLegalHolds`, `writeFileLegalHolds`, etc.
- `bucketIds` — **array** in API v4 (changed from `bucketId` singular in v2/v3). An empty
  array or absent field means the key has account-wide access. For backward compatibility,
  parsers should tolerate legacy responses that contain `bucketId` (singular):
  ```js
  const bucketIds = Array.isArray(k.bucketIds) ? k.bucketIds
                  : k.bucketId ? [k.bucketId] : [];
  ```
- `expirationTimestamp` — epoch ms, or null if the key never expires
- `namePrefix` — restricts the key to files with this prefix

**What the API does NOT return:** last-used timestamp. There is no `lastUsed` field.
The only way to find when a key was last used is to mine Bucket Access Logs and find the
max timestamp for that key's `applicationKeyId` in the log records.

**Dangerous capabilities** (flag in a security dashboard):
- `deleteFiles`, `deleteBuckets`, `writeBucketInfo` — destructive without expiry = high risk

---

## Object Lock

Object Lock can be enabled at bucket creation **or later** using `b2_update_bucket` with
`fileLockEnabled: true`. Once enabled it cannot be disabled.

A bucket can have **default retention settings** that new uploads inherit automatically.
Individual file versions can also have their own retention and legal hold settings applied
via `b2_update_file_retention` and `b2_update_file_legal_hold` after upload.

- **Compliance mode** — object cannot be deleted or overridden before the retention date, even by the account owner.
- **Governance mode** — locked unless the `bypassGovernance` capability is granted on the key.

---

## Usage Data — There Is No JSON Usage API

B2 does not expose storage, egress, or transaction counts via any JSON endpoint.
`b2_list_buckets` has no usage fields. There is no `b2_get_usage` or equivalent.

**All usage metrics come from daily CSV reports.**

---

## Daily Usage CSV Reports

### Setup
Enable at: `https://secure.backblaze.com/reports.htm`

B2 creates a special system bucket named `b2-reports-<accountId>` and deposits one or
more CSV files into it each night covering the previous day's usage.

### Bucket structure
```
b2-reports-<accountId>/
  2026-05-09/
    usage.group-<groupId>.us-west-002.csv   ← partner format (per group, per region)
    usage.group-<groupId>.eu-central-003.csv
  2026-05-10/
    ...
```

The directory name is the **deposit date** (when the report was generated).
The `date` column inside the CSV is the **data date** (which day the usage covers).
For standard accounts these are the same. For partner/group CSVs they may differ by one day.

### Retention
When reports are first enabled, B2 **backfills up to 7 previous days** and may also
regenerate missing report files from the recent 7-day window if they disappear. Reports
remain in the bucket as long as they are not deleted — B2 does not impose a short
automatic retention window. Do not confuse the 7-day backfill with a 7-day retention limit.

### Local archive — performance layer, not a retention workaround
Even though B2 keeps reports indefinitely, re-downloading 90 days of CSVs on every
dashboard request is wasteful. Keep a local archive of already-parsed files:

```
server/data/reports/
  2026-05-09/
    usage.group-xxx.us-west-002.csv
  2026-05-10/
    ...
```

**Pattern:** on each request, list the b2-reports bucket, compare against what's already
on disk, download **only new files**, save them to the archive, then read all data
from the archive. The archive is the single source of truth — B2 is only queried
for files not yet seen.

```
# Optional nightly cron to pre-populate the archive before peak traffic:
30 10 * * *  node server/archive-reports.mjs >> /var/log/archive.log 2>&1
```

The cron is a nice-to-have, not required — the live request path does the same thing
lazily on the first request of the day.

### CSV format guidance

**Treat CSVs as header-driven, not position-driven.** Backblaze documents that usage report
formats may change and columns may be added. Always parse by header name; never assume
column order or a closed set of columns.

**Current documented fields** (as of mid-2026) include:
`date`, `account_id`, `account_email`, `group_id`, `bucket_id`, `bucket_name`,
`reporting_location`, `resource_group_id`, `resource_group_name`, `line_version`,
`stored_gb`, `storage_byte_hours`, `uploaded_gb`, `downloaded_gb`, `downloaded_bytes`,
`downloaded_favored_bytes`, `deleted_gb`, `api_txn_class_a`, `api_txn_class_b`,
`api_txn_class_c`, `api_txn_class_d`.

Some older or internally-generated report variants have been observed with different field
names (`storage_bytes_avg`, `upload_bytes`, `download_bytes`, `class_a_txn`, etc.). Keep
parsers tolerant of both naming schemes and detect format by inspecting header names at
parse time.

**Row types:** Usage CSVs include per-bucket rows (with `bucket_id`) and may also include
account-level transaction rows (without `bucket_id`, or with a blank bucket). Account-level
rows cover transactions that are not attributable to a specific bucket. When aggregating
storage, require both `account_id` and `bucket_id` to be non-null. When aggregating
transactions for display, decide whether to include or exclude account-level rows.

### ⚠️ Date format — normalize defensively

Official Backblaze docs describe the report `date` field as `YYYY-MM-DD`. However, some
partner/group exports have been observed in production using a legacy `M/D/YY` format
(e.g. `5/9/26`). If you use the raw `date` field as a sort key or map key without
normalizing, `"5/9/26"` sorts **after** all `"2026-..."` entries (because `"5" > "2"`
lexicographically), breaking charts and date windows entirely.

**Always normalize before using:**
```js
function normalizeDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; // already correct
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year  = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = String(m[1]).padStart(2, '0');
    const day   = String(m[2]).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null; // fall back to the file's directory date
}
```

Apply this to `raw.date` at parse time. If it returns null, fall back to the directory
name (e.g. `"2026-05-09"` extracted from `"2026-05-09/usage.group-xxx.csv"`).

### Region alias normalization

The `reporting_location` field in partner CSVs uses internal region aliases that may not
match the canonical region IDs returned by the Native API. For example `us-west-004` is
an alias for `us-west-002`. Build a lookup table of known aliases and normalize before
joining to region metadata.

### Listing files in the reports bucket

Use `b2_list_file_names` (not `b2_list_file_versions`). The reports bucket is a system
bucket typed `"restricted"` or `"snapshot"` depending on context. To ensure it appears
in `b2_list_buckets`, request `bucketTypes: ["all"]` — it will not appear if you request
only `["allPublic", "allPrivate"]`. `b2_list_file_names` rejects `accountId` in the body — omit it:

```js
const page = await callB2('b2_list_file_names', {
  bucketId: reportsBucket.bucketId,
  maxFileCount: 1000,
  // NO accountId here — the endpoint rejects it as an unknown field
});
```

### Serving the reports CSV from the server side

The browser cannot download files from `f###.backblazeb2.com` with an auth header
(CORS preflight blocked). Delegate to a server-side route:

1. Browser calls `ensureAuth()` to get token + URLs
2. Browser POSTs `{ authorizationToken, apiUrl, downloadUrl, accountId, days }` to your Express route
3. Express uses those credentials directly to call `b2_list_file_names` → download → parse → return JSON
4. No re-authorization needed on the server — the browser's token is used as-is

Cache the parsed rows server-side (keyed by `accountId`, 20-min TTL) so repeated chart
loads don't re-download all CSV files on every request.

---

## Credential Architecture (Two Sources, Not One)

If you have a server-side cron that archives CSVs AND a browser that fetches live data,
these are **independent credential sources**:

| Path | Credentials from |
|------|-----------------|
| Nightly archive cron | `B2_MASTER_KEY_ID` / `B2_MASTER_APP_KEY` in server `.env` |
| Live chart fetch | Browser `localStorage` → sent in POST body to server |

The server's Express route for the live path uses whatever credentials the browser sends.
It does **not** read `.env`. If the browser has stale credentials (old account) and `.env`
has new credentials, the archive and the live fetch will query **different B2 accounts**.

To prove which account the live chart is using: inspect `localStorage["bb-neocloud-config"]`
(or equivalent) in the browser dev tools and check `masterKeyId`.

---

## Partner API

**Base version:** v3 (not v4 — different from the storage API)
**Base URL:** use `apiInfo.groupsApi.groupsApiUrl` from `b2_authorize_account` — **not**
`storageApi.apiUrl`. The host is typically the same, but the correct field is `groupsApiUrl`.

```
POST https://api005.backblazeb2.com/b2api/v3/b2_list_groups
```

### Groups
Groups are organizational containers for sub-accounts (customers). One partner account
can have multiple groups.

- `b2_list_groups` — list all groups. `maxGroupCount` is capped at 100; sending > 100 is rejected. Paginate with `nextGroupId`.
- `b2_list_group_members` — list sub-accounts in a group. `maxMemberCount` can be up to 1000. Returns `b2Stats` per member (bucket count etc.) — **unreliable in practice; often returns 0**.
- `b2_create_group_member` — provision a new sub-account under a group.
- `b2_eject_group_member` — remove a sub-account from a group (optionally change its email).

The Partner API is CORS-blocked just like the Native API. Proxy it server-side.

---

## Bucket Access Logs

B2 supports per-request audit logging via the **S3-compatible** API (not Native API).

**Configure:** `PUT https://<bucket>.s3.<region>.backblazeb2.com/?logging` (XML body)
**Read config:** `GET https://<bucket>.s3.<region>.backblazeb2.com/?logging`
**Required capabilities:** `writeBucketLogging`, `readBucketLogging`

Log files are delivered to a destination bucket on a best-effort basis (typically within
a few hours of the event). Format follows the **AWS S3 server access log** format with
two B2 exceptions: `Access Point ARN` and `aclRequired` are always empty/dash.

**Log file path pattern:**
```
{prefix}/{accountId}/{region}/{sourceBucketName}/{YYYY}/{MM}/{DD}/{timestamp}-{uid}
```

**To get "key last used" timestamps:** there is no API field for this. Mine the access logs,
group by the key's `applicationKeyId` field in each log record, and take the max timestamp.

**SigV4 required** for the S3-compatible logging endpoints. The browser cannot sign SigV4
requests directly — proxy through Express with the sub-account credentials.

---

## Pricing (as of mid-2026 list rates)

| Component | Rate |
|-----------|------|
| Storage | $6.95 / TB / month |
| Egress | First 3× stored GB free, then $0.01 / GB |
| Class A (uploads, deletes, bucket ops) | Always free |
| Class B (downloads, HEAD) | Always free |
| Class C (list, metadata) | Always free |
| Class D (event notifications) | First 2,500 / day free, then $0.004 / 10k |

Egress free allowance resets monthly and is calculated as 3× your average stored GB.
Bandwidth from B2 to Cloudflare is always free (Bandwidth Alliance).

---

## Regions

**Do not hard-code region-to-host mappings for production API calls.** Always use the URLs
returned by `b2_authorize_account` (`apiInfo.storageApi.apiUrl`, `downloadUrl`, `s3ApiUrl`).
An account's region is fixed at creation time and cannot be changed.

Known public regions as of mid-2026:

| Region | Locations |
|--------|-----------|
| US West | Sacramento, Stockton, Phoenix |
| US East | Reston, VA |
| EU Central | Amsterdam |
| Canada East | Toronto |

S3 endpoint pattern: `s3.<region-id>.backblazeb2.com`
Download URL pattern: `f<N>.backblazeb2.com` (same N as `api<N>` in the apiUrl)

The `reporting_location` field in partner CSVs may use internal aliases that differ from
canonical region IDs (e.g. `us-west-004` observed for `us-west-002`). Normalize these
before joining to region metadata or display labels.

---

## Audit CSV Files — Double-Count Trap

The `b2-reports-<accountId>` bucket contains two kinds of CSV files:

| File pattern | Has `account_id`? | Has `stored_gb`? | Purpose |
|---|---|---|---|
| `usage.group-<groupId>.<region>.csv` | ✅ Yes | ✅ Yes | Per-bucket data for each sub-account |
| `usage.audit-group-<groupId>.csv` | ❌ No | ✅ Yes | Audit/reconciliation totals |

**The audit files have `stored_gb` but no `account_id` column.** If you parse all CSVs in the bucket uniformly (which is natural), you will include audit rows alongside per-bucket rows. The `parseCsv()` function in partner format mode will parse both, but audit rows will have `accountId: null`.

**If you sum storage without filtering on `accountId`, you will double-count every byte.**

**Two-layer defense** — filter by filename first, then require both keys when aggregating:

```js
// Layer 1: skip audit files entirely when building per-account/per-bucket rollups
const isAuditFile = /^usage\.audit-/.test(baseName);
if (isAuditFile) continue; // or parse separately for reconciliation only

// Layer 2: even in usage files, some rows are account-level (no bucket_id)
// Require both account_id and bucket_id for storage rollups
for (const r of rawRows) {
  if (!r.accountId || !r.bucketId) continue;
  cur.storageBytes += r.storageBytes || 0;
}
```

This applies to any aggregation that reads the raw rows: per-bucket rollups, per-account rollups, and any total calculations.

---

## Partner CSV Rows Are Per-Bucket (Plus Account-Level Transaction Rows)

Most rows in a group/partner CSV represent one bucket for one account on one day. However,
usage CSVs may also include **account-level transaction rows** (with no `bucket_id`) because
some transactions are reported at the account level rather than the bucket level.

To get account-level storage totals: sum per-bucket rows (require `bucket_id`) for that
`account_id` on the target date. There are no pre-aggregated storage total rows.

To get account-level transaction totals: decide whether to include or exclude account-level
rows (those with no `bucket_id`). Including them avoids undercounting transactions.

- Storage (`stored_gb`) is a daily average snapshot — summing per-bucket gives the correct account total for that day
- Egress/transactions are cumulative — summing across all rows in the date window gives the 30-day total

---

## b2_list_group_members Does Not Reliably Return b2Stats

`b2_list_group_members` has a `b2Stats` field documented as returning per-account storage and bucket counts. **In practice it consistently returns 0 or is absent for all sub-accounts.** Do not rely on it for storage metrics.

**Use the daily CSV reports as the authoritative source for all storage, egress, and transaction metrics.** The CSV is the only reliable way to get these numbers for sub-accounts.

---

## Listing Large Buckets — Performance Architecture

`b2_list_file_names` returns files in **lexicographic name order only** with cursor-based forward pagination (`startFileName` / `nextFileName`). There is no server-side sort by size or date. For a bucket with millions of files, any non-name sort requires loading all pages client-side — completely impractical at scale.

### The solution: a local SQLite file index

The 24-hour background job that counts objects also writes per-file metadata to a `file_index` SQLite table as it paginates each bucket. The UI reads from this table at browse time — no B2 API call at all, any sort order, sub-millisecond response.

```sql
CREATE TABLE IF NOT EXISTS file_index (
  bucket_id    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_id      TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  uploaded_at  TEXT,           -- ISO from B2 uploadTimestamp
  content_type TEXT,
  indexed_at   TEXT NOT NULL,
  PRIMARY KEY (bucket_id, file_name)
);
CREATE INDEX IF NOT EXISTS idx_fidx_bucket   ON file_index(bucket_id);
CREATE INDEX IF NOT EXISTS idx_fidx_uploaded ON file_index(bucket_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_fidx_size     ON file_index(bucket_id, size);
```

**Stale-row pruning:** After each full bucket walk, delete rows whose `indexed_at` is earlier than the current run — these are files that have been deleted from the bucket since the last index:

```js
DELETE FROM file_index WHERE bucket_id = ? AND indexed_at < ?
```

**API route:** `GET /api/master-b2/file-index/:bucketId?prefix=&limit=100&offset=0&sortBy=name&sortDir=asc`
- `sortBy`: `name` | `size` | `uploadedAt`
- Returns `{ files, total, indexedAt, isComplete }` — `isComplete: false` means not yet indexed

**Client probe pattern:** On mount, call the route with `limit=1` to check `isComplete`. If true, use offset pagination against the index for all sorts. If false, fall back to live `b2_list_file_names` cursor pagination.

**Freshness:** The index is a 24-hour snapshot. Wire up [Event Notifications](https://www.backblaze.com/docs/cloud-storage-event-notifications) to upsert/delete individual rows on upload/delete events for near-real-time freshness between full scans.

**Scale notes:**
- Each page of 1000 files is written in a single SQLite transaction (fast; avoids per-row overhead)
- SQLite handles tens of millions of rows per table without issue at this access pattern
- For extremely large buckets (100M+ files), cap the index per bucket and surface a notice — but this is rarely needed in practice
- List calls (Class C) are free on B2; the only cost of the nightly walk is time and server CPU

---

## Object Counts Are Not in the CSV

The daily CSV reports contain `stored_gb`, egress, and transaction columns — they do not contain object counts. `b2_list_buckets` also does not return object counts.

**The only way to get object counts is file iteration:**
```js
// Paginate b2_list_file_names (current versions only — not b2_list_file_versions)
// IMPORTANT: pass startFileName on every page after the first, or you loop forever.
let count = 0;
let nextFileName = null;
do {
  const opts = { bucketId, maxFileCount: 1000 };
  if (nextFileName) opts.startFileName = nextFileName;
  const page = await b2Post(auth, 'b2_list_file_names', opts);
  count += page.files.length;
  nextFileName = page.nextFileName || null;
} while (nextFileName);
```

Use `b2_list_file_names` (not `b2_list_file_versions`) — it returns only the current (non-hidden) version of each file, which is the right count for "how many objects are in this bucket."

**For dashboards, cache this in a database.** A 24-hour background job that writes counts to SQLite is the right pattern. Page loads then do a single DB read with no B2 API call at render time:

```
Server startup → scheduleObjectCountJob()
  15 seconds later → runObjectCountJob()
    listCredentials() → for each sub-account:
      b2_authorize_account → b2_list_buckets → paginate b2_list_file_names → upsert to DB
  Every 24 hours → repeat

GET /api/master-b2/object-counts → SELECT * FROM object_counts (instant)
Browser → merge Map<bucketId, count> into bucket list at render time
```

---

## Transaction Count Floating Point

When computing a 30-day average from daily CSV rows and displaying it without decimal places, floating point drift produces values like `994.9999999999999` instead of `995`.

Always apply `Math.round()` before display:
```js
// WRONG:
return `${n}`;           // → "994.9999999999999"

// CORRECT:
return `${Math.round(n)}`; // → "995"
```

This applies especially to per-day averages multiplied back to a 30-day window:
`(sum.classB / days) * 30` will drift. Round at display time.

---

## Non-Obvious API Behaviors (Gotcha List)

**`b2_list_buckets` returns no usage data.**
Storage bytes and object counts are not in the response. Do not try to display them from
this endpoint — they aren't there. Use CSV reports or file iteration.

**`b2_list_file_names` and `b2_list_file_versions` reject `accountId` in the body.**
The v4 spec marks it as an unknown field for these endpoints. Omit it from the request body.
Other endpoints like `b2_list_buckets` and `b2_create_key` require it.

**`b2_list_file_names` returns only the current (most recent, non-hidden) version.**
Use `b2_list_file_versions` to see all versions including hide markers.

**B2 buckets are always versioned.** There is no versioning toggle to check or set.
Every upload creates a new version; hiding a file creates a hide marker.

**Object Lock mode is set per-object after upload, not per-bucket.**
`isObjectLockEnabled` on the bucket just enables the feature; retention mode and date are
applied via `b2_update_file_retention` on individual files.

**`b2_list_keys` v4 returns `bucketIds` (array), not `bucketId` (singular).**
Legacy/example responses may still contain `bucketId`. Normalize defensively:
`Array.isArray(k.bucketIds) ? k.bucketIds : k.bucketId ? [k.bucketId] : []`.

**`b2_authorize_account` v4 nests URLs under `apiInfo.storageApi`.**
Reading `response.apiUrl` directly gives `undefined`. Read
`response.apiInfo.storageApi.apiUrl`.

**Partner API is v3; storage API is v4.**
The version prefix matters in the URL path. Using v4 on a Partner endpoint or v3 on a
storage endpoint will fail with 404 or unexpected errors.

**`maxGroupCount` in `b2_list_groups` is hard-capped at 100.**
Sending `maxGroupCount: 200` is rejected. Paginate if needed (use `nextGroupId`).

**The reports bucket is a system bucket typed `"restricted"` or `"snapshot"` depending on context.**
Always use `bucketTypes: ["all"]` (or omit `bucketTypes`) to ensure it appears in
`b2_list_buckets`. It will not appear if you request only `["allPublic", "allPrivate"]`.

**Date math: always use UTC.**
`new Date("2026-05-09")` (date-only ISO string) is UTC midnight per the ECMAScript spec.
`Date.now()` is always UTC milliseconds. Use `.toISOString().slice(0, 10)` for YYYY-MM-DD
strings to compare against CSV date fields. Never use `.toLocaleDateString()` for date
keys — it varies by server locale.

**`toLocaleDateString()` renders date-only strings one day behind in western timezones.**
`new Date("2026-05-09")` = UTC midnight. Calling `.toLocaleDateString()` in e.g. US Pacific
(UTC-7) renders that as May 8, not May 9 — the entire chart shifts back one day. Always
pass `timeZone: 'UTC'` when displaying B2 report dates:
```js
dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
```

**Server-side cache must be keyed by `accountId`.**
If multiple browser sessions use different B2 accounts, a single shared cache keyed by
something other than `accountId` will return one account's data to another account's session.

---

## Recommended Architecture for a B2 Dashboard

```
Browser SPA
  ↓ all B2 calls → /api/* (Express or nginx proxy — do not call B2 directly from browser)

Express server
  ├── /b2-proxy → nginx → api.backblazeb2.com (generic API proxy)
  ├── /api/master-b2/reports-csv
  │     receives { authorizationToken, apiUrl, downloadUrl, accountId, days }
  │     lists b2-reports-{accountId} bucket server-side
  │     downloads CSVs, parses, normalizes dates, aggregates by date
  │     merges local archive (for history beyond 7-day B2 retention)
  │     caches result 20 min keyed by accountId
  │     returns JSON rows to browser
  ├── /api/master-b2/object-counts
  │     instant SELECT * FROM object_counts — no B2 call
  │     returns [{ bucketId, accountId, bucketName, objectCount, countedAt }]
  ├── /api/master-b2/file-index/:bucketId
  │     instant SELECT from file_index — no B2 call
  │     supports prefix, limit, offset, sortBy (name/size/uploadedAt), sortDir
  │     returns { files, total, indexedAt, isComplete }
  ├── /api/customer-b2/:accountId/*
  │     looks up sub-account credentials from encrypted local DB
  │     calls B2 Native API as that sub-account
  └── /api/b2-partner/:endpoint
        forwards Partner API v3 calls (browser passes its token in header)

Background job (objectCountJob.js) — runs via setInterval in PM2 process
  fires 15s after server start, then every 24 hours
  listCredentials() → for each sub-account (3 at a time, parallel):
    b2_authorize_account → b2_list_buckets → paginate b2_list_file_names
    each page (1000 files): bulk-upsert into file_index (single transaction)
    after full walk: prune stale file_index rows; upsert object_counts
  INDEX_FILES = true/false const at top of file to toggle metadata indexing
  no cron job needed — setInterval inside PM2 is reliable enough for 24h cadence
  if PM2 restarts, job re-runs 15s after boot (better behavior than waiting 24h)

Live request path (masterB2.js)
  lists b2-reports bucket → compares against local archive
  downloads ONLY files not already on disk → saves them to archive
  reads all rows from archive (single source of truth)
  20-min in-memory cache on top to avoid redundant disk reads

Optional nightly cron (archive-reports.mjs)
  uses B2_MASTER_KEY_ID + B2_MASTER_APP_KEY from .env
  same logic: download only new files, skip already-archived ones
  useful for pre-warming the archive before peak traffic hours
```

Sub-account credentials (applicationKey) should be stored encrypted at rest
(AES-256-GCM). The raw key should never be returned in any HTTP response body.
