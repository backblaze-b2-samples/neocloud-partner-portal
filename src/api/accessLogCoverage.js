// Access log coverage derivation helpers.
//
// Per-key activity attribution requires Bucket Access Logs to be enabled on
// every bucket in the key's scope. This module derives coverage states and
// produces availability labels that clearly distinguish "no telemetry" from
// "no usage" — two very different things.
//
// Rule: do NOT show "0 requests" or "never used" unless access logs were
// actually enabled and ingested for the key's relevant buckets and time
// window. Show the appropriate coverage state instead.

// ── Bucket-level access log statuses ─────────────────────────────────────────

export const BUCKET_LOG_STATUS = {
  enabled:            'enabled',
  waiting:            'waiting',            // just configured, first logs expected < 2h
  delayed:            'delayed',            // configured > 2h, no logs seen yet
  failed:             'failed',             // was delivering, now stale > 24h
  disabled:           'disabled',
  permission_missing: 'permission_missing',
  not_configured:     'not_configured',
};

export function coverageStatusTitle(status) {
  return {
    enabled:            'Enabled — receiving logs',
    waiting:            'Waiting — just enabled, first logs expected within 2 h',
    delayed:            'Delivery delayed — configured but no logs seen (> 2 h)',
    failed:             'Logs stale — no new log objects in > 24 h',
    disabled:           'Disabled',
    permission_missing: 'Permission missing',
    not_configured:     'Not configured',
    full:               'Full coverage',
    partial:            'Partial coverage',
    none:               'No coverage',
    account_wide:       'Account-wide key',
  }[status] || status;
}

// ── Key-level coverage derivation ────────────────────────────────────────────

/**
 * Derive key-level access-log coverage from the key shape and a pre-built
 * map of bucket logging status objects.
 *
 * @param {object} key             - { applicationKeyId, bucketIds: string[] }
 * @param {Map}    bucketStatusMap - Map<bucketId, accessLogging>
 * @returns {{ isAccountWide, overallStatus, buckets, coveredCount, totalCount }}
 */
export function deriveKeyCoverage(key, bucketStatusMap) {
  if (key.bucketIds.length === 0) {
    return { isAccountWide: true, overallStatus: 'account_wide', buckets: [], coveredCount: 0, totalCount: 0 };
  }

  const buckets = key.bucketIds.map((id) => {
    const info = bucketStatusMap.get(id);
    return { bucketId: id, ...(info || { status: 'not_configured' }) };
  });

  const covered = buckets.filter((b) => b.status === 'enabled').length;
  const total   = buckets.length;

  let overallStatus;
  if (covered === total) {
    overallStatus = 'full';
  } else if (covered > 0) {
    overallStatus = 'partial';
  } else {
    if      (buckets.some((b) => b.status === 'failed'))             overallStatus = 'failed';
    else if (buckets.some((b) => b.status === 'delayed'))            overallStatus = 'delayed';
    else if (buckets.some((b) => b.status === 'waiting'))            overallStatus = 'waiting';
    else if (buckets.some((b) => b.status === 'permission_missing')) overallStatus = 'permission_missing';
    else                                                             overallStatus = 'none';
  }

  return { isAccountWide: false, overallStatus, buckets, coveredCount: covered, totalCount: total };
}

// ── Availability mapping ──────────────────────────────────────────────────────

/**
 * Map coverage → structured availability descriptor.
 *
 * Returns:
 *   availability : 'available' | 'partial' | 'unavailable' | 'na'
 *   reason       : machine-readable code
 *   label        : short user-facing label
 *   detail       : longer explanation for tooltips / coverage panels
 */
