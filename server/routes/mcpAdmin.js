// =============================================================================
// /api/admin/mcp — admin config for the MCP connection + per-customer scoped
// tokens. Admin-only, CSRF-guarded, audited. Tokens are write-only from the UI
// (never returned in plaintext); presence is reported as `hasToken`.
// =============================================================================

import express from 'express';
import { requireAuth, requireRole, requireCsrf, requireNotDemo } from '../middleware/requireAuth.js';
import {
  getConfigPublic, setConfig, getDecryptedConfigToken,
  listAccountTokens, upsertAccountToken, deleteAccountToken,
} from '../mcpStore.js';
import { testConnection, McpError } from '../mcp/client.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth, requireRole('admin'), requireNotDemo, requireCsrf);

// --- connection config -------------------------------------------------------

router.get('/config', (_req, res) => {
  res.json({ config: getConfigPublic() });
});

const TRANSPORTS = new Set(['http', 'sse']);
const AUTH_MODES = new Set(['bearer', 'headers']);

// Validate a custom-headers object: { [name]: value } of non-empty strings.
// Header names must be RFC-7230 tokens; values must not contain CR/LF (defense
// in depth — undici also rejects these at fetch time).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function cleanHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const out = {};
  for (const [rawK, v] of Object.entries(headers)) {
    const k = typeof rawK === 'string' ? rawK.trim() : '';
    if (!HEADER_NAME_RE.test(k)) continue;
    if (typeof v !== 'string' || v.length === 0 || /[\r\n]/.test(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

router.put('/config', (req, res) => {
  const { baseUrl, enabled, token, transport, authMode, headers } = req.body || {};
  if (baseUrl != null && typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'baseUrl must be a string' });
  }
  if (baseUrl) {
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl is not a valid URL' }); }
  }
  if (transport != null && !TRANSPORTS.has(transport)) {
    return res.status(400).json({ error: "transport must be 'http' or 'sse'" });
  }
  if (authMode != null && !AUTH_MODES.has(authMode)) {
    return res.status(400).json({ error: "authMode must be 'bearer' or 'headers'" });
  }
  const cleanedHeaders = cleanHeaders(headers);
  // Switching auth mode without supplying a matching credential would leave a
  // stale, mismatched blob (now fails closed at use time). Force re-entry so the
  // admin doesn't silently break the connection.
  const current = getConfigPublic();
  const hasNewCredential = (typeof token === 'string' && token.length > 0) || !!cleanedHeaders;
  if (authMode && authMode !== current.authMode && current.hasToken && !hasNewCredential) {
    return res.status(400).json({ error: `Re-enter the credential when switching auth mode to '${authMode}'.` });
  }
  const saved = setConfig({
    baseUrl: baseUrl ?? current.baseUrl,
    enabled: !!enabled,
    transport, authMode,
    token: typeof token === 'string' && token.length > 0 ? token : undefined,
    headers: cleanedHeaders || undefined,
  });
  audit({ actorId: req.session.user.id, action: 'mcp.config_updated', details: { baseUrl: saved.baseUrl, enabled: saved.enabled, transport: saved.transport, authMode: saved.authMode, credentialSet: !!token || !!cleanedHeaders }, ip: req.ip });
  res.json({ config: saved });
});

// Test using the posted creds, or the stored credential when omitted.
router.post('/test', async (req, res) => {
  const { baseUrl, token, transport, authMode, headers } = req.body || {};
  const cfg = getConfigPublic();
  const useUrl = baseUrl || cfg.baseUrl;
  const useTransport = transport || cfg.transport;
  const useAuthMode = authMode || cfg.authMode;
  const cleanedHeaders = cleanHeaders(headers);
  let useToken = (typeof token === 'string' && token.length > 0) ? token : undefined;
  let useHeaders = cleanedHeaders || undefined;
  // Fall back to the stored credential when nothing was posted. Guard the
  // bearer branch: never send a stale headers-JSON blob as a Bearer token.
  if (!useToken && !useHeaders) {
    const raw = getDecryptedConfigToken();
    if (useAuthMode === 'headers') { try { useHeaders = raw ? JSON.parse(raw) : {}; } catch { useHeaders = {}; } }
    else { useToken = (raw && !raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('[')) ? raw : undefined; }
  }
  try {
    const out = await testConnection({ baseUrl: useUrl, transport: useTransport, authMode: useAuthMode, token: useToken, headers: useHeaders });
    res.json(out);
  } catch (err) {
    const status = err instanceof McpError ? err.status : 502;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// --- per-customer scoped tokens ---------------------------------------------

router.get('/account-tokens', (_req, res) => {
  res.json({ tokens: listAccountTokens() });
});

router.put('/account-tokens/:accountId', (req, res) => {
  const { accountId } = req.params;
  const { label, token, headers } = req.body || {};
  const cleanedHeaders = cleanHeaders(headers);
  if ((!token || typeof token !== 'string') && !cleanedHeaders) {
    return res.status(400).json({ error: 'token or headers is required' });
  }
  const saved = upsertAccountToken({ accountId, label, token, headers: cleanedHeaders || undefined });
  audit({ actorId: req.session.user.id, action: 'mcp.account_token_set', details: { accountId, label: saved.label, kind: cleanedHeaders ? 'headers' : 'token' }, ip: req.ip });
  res.json({ token: saved });
});

router.delete('/account-tokens/:accountId', (req, res) => {
  const ok = deleteAccountToken(req.params.accountId);
  if (ok) audit({ actorId: req.session.user.id, action: 'mcp.account_token_deleted', details: { accountId: req.params.accountId }, ip: req.ip });
  res.json({ deleted: ok });
});

export default router;
