// =============================================================================
// /api/mcp — scoped MCP tool console for any authenticated session.
// Scope is resolved server-side from the session (partner staff = full;
// customer users = their own account; absent token = 403 fail-closed).
// =============================================================================

import express from 'express';
import { requireAuth, requireCsrf } from '../middleware/requireAuth.js';
import { getConfigPublic, hasAccountToken } from '../mcpStore.js';
import { listTools, callTool, McpError } from '../mcp/client.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

function sendMcpError(res, err) {
  const status = err instanceof McpError ? err.status : 502;
  return res.status(status).json({ error: err.message || 'MCP request failed' });
}

// Whether MCP is usable for the current session (for UI enable/empty states).
router.get('/status', (req, res) => {
  const cfg = getConfigPublic();
  const accountId = req.session.user.accountId || null;
  const hasScope = accountId == null ? cfg.hasToken : hasAccountToken(accountId);
  res.json({ configured: cfg.enabled && cfg.hasToken, hasScope, baseUrlSet: !!cfg.baseUrl });
});

router.get('/tools', async (req, res) => {
  try {
    const out = await listTools(req.session);
    res.json(out);
  } catch (err) {
    sendMcpError(res, err);
  }
});

router.post('/tools/call', requireCsrf, async (req, res) => {
  const { name, arguments: args } = req.body || {};
  try {
    const out = await callTool(req.session, name, args);
    audit({
      actorId: req.session.user.id,
      action: 'mcp.tool_called',
      details: { tool: name, scope: out.scope },
      ip: req.ip,
    });
    res.json(out);
  } catch (err) {
    sendMcpError(res, err);
  }
});

export default router;
