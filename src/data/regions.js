// Backblaze B2 regions (current as of 2026).
// Reference: https://www.backblaze.com/docs/cloud-storage-data-regions
// NOTE: Region is set at account creation and cannot be changed via API.
// Multi-region presence requires separate B2 accounts.

export const REGIONS = [
  {
    id: 'us-east-005',
    code: 'US East',
    city: 'Reston, VA',
    country: 'United States',
    flag: '🇺🇸',
    s3Endpoint: 's3.us-east-005.backblazeb2.com',
    apiHost: 'api005.backblazeb2.com',
    downloadHost: 'f005.backblazeb2.com',
    color: '#3DD9D6',
  },
  {
    id: 'us-west-002',
    code: 'US West',
    city: 'Sacramento + Phoenix',
    country: 'United States',
    flag: '🇺🇸',
    s3Endpoint: 's3.us-west-002.backblazeb2.com',
    apiHost: 'api004.backblazeb2.com',
    downloadHost: 'f004.backblazeb2.com',
    color: '#9B7CFF',
  },
  {
    id: 'eu-central-003',
    code: 'EU Central',
    city: 'Amsterdam',
    country: 'Netherlands',
    flag: '🇳🇱',
    s3Endpoint: 's3.eu-central-003.backblazeb2.com',
    apiHost: 'api003.backblazeb2.com',
    downloadHost: 'f003.backblazeb2.com',
    color: '#F5B73E',
  },
  {
    id: 'ca-east-006',
    code: 'CA East',
    city: 'Toronto',
    country: 'Canada',
    flag: '🇨🇦',
    s3Endpoint: 's3.ca-east-006.backblazeb2.com',
    apiHost: 'api006.backblazeb2.com',
    downloadHost: 'f006.backblazeb2.com',
    color: '#2BD68A',
  },
];

// Helper for the API console: rewrite a URL/body so the api###, f### and
// s3 endpoint hosts match the selected region. Leaves the auth bootstrap
// (api.backblazeb2.com) and Partner API cluster (api123) untouched, since
// those are intentionally region-agnostic.
const REGION_PATTERNS = [
  /api00[2-9]\.backblazeb2\.com/g,
  /f00[2-9]\.backblazeb2\.com/g,
  /s3\.[a-z]+-[a-z]+-00[2-9]\.backblazeb2\.com/g,
];

export function rewriteRegionInString(s, region) {
  if (!s || !region) return s;
  return s
    .replace(REGION_PATTERNS[0], region.apiHost)
    .replace(REGION_PATTERNS[1], region.downloadHost)
    .replace(REGION_PATTERNS[2], region.s3Endpoint);
}

export function rewriteRegionInExample(example, region) {
  if (!region) return example;
  const out = { ...example, request: { ...example.request }, response: { ...example.response } };
  out.request.url = rewriteRegionInString(out.request.url, region);
  if (typeof out.response.body === 'string') {
    out.response.body = rewriteRegionInString(out.response.body, region);
  } else if (out.response.body && typeof out.response.body === 'object') {
    // Walk the body and rewrite any string values that contain region hosts
    const walk = (v) => {
      if (typeof v === 'string') return rewriteRegionInString(v, region);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k in v) o[k] = walk(v[k]);
        return o;
      }
      return v;
    };
    out.response.body = walk(out.response.body);
  }
  return out;
}
