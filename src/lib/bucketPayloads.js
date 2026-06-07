// Pure payload builders + validators shared by the bucket / file / key dialogs.
// Deliberately free of React and DOM so they can be unit-tested directly — this
// is where a silent data-correctness or security regression would otherwise
// hide (per the audit). The dialogs are thin wrappers that collect form state
// and hand it to these.

// B2 rule names (CORS rules, notification rules) must be 6–63 chars of
// [A-Za-z0-9-]. Zero-pad so an auto-generated name is never < 6 chars.
export function genRuleName(prefix = 'rule') {
  return `${prefix}-${Math.floor(Math.random() * 1e6).toString().padStart(6, '0')}`;
}

// Valid B2 CORS allowedOperations (S3-compatible + native).
export const CORS_OPS = [
  's3_get', 's3_head', 's3_put', 's3_post', 's3_delete',
  'b2_download_file_by_name', 'b2_download_file_by_id', 'b2_upload_file', 'b2_upload_part',
];

// Lifecycle rules. Throws if a rule has neither hide nor delete days (B2 400s).
export function buildLifecycleRules(rules) {
  for (const r of rules) {
    if (r.daysFromUploadingToHiding === '' && r.daysFromHidingToDeleting === '') {
      throw new Error('Each lifecycle rule needs a hide and/or delete day count.');
    }
  }
  return rules.map((r) => ({
    fileNamePrefix: r.fileNamePrefix,
    daysFromUploadingToHiding: r.daysFromUploadingToHiding === '' ? null : Number(r.daysFromUploadingToHiding),
    daysFromHidingToDeleting: r.daysFromHidingToDeleting === '' ? null : Number(r.daysFromHidingToDeleting),
  }));
}

// CORS rules. Input entries: { corsRuleName, allowedOrigins (comma string),
// allowedOperations (Set|array), maxAgeSeconds }. Throws on an invalid rule.
export function buildCorsRules(corsRules) {
  return corsRules.map((c) => {
    const origins = String(c.allowedOrigins || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ops = c.allowedOperations instanceof Set ? [...c.allowedOperations] : (c.allowedOperations || []);
    if (!origins.length) throw new Error('Each CORS rule needs at least one origin.');
    if (!ops.length) throw new Error('Each CORS rule needs at least one operation.');
    const name = (c.corsRuleName || '').trim();
    if (name && !/^[A-Za-z0-9-]{6,63}$/.test(name)) {
      throw new Error('CORS rule names must be 6–63 chars of letters, digits, or dashes.');
    }
    return {
      corsRuleName: name || genRuleName(),
      allowedOrigins: origins,
      allowedOperations: ops,
      allowedHeaders: ['*'],
      maxAgeSeconds: Number(c.maxAgeSeconds) || 0,
    };
  });
}

export function buildBucketInfo(info) {
  return Object.fromEntries(info.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
}

// Assemble the b2.updateBucket payload. defaultServerSideEncryption and
// defaultRetention are ONLY included when actually changed — avoids clobbering
// an SSE-C bucket's default and avoids a needless disable call. Retention is
// cleared with { mode: null }. Throws (with a user-facing message) on invalid
// lifecycle/CORS input.
export function buildBucketUpdate({
  accountId, bucketId, bucketType,
  encryption, initialEncryption,
  rules = [], corsRules = [], info = [],
  lockEnabled = false, retMode = 'none', retDuration = '', retUnit = 'days',
  initialRet = { mode: 'none', duration: '', unit: 'days' },
}) {
  const payload = {
    accountId, bucketId, bucketType,
    lifecycleRules: buildLifecycleRules(rules),
    corsRules: buildCorsRules(corsRules),
    bucketInfo: buildBucketInfo(info),
  };
  if (encryption !== initialEncryption) payload.encryption = encryption;
  const retChanged = retMode !== initialRet.mode
    || String(retDuration) !== String(initialRet.duration)
    || retUnit !== initialRet.unit;
  if (lockEnabled && retChanged) {
    payload.defaultRetention = retMode === 'none'
      ? { mode: null }
      : { mode: retMode, period: { duration: Number(retDuration) || 1, unit: retUnit } };
  }
  return payload;
}

// File Object-Lock protection: the set of writes to perform, only for what
// actually changed (legal hold and retention are separate B2 calls; re-writing
// an unchanged compliance lock would error). retain-until is end-of-day UTC so
// the lock covers the whole chosen date. Throws if a retention mode lacks a date.
export function fileProtectionPlan({
  legalHold, initialLegalHold,
  retMode, initialRetMode, retUntil, initialRetUntil, bypass,
}) {
  const plan = {};
  if (legalHold !== initialLegalHold) plan.legalHold = legalHold ? 'on' : 'off';
  if (retMode !== initialRetMode || retUntil !== initialRetUntil) {
    const retention = { mode: retMode, bypassGovernance: !!bypass };
    if (retMode !== 'none') {
      if (!retUntil) throw new Error('Choose a "retain until" date.');
      retention.retainUntilTimestamp = Date.parse(retUntil + 'T23:59:59Z');
    }
    plan.retention = retention;
  }
  return plan;
}

// Rotate orchestration: create the replacement, THEN revoke the old key. If the
// revoke fails the new key (and its one-time secret) is still returned, with a
// loud warning, so the operator never loses the secret or believes a still-live
// key was revoked. createKey/deleteKey are injected (the adapter fns).
export async function performRotate({ createKey, deleteKey, apiKey, validDurationInSeconds }) {
  const replacement = await createKey({
    keyName: apiKey.keyName,
    capabilities: apiKey.capabilities,
    bucketIds: apiKey.bucketIds || [],
    namePrefix: apiKey.namePrefix || undefined,
    validDurationInSeconds,
  });
  let revokeWarning = null;
  try {
    await deleteKey({ applicationKeyId: apiKey.applicationKeyId });
  } catch (err) {
    revokeWarning = `The new key was created, but the OLD key (${apiKey.applicationKeyId}) could NOT be revoked: ${String(err.message || err)}. Revoke it manually.`;
  }
  return { replacement, revokeWarning };
}

// b2_create_key request body (v4: bucketIds ARRAY, no singular bucketId).
export function buildCreateKeyBody(payload) {
  const body = { keyName: payload.keyName, capabilities: payload.capabilities };
  if (payload.bucketIds?.length) body.bucketIds = payload.bucketIds;
  if (payload.namePrefix) body.namePrefix = payload.namePrefix;
  if (payload.validDurationInSeconds) body.validDurationInSeconds = payload.validDurationInSeconds;
  return body;
}