export function coverageToAvailability(coverage) {
  const { isAccountWide, overallStatus, coveredCount, totalCount } = coverage;

  if (isAccountWide) {
    return {
      availability: 'na',
      reason: 'account_wide_key',
      label: 'N/A — account-wide key',
      detail: 'Account-wide keys are not scoped to any bucket. Access logs are per-bucket, so attributing activity to this key would require filtering every bucket\'s logs by applicationKeyId.',
    };
  }

  switch (overallStatus) {
    case 'full':
      return {
        availability: 'available',
        reason: 'access_logs_enabled',
        label: 'Activity derived from Bucket Access Logs.',
        detail: `All ${totalCount} bucket(s) in this key's scope have access logging enabled.`,
      };
    case 'partial':
      return {
        availability: 'partial',
        reason: 'partial_bucket_coverage',
        label: `Partial activity only — access logs are enabled for ${coveredCount} of ${totalCount} buckets.`,
        detail: `${coveredCount} of ${totalCount} buckets have logging enabled. Calls to unlogged buckets are not counted in activity totals.`,
      };
    case 'waiting':
      return {
        availability: 'unavailable',
        reason: 'access_logs_waiting',
        label: 'Waiting for logs — logging was just enabled.',
        detail: 'Access logging was just configured. Log objects are expected within 1–2 hours. No activity data is available yet.',
      };
    case 'delayed':
      return {
        availability: 'unavailable',
        reason: 'access_logs_delayed',
        label: 'Delivery delayed — no log objects received yet.',
        detail: 'Access logging is configured but no log objects have been delivered. Verify that the destination bucket exists and that the source bucket has permission to write to it.',
      };
    case 'failed':
      return {
        availability: 'unavailable',
        reason: 'access_logs_failed',
        label: 'Logs stale — delivery has stopped.',
        detail: 'Access logs were previously delivering but no new log objects have arrived in > 24 h. Check destination bucket ACL and service-account permissions.',
      };
    case 'permission_missing':
      return {
        availability: 'unavailable',
        reason: 'permission_missing',
        label: 'Permission error — cannot read logging configuration.',
        detail: 'The portal key lacks readBucketInfo on this customer account. Access log status cannot be determined.',
      };
    default:
      return {
        availability: 'unavailable',
        reason: 'access_logs_disabled',
        label: 'Key activity unavailable — bucket access logs are not enabled.',
        detail: 'Access logging is not enabled on this key\'s bucket(s). Per-key activity attribution requires Bucket Access Logs to be enabled per bucket.',
      };
  }
}

// ── Activity label (factors in whether any events were found) ─────────────────

/**
 * Extends coverageToAvailability to distinguish between:
 *   - logs enabled + activity found      → "Activity derived from Bucket Access Logs."
 *   - logs enabled + NO activity found   → "No activity observed since logging was enabled."
 *   - everything else                    → from coverageToAvailability
 *
 * @param {object}      coverage    - result of deriveKeyCoverage
 * @param {number|null} lastUsedTs  - ms epoch of last seen activity, or null
 */
export function getKeyActivityLabel(coverage, lastUsedTs = null) {
  const base = coverageToAvailability(coverage);

  if (base.availability === 'available' && !lastUsedTs) {
    return {
      ...base,
      reason: 'no_activity_observed',
      label: 'No activity observed since logging was enabled.',
      detail: 'Access logs are enabled and ingested for all scoped buckets, but no requests attributed to this key have been found in the retained log window. The key may not have been used, or activity predates the logging window.',
    };
  }

  return base;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

/**
 * Returns a specific badge per overallStatus — use in tables where you need
 * more detail than the 4-way availability split.
 *
 * @returns {{ text: string, tone: 'green'|'amber'|'red'|'muted' }}
 */
export function coverageStatusBadge(overallStatus) {
  return {
    full:               { text: 'Full coverage',    tone: 'green' },
    partial:            { text: 'Partial coverage', tone: 'amber' },
    waiting:            { text: 'Waiting for logs', tone: 'amber' },
    delayed:            { text: 'Delivery delayed', tone: 'amber' },
    failed:             { text: 'Logs stale',       tone: 'red'   },
    permission_missing: { text: 'Permission error', tone: 'red'   },
    none:               { text: 'Logging disabled', tone: 'red'   },
    account_wide:       { text: 'Account-wide',     tone: 'muted' },
  }[overallStatus] || { text: 'No coverage', tone: 'red' };
}

/**
 * Coarser 4-way badge — use when you only have availability, not overallStatus.
 * Prefer coverageStatusBadge when overallStatus is available.
 */
export function coverageBadge(availability) {
  return {
    available:   { text: 'Logs enabled',    tone: 'green' },
    partial:     { text: 'Partial logs',    tone: 'amber' },
    unavailable: { text: 'No logs',         tone: 'red'   },
    na:          { text: 'N/A',             tone: 'muted' },
  }[availability] || { text: 'No logs', tone: 'red' };
}
