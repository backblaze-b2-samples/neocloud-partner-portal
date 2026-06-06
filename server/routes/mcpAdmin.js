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

router.put('/config', (req, res) => {
  const { baseUrl, enabled, token } = req.body || {};
  if (baseUrl != null && typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'baseUrl must be a string' });
  }
  if (baseUrl) {
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl is not a valid URL' }); }
  }
  // token: undefined => keep existing; '' => keep existing (use DELETE semantics elsewhere if needed)
  const saved = setConfig({
    baseUrl: baseUrl ?? getConfigPublic().baseUrl,
    enabled: !!enabled,
    token: typeof token === 'string' && token.length > 0 ? token : undefined,
  });
  audit({ actorId: req.session.user.id, action: 'mcp.config_updated', details: { baseUrl: saved.baseUrl, enabled: saved.enabled, tokenSet: !!token }, ip: req.ip });
  res.json({ config: saved });
});

// Test using either the posted creds, or the stored token when omitted.
router.post('/test', async (req, res) => {
  const { baseUrl, token } = req.body || {};
  const cfg = getConfigPublic();
  const useUrl = baseUrl || cfg.baseUrl;
  const useToken = (typeof token === 'string' && token.length > 0) ? token : getDecryptedConfigToken();
  try {
    const out = await testConnection({ baseUrl: useUrl, token: useToken });
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
  const { label, token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }
  const saved = upsertAccountToken({ accountId, label, token });
  audit({ actorId: req.session.user.id, action: 'mcp.account_token_set', details: { accountId, label: saved.label }, ip: req.ip });
  res.json({ token: saved });
});

router.delete('/account-tokens/:accountId', (req, res) => {
  const ok = deleteAccountToken(req.params.accountId);
  if (ok) audit({ actorId: req.session.user.id, action: 'mcp.account_token_deleted', details: { accountId: req.params.accountId }, ip: req.ip });
  res.json({ deleted: ok });
});

export default router;
