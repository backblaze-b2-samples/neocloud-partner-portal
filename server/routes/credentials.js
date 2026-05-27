// =============================================================================
// /api/admin/credentials — admin-only B2 sub-account credential management.
//
// All routes require role === 'admin' and a valid CSRF token.
//
// Endpoints:
//   GET    /                      List all accounts (public fields only — no keys)
//   GET    /?groupId=xxx          Filter by group
//   POST   /                      Store or update credentials for one account
//   GET    /:accountId            Get public fields for one account
//   GET    /:accountId/key        Retrieve decrypted applicationKey (admin only)
//   DELETE /:accountId            Remove credentials for one account
// =============================================================================

import express from 'express';
import { requireAuth, requireRole, requireCsrf } from '../middleware/requireAuth.js';
import { credentialKeyLimiter } from '../rateLimit.js';
import { audit } from '../audit.js';
import {
  upsertCredential,
  getCredential,
  listCredentials,
  getDecryptedApplicationKey,
  deleteCredential,
} from '../credentials.js';

const router = express.Router();

// All routes in this file are admin-only and require CSRF.
router.use(requireAuth, requireRole('admin'), requireCsrf);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_REGIONS = new Set(['us-west', 'us-east', 'eu-central', 'ca-east']);

function validateCredentialBody(body) {
  const { accountId, email, groupId, region, applicationKeyId, applicationKey } = body ?? {};
  if (!accountId || typeof accountId !== 'string')        return 'accountId is required';
  if (!email    || typeof email    !== 'string')          return 'email is required';
  if (!groupId  || typeof groupId  !== 'string')          return 'groupId is required';
  if (!region   || !VALID_REGIONS.has(region))            return `region must be one of: ${[...VALID_REGIONS].join(', ')}`;
  if (!applicationKeyId || typeof applicationKeyId !== 'string') return 'applicationKeyId is required';
  if (!applicationKey   || typeof applicationKey   !== 'string') return 'applicationKey is required';
  return null;
}

// ---------------------------------------------------------------------------
// GET / — list all accounts (no keys)
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { groupId } = req.query;
  const rows = listCredentials(groupId ? { groupId } : undefined);
  res.json({ credentials: rows });
});

// ---------------------------------------------------------------------------
// POST / — store or update credentials for one account
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const validationError = validateCredentialBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { accountId, email, groupId, region, applicationKeyId, applicationKey } = req.body;

  let saved;
  try {
    saved = upsertCredential({ accountId, email, groupId, region, applicationKeyId, applicationKey });
  } catch (err) {
    // Most likely cause: CREDENTIAL_ENCRYPTION_KEY not configured.
    console.error('[credentials] upsert failed:', err.message);
    return res.status(500).json({ error: 'Credential encryption is not configured on this server.' });
  }

  audit({
    actorId: req.session.user.id,
    action: 'credential.upserted',
    details: { accountId, email, groupId, region, applicationKeyId },
    ip: req.ip,
  });

  res.status(201).json({ credential: saved });
});

// ---------------------------------------------------------------------------
// GET /:accountId — public fields for one account
// ---------------------------------------------------------------------------
router.get('/:accountId', (req, res) => {
  const row = getCredential(req.params.accountId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ credential: row });
});

// ---------------------------------------------------------------------------
// GET /:accountId/key — retrieve decrypted applicationKey (admin only)
//
// The key is returned ONLY over an authenticated admin session. It is the
// caller's responsibility not to log or forward the value carelessly.
// ---------------------------------------------------------------------------
router.get('/:accountId/key', (req, res) => {
  const limit = credentialKeyLimiter(req);
  if (!limit.ok) {
    res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many key reveals — try again shortly.' });
  }

  const row = getCredential(req.params.accountId);
  if (!row) return res.status(404).json({ error: 'Not found' });

  let applicationKey;
  try {
    applicationKey = getDecryptedApplicationKey(req.params.accountId);
  } catch (err) {
    console.error('[credentials] decrypt failed for', req.params.accountId);
    return res.status(500).json({ error: 'Decryption failed — CREDENTIAL_ENCRYPTION_KEY may have changed.' });
  }

  audit({
    actorId: req.session.user.id,
    action: 'credential.key_accessed',
    details: { accountId: req.params.accountId },
    ip: req.ip,
  });

  // Return just the key alongside the non-secret fields so the caller has full context.
  res.json({
    accountId: row.account_id,
    applicationKeyId: row.application_key_id,
    applicationKey,   // decrypted — treat as a secret
  });
});

// ---------------------------------------------------------------------------
// DELETE /:accountId — remove credentials
// ---------------------------------------------------------------------------
router.delete('/:accountId', (req, res) => {
  const existing = getCredential(req.params.accountId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  deleteCredential(req.params.accountId);

  audit({
    actorId: req.session.user.id,
    action: 'credential.deleted',
    details: { accountId: req.params.accountId, email: existing.email },
    ip: req.ip,
  });

  res.json({ deleted: true });
});

export default router;
