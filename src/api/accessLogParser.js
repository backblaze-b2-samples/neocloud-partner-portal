// =============================================================================
// Backblaze Bucket Access Log parser
// =============================================================================
// Backblaze Bucket Access Logs follow the AWS S3 server access log format,
// with the exception of the Access Point ARN and aclRequired fields, which
// are always empty (B2 does not support those concepts).
//
// Logs are space-delimited records with three token shapes:
//   - bracketed:  [17/Apr/2025:22:47:56 +0000]
//   - quoted:     "GET /test.html?versionId=... HTTP/1.1"
//   - bare:       SigV4
//
// Reference: https://www.backblaze.com/docs/cloud-storage-bucket-access-logs
// =============================================================================

// Field order — exactly as documented at the URL above.
export const ACCESS_LOG_FIELDS = [
  'bucketOwner',
  'bucket',
  'time',
  'remoteIp',
  'identity',
  'requestId',
  'operation',
  'key',
  'requestUri',
  'httpStatus',
  'errorCode',
  'bytesSent',
  'objectSize',
  'totalTimeMs',
  'turnAroundTimeMs',
  'referer',
  'userAgent',
  'versionId',
  'hostId',
  'signatureVersion',
  'cipherSuite',
  'authType',
  'hostHeader',
  'tlsVersion',
  'accessPointArn',  // always empty on B2
  'aclRequired',     // always empty on B2
];

// Tokenizer — captures one of: bracketed group, quoted group, or bare token.
const TOKEN_RE = /\[[^\]]*\]|"(?:[^"\\]|\\.)*"|\S+/g;

const NUMERIC_FIELDS = new Set([
  'httpStatus', 'bytesSent', 'objectSize', 'totalTimeMs', 'turnAroundTimeMs',
]);

/**
 * Parse one Bucket Access Log line into an object keyed by ACCESS_LOG_FIELDS.
 * Returns null if the line couldn't be tokenized.
 */
export function parseAccessLogLine(line) {
  if (!line || !line.trim()) return null;
  const tokens = line.match(TOKEN_RE);
  if (!tokens) return null;
  const out = {};
  ACCESS_LOG_FIELDS.forEach((field, i) => {
    let val = tokens[i];
    if (val === undefined) {
      out[field] = null;
      return;
    }
    // Strip wrapping brackets and quotes
    if (val.startsWith('[') && val.endsWith(']')) val = val.slice(1, -1);
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
    if (val === '-' || val === '') {
      out[field] = null;
      return;
    }
    if (NUMERIC_FIELDS.has(field)) {
      const n = Number(val);
      out[field] = Number.isFinite(n) ? n : null;
    } else {
      out[field] = val;
    }
  });
  // Convenience: parse the time field into an ISO timestamp.
  out.timestamp = parseB2Time(out.time);
  // Convenience: split the identity into type + id.
  const idParts = parseIdentity(out.identity);
  out.identityType = idParts.type;
  out.identityId = idParts.id;
  return out;
}

/**
 * Parse a multi-line access log file into an array of records.
 */
export function parseAccessLog(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const record = parseAccessLogLine(line);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Convert a B2/S3 access log time like "17/Apr/2025:22:47:56 +0000"
 * into an ISO string. Returns null on failure.
 */
export function parseB2Time(s) {
  if (!s) return null;
  // dd/MMM/yyyy:HH:mm:ss ZZZZ
  const m = s.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const [, dd, mon, yyyy, hh, mm, ss, tz] = m;
  const tzColon = tz.slice(0, 3) + ':' + tz.slice(3);
  return `${yyyy}-${months[mon]}-${dd}T${hh}:${mm}:${ss}${tzColon}`;
}

/**
 * Identity field is shaped like:
 *   identity:applicationKey:1005390fcd33...
 *   identity:account:7f3a91d2c4b8
 *   identity:system
 *   identity:replication:7f3a91d2c4b8
 *   identity:computer:7f3a91d2c4b8:abc-123
 */
export function parseIdentity(raw) {
  if (!raw) return { type: null, id: null };
  if (!raw.startsWith('identity:')) return { type: null, id: raw };
  const parts = raw.slice('identity:'.length).split(':');
  return {
    type: parts[0] || null,
    id: parts.length > 1 ? parts.slice(1).join(':') : null,
  };
}

/**
 * Categorise the operation field into a coarse "verb" so the UI can
 * group records (Read, Write, Delete, Multipart, Lifecycle, Other).
 *
 * Operation strings the docs call out:
 *   REST.HTTP_method.resource_type   (e.g. REST.GET.OBJECT, REST.S3_GET_OBJECT)
 *   B2_API.resource                  (Native API calls)
 *   BATCH.DELETE.OBJECT
 *   B2_LIFECYCLE.action.resource_type
 */
export function classifyOperation(op) {
  if (!op) return 'other';
  if (op.startsWith('B2_LIFECYCLE')) return 'lifecycle';
  if (op.startsWith('BATCH.')) return 'delete';
  const upper = op.toUpperCase();
  if (upper.includes('DELETE')) return 'delete';
  if (upper.includes('PUT') || upper.includes('POST') || upper.includes('UPLOAD') || upper.includes('COPY') || upper.includes('CREATE_PART') || upper.includes('CREATE_MULTIPART')) return 'write';
  if (upper.includes('GET') || upper.includes('HEAD') || upper.includes('LIST') || upper.includes('DOWNLOAD')) return 'read';
  if (upper.includes('MULTIPART')) return 'multipart';
  return 'other';
}

/**
 * Filter parsed records by bucket name (most common drill-down).
 */
export function filterByBucket(records, bucketName) {
  if (!bucketName) return records;
  return records.filter((r) => r.bucket === bucketName);
}

/**
 * Group records by date (YYYY-MM-DD) with class breakdown, useful for
 * charting daily activity from real per-event records.
 */
export function aggregateByDay(records) {
  const map = {};
  for (const r of records) {
    if (!r.timestamp) continue;
    const date = r.timestamp.slice(0, 10);
    if (!map[date]) {
      map[date] = { date, total: 0, read: 0, write: 0, delete: 0, lifecycle: 0, other: 0, errors: 0 };
    }
    const d = map[date];
    d.total += 1;
    d[classifyOperation(r.operation)] = (d[classifyOperation(r.operation)] || 0) + 1;
    if (r.httpStatus && r.httpStatus >= 400) d.errors += 1;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Group records by identity (which key/account did the work).
 */
export function aggregateByIdentity(records) {
  const map = {};
  for (const r of records) {
    const k = r.identity || 'unauthenticated';
    if (!map[k]) {
      map[k] = { identity: k, type: r.identityType, id: r.identityId, count: 0, bytes: 0, errors: 0 };
    }
    map[k].count += 1;
    map[k].bytes += r.bytesSent || 0;
    if (r.httpStatus && r.httpStatus >= 400) map[k].errors += 1;
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}
