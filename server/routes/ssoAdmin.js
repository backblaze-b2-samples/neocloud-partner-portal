// =============================================================================
// /api/admin/sso — admin config for the OIDC connection + group→role mappings.
// =============================================================================
// Mirrors server/routes/mcpAdmin.js: partner scope, CSRF, admin-only in
// practice via settings:read / settings:write. The client secret is write-only
// from the UI — presence is reported as hasClientSecret and it is never echoed.
// =============================================================================

import express from 'express';
import {
  requireAuth, requirePermission, requirePartnerScope, requireCsrf, requireNotDemo,
} from '../middleware/requireAuth.js';
import { SETTINGS_READ, SETTINGS_WRITE } from '../rbac.js';
import {
  getConfigPublic, setConfig, listMappings, createMapping,
  updateMapping, deleteMapping, reorderMappings, findMapping,
} from '../ssoStore.js';
import { findRole } from '../roles.js';
import { validateIssuerUrl, getDiscovery, clearDiscoveryCache } from '../sso/oidcClient.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth, requirePartnerScope, requireNotDemo, requireCsrf);

// Strip a full discovery URL down to the issuer, since that is what operators
// most often have in front of them when copying from their IdP console.
function normalizeIssuer(raw) {
  let v = String(raw || '').trim().replace(/\/+$/, '');
  const suffix = '/.well-known/openid-configuration';
  if (v.endsWith(suffix)) v = v.slice(0, -suffix.length);
  return v;
}

// A mapping may only grant a partner-scope role. Customer roles are meaningless
// without an account_id, and nothing in the token says which tenant.
function validateRoleId(roleId) {
  const role = findRole(roleId);
  if (!role) return 'Role not found';
  if (role.scope !== 'partner') return 'SSO can only grant partner-staff roles';
  return null;
}

router.get('/config', requirePermission(SETTINGS_READ), (_req, res) => {
  res.json({ config: getConfigPublic() });
});

router.put('/config', requirePermission(SETTINGS_WRITE), (req, res) => {
  const {
    enabled, issuerUrl, clientId, clientSecret, redirectUri,
    groupsClaim, buttonLabel, defaultRole, allowAdminRole,
  } = req.body || {};

  const issuer = normalizeIssuer(issuerUrl);
  if (issuer) {
    try { validateIssuerUrl(issuer); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (redirectUri) {
    try {
      const u = new URL(redirectUri);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        return res.status(400).json({ error: 'Redirect URI must be HTTPS (except on localhost)' });
      }
    } catch { return res.status(400).json({ error: 'Redirect URI is not a valid URL' }); }
  }
  if (defaultRole) {
    const err = validateRoleId(defaultRole);
    if (err) return res.status(400).json({ error: `Default role: ${err}` });
  }

  const prev = getConfigPublic();
  // Enabling with no usable credential would put a button on the login page
  // that leads straight to an error. Refuse rather than half-enable.
  const willHaveSecret = (typeof clientSecret === 'string' && clientSecret.length > 0) || prev.hasClientSecret;
  if (enabled && !(issuer && clientId && willHaveSecret)) {
    return res.status(400).json({ error: 'Issuer URL, client ID, and client secret are all required to enable SSO' });
  }

  const config = setConfig({
    enabled: !!enabled,
    issuerUrl: issuer,
    clientId: typeof clientId === 'string' ? clientId.trim() : prev.clientId,
    clientSecret,
    redirectUri: typeof redirectUri === 'string' ? redirectUri.trim() : prev.redirectUri,
    // Omitted fields keep their stored value, matching how clientSecret and
    // clientId behave. An explicit empty string still means "reset to default".
    groupsClaim: groupsClaim === undefined
      ? prev.groupsClaim
      : (String(groupsClaim).trim() || 'groups'),
    buttonLabel: buttonLabel === undefined
      ? prev.buttonLabel
      : (String(buttonLabel).trim() || 'Sign in with SSO'),
    defaultRole: defaultRole === undefined ? prev.defaultRole : (defaultRole || null),
    allowAdminRole: allowAdminRole === undefined ? prev.allowAdminRole : !!allowAdminRole,
  });

  clearDiscoveryCache(prev.issuerUrl);
  clearDiscoveryCache(issuer);
  audit({
    actorId: req.session.user.id,
    action:  'sso.config.updated',
    details: {
      enabled: config.enabled, issuerUrl: config.issuerUrl,
      allowAdminRole: config.allowAdminRole, defaultRole: config.defaultRole,
      secretChanged: typeof clientSecret === 'string' && clientSecret.length > 0,
    },
    ip: req.ip,
  });
  res.json({ config });
});

// Fetch the discovery document so an operator can confirm the issuer resolves
// before turning SSO on. Never touches stored secrets.
router.post('/test', requirePermission(SETTINGS_WRITE), async (req, res) => {
  const issuer = normalizeIssuer(req.body?.issuerUrl || getConfigPublic().issuerUrl);
  if (!issuer) return res.status(400).json({ error: 'No issuer URL configured' });
  try {
    validateIssuerUrl(issuer);
    clearDiscoveryCache(issuer);
    const doc = await getDiscovery(issuer);
    res.json({
      ok: true,
      issuer: doc.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- mappings ----------------------------------------------------------------

router.get('/mappings', requirePermission(SETTINGS_READ), (_req, res) => {
  res.json({ mappings: listMappings() });
});

router.post('/mappings', requirePermission(SETTINGS_WRITE), (req, res) => {
  const { groupValue, roleId, label } = req.body || {};
  if (typeof groupValue !== 'string' || !groupValue.trim()) {
    return res.status(400).json({ error: 'groupValue is required' });
  }
  const err = validateRoleId(roleId);
  if (err) return res.status(400).json({ error: err });

  const mapping = createMapping({ groupValue: groupValue.trim(), roleId, label: (label || '').trim() });
  audit({ actorId: req.session.user.id, action: 'sso.mapping.created', details: mapping, ip: req.ip });
  res.status(201).json({ mapping });
});

router.put('/mappings/:id', requirePermission(SETTINGS_WRITE), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !findMapping(id)) return res.status(404).json({ error: 'Mapping not found' });
  const { groupValue, roleId, label } = req.body || {};
  if (roleId != null) {
    const err = validateRoleId(roleId);
    if (err) return res.status(400).json({ error: err });
  }
  const mapping = updateMapping(id, {
    groupValue: typeof groupValue === 'string' ? groupValue.trim() : undefined,
    roleId,
    label: typeof label === 'string' ? label.trim() : undefined,
  });
  audit({ actorId: req.session.user.id, action: 'sso.mapping.updated', details: mapping, ip: req.ip });
  res.json({ mapping });
});

router.delete('/mappings/:id', requirePermission(SETTINGS_WRITE), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !findMapping(id)) return res.status(404).json({ error: 'Mapping not found' });
  deleteMapping(id);
  audit({ actorId: req.session.user.id, action: 'sso.mapping.deleted', details: { id }, ip: req.ip });
  res.json({ ok: true });
});

// Order is priority — first match wins at login, so this is a security-relevant
// setting, not a cosmetic one.
router.post('/mappings/reorder', requirePermission(SETTINGS_WRITE), (req, res) => {
  const ids = req.body?.orderedIds;
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) {
    return res.status(400).json({ error: 'orderedIds must be an array of mapping ids' });
  }
  const mappings = reorderMappings(ids);
  audit({ actorId: req.session.user.id, action: 'sso.mapping.reordered', details: { orderedIds: ids }, ip: req.ip });
  res.json({ mappings });
});

export default router;
