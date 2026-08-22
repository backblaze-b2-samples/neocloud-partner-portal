// =============================================================================
// /api/auth/sso/* — the public half of OIDC single sign-on.
// =============================================================================
// Flow:
//   GET  /status    unauthenticated; tells the login page whether to offer SSO
//   GET  /login     mints `state`, redirects to the IdP
//   GET  /callback  IdP redirects here; validates everything, then hands the SPA
//                   a one-time code
//   POST /exchange  SPA swaps the code for a real session
//
// Why the exchange hop exists
// ---------------------------
// Session cookies are SameSite=Strict (server/auth.js). A session established
// directly on the IdP-initiated callback would not be sent on the navigation
// that follows, because that navigation is cross-site initiated. Creating the
// session in /exchange — a same-site XHR the SPA makes itself — keeps
// SameSite=Strict intact. It also keeps credentials out of URLs, which is why
// the portal this was ported from does the same thing.
//
// CSRF
// ----
// /exchange cannot sit behind requireCsrf: the caller has no session and so no
// CSRF cookie yet. This is not a new exception — POST /api/auth/login is
// outside requireCsrf for exactly the same reason. It is protected by the
// already-consumed `state` and by a single-use code that expires in 60 seconds.
// =============================================================================

import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { ssoLimiter } from '../rateLimit.js';
import { isDemoEmail } from '../middleware/requireAuth.js';
import { createSession, setAuthCookies, hashPassword } from '../auth.js';
import { getConfigPublic, isSsoUsable, getDecryptedClientSecret } from '../ssoStore.js';
import { resolveRole } from '../sso/roleResolver.js';
import {
  buildAuthUrl, exchangeCode, verifyIdToken, extractEmail, extractGroups, hasGroupOverage,
} from '../sso/oidcClient.js';
import { findByEmail, createUser, recordLogin, setRole } from '../users.js';

const router = express.Router();

const STATE_TTL_MS    = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;

const insertState  = db.prepare('INSERT INTO sso_states (state, nonce, created_at) VALUES (?,?,?)');
const findState    = db.prepare('SELECT state, nonce FROM sso_states WHERE state = ? AND created_at > ?');
const deleteState  = db.prepare('DELETE FROM sso_states WHERE state = ?');
const sweepStates  = db.prepare('DELETE FROM sso_states WHERE created_at <= ?');
const insertCode   = db.prepare('INSERT INTO sso_exchange_codes (code, user_id, nonce, created_at) VALUES (?,?,?,?)');
const findCode     = db.prepare('SELECT user_id, nonce FROM sso_exchange_codes WHERE code = ? AND created_at > ?');
const deleteCode   = db.prepare('DELETE FROM sso_exchange_codes WHERE code = ?');
const sweepCodes   = db.prepare('DELETE FROM sso_exchange_codes WHERE created_at <= ?');

const token = () => crypto.randomBytes(32).toString('base64url');
const now   = () => new Date().toISOString();

// =============================================================================
// Flow cookie — binds a sign-in to the browser that started it.
// =============================================================================
// Without this, the handoff code is a bearer token sitting in a URL: an attacker
// could start their own SSO flow and send a victim
// /?sso=1&code=<attacker's code>. That is a top-level navigation, so no CORS
// check applies and the SPA would redeem it automatically, silently signing the
// victim into the ATTACKER's account — everything they then did would land in
// the attacker's tenant. Classic login CSRF.
//
// So /login issues a random nonce in an httpOnly cookie and records it with the
// state. The callback and the exchange both require it to match. A code minted
// in one browser is worthless in another.
//
// SameSite=Lax rather than Strict: the callback arrives as a cross-site
// top-level GET from the identity provider, and Strict would withhold the
// cookie exactly when it is needed. Lax still blocks cross-site POSTs and
// sub-resource requests, which is the part that matters here. The session
// cookie itself stays Strict.
const FLOW_COOKIE = 'sso_flow';
const FLOW_PATH = '/api/auth/sso';

function setFlowCookie(res, nonce) {
  const flags = [`${FLOW_COOKIE}=${nonce}`, 'HttpOnly', `Path=${FLOW_PATH}`, 'SameSite=Lax', `Max-Age=${STATE_TTL_MS / 1000}`];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function clearFlowCookie(res) {
  const flags = [`${FLOW_COOKIE}=`, 'HttpOnly', `Path=${FLOW_PATH}`, 'SameSite=Lax', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

// Constant-time compare so a mismatch cannot be probed byte by byte.
function sameNonce(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Absolute base URL for this deployment. APP_BASE_URL wins; otherwise derive it
 * from the proxy headers (trust proxy is configured in server/index.js). The
 * IdP needs an absolute redirect_uri and the SPA has no router, so there is no
 * base URL anywhere else in the codebase to reuse.
 */
function baseUrl(req) {
  const configured = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function redirectUriFor(req, cfg) {
  return cfg.redirectUri || `${baseUrl(req)}/api/auth/sso/callback`;
}

/** Send the browser back to the SPA with a machine-readable reason. */
function fail(res, reason) {
  return res.redirect(302, `/?sso=1&error=${encodeURIComponent(reason)}`);
}

// --- status ------------------------------------------------------------------

// Deliberately minimal: an unauthenticated caller learns whether SSO is on and
// what the button should say, and nothing about the issuer or client id.
router.get('/status', (_req, res) => {
  const cfg = getConfigPublic();
  res.json({ enabled: isSsoUsable(), buttonLabel: cfg.buttonLabel || 'Sign in with SSO' });
});

// --- start -------------------------------------------------------------------

router.get('/login', async (req, res) => {
  const limited = ssoLimiter(req);
  if (!limited.ok) return fail(res, 'rate_limited');
  if (!isSsoUsable()) return res.status(400).json({ error: 'SSO is not configured or disabled.' });

  const cfg = getConfigPublic();
  const state = token();
  const nonce = token();
  sweepStates.run(new Date(Date.now() - STATE_TTL_MS).toISOString());
  insertState.run(state, nonce, now());
  setFlowCookie(res, nonce);

  try {
    const url = await buildAuthUrl({
      issuerUrl:   cfg.issuerUrl,
      clientId:    cfg.clientId,
      redirectUri: redirectUriFor(req, cfg),
      state,
    });
    return res.redirect(302, url);
  } catch (e) {
    audit({ actorId: null, action: 'auth.sso.discovery_failed', details: { message: e.message }, ip: req.ip });
    return fail(res, 'discovery_failed');
  }
});

// --- callback ----------------------------------------------------------------

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return fail(res, String(error).slice(0, 64));
  if (!code || !state) return fail(res, 'missing_params');
  if (!isSsoUsable()) return fail(res, 'sso_disabled');

  // Validate and consume state. Single-use: a replayed callback fails here.
  const cutoff = new Date(Date.now() - STATE_TTL_MS).toISOString();
  const stateRow = findState.get(String(state), cutoff);
  if (!stateRow) return fail(res, 'invalid_state');
  deleteState.run(String(state));
  sweepStates.run(cutoff);

  // ...and it must be the same browser that started the flow.
  const flowNonce = req.cookies?.[FLOW_COOKIE];
  if (!sameNonce(flowNonce, stateRow.nonce)) {
    audit({ actorId: null, action: 'auth.sso.denied', details: { reason: 'flow_mismatch' }, ip: req.ip });
    clearFlowCookie(res);
    return fail(res, 'invalid_state');
  }

  const cfg = getConfigPublic();
  let claims;
  try {
    const tokens = await exchangeCode({
      issuerUrl:    cfg.issuerUrl,
      clientId:     cfg.clientId,
      clientSecret: getDecryptedClientSecret(),
      redirectUri:  redirectUriFor(req, cfg),
      code:         String(code),
    });
    claims = await verifyIdToken({ idToken: tokens.id_token, issuerUrl: cfg.issuerUrl, clientId: cfg.clientId });
  } catch (e) {
    audit({ actorId: null, action: 'auth.sso.token_error', details: { message: e.message }, ip: req.ip });
    return fail(res, 'token_error');
  }

  const email = extractEmail(claims);
  if (!email) return fail(res, 'no_email');

  // Demo accounts are password-only. An IdP must never be able to provision or
  // claim one, and an SSO session must never become a demo session.
  if (isDemoEmail(email)) {
    audit({ actorId: null, action: 'auth.sso.denied', details: { reason: 'demo_account' }, ip: req.ip });
    return fail(res, 'demo_account');
  }

  const groups = extractGroups(claims, cfg.groupsClaim);

  // Entra drops the groups claim past ~150 memberships and points at Graph
  // instead. Without this the user would get "no_role", which sends an operator
  // hunting for a missing mapping that is actually present.
  if (groups.length === 0 && hasGroupOverage(claims, cfg.groupsClaim)) {
    audit({ actorId: null, action: 'auth.sso.denied', details: { reason: 'group_overage', email }, ip: req.ip });
    return fail(res, 'group_overage');
  }

  const resolved = resolveRole(groups);
  if (!resolved.ok) {
    audit({
      actorId: null,
      action:  'auth.sso.denied',
      details: { reason: resolved.reason, roleId: resolved.roleId || null, groupsInToken: groups.length },
      ip:      req.ip,
    });
    return fail(res, resolved.reason);
  }

  const existing = findByEmail(email);
  let userId;

  if (existing) {
    // An SSO identity must not be able to take over a password account by
    // asserting its address. An admin links the account deliberately instead
    // (Convert to SSO in user management), which keeps the row, its id, and its
    // audit history intact.
    if (existing.auth_source !== 'sso') {
      audit({ actorId: existing.id, action: 'auth.sso.denied', details: { reason: 'account_conflict' }, ip: req.ip });
      return fail(res, 'account_conflict');
    }
    if (!existing.active) {
      audit({ actorId: existing.id, action: 'auth.sso.denied', details: { reason: 'inactive' }, ip: req.ip });
      return fail(res, 'account_inactive');
    }
    userId = existing.id;
    // Re-assert the role on every login — the IdP is the source of truth.
    if (existing.role !== resolved.roleId) {
      setRole(userId, resolved.roleId);
      audit({
        actorId: userId, action: 'auth.sso.role_updated', targetUserId: userId,
        details: { from: existing.role, to: resolved.roleId, via: resolved.via }, ip: req.ip,
      });
    }
  } else {
    // JIT provision. password_hash is NOT NULL, so store a hash of random bytes
    // that nobody holds the input to — password login is refused for SSO users
    // anyway, this just keeps the column honest.
    const filler = await hashPassword(crypto.randomBytes(32).toString('base64url'));
    const created = createUser({
      email, passwordHash: filler, role: resolved.roleId, accountId: null, mustChangePassword: false,
    });
    db.prepare("UPDATE users SET auth_source = 'sso' WHERE id = ?").run(created.id);
    userId = created.id;
    audit({
      actorId: userId, action: 'auth.sso.provisioned', targetUserId: userId,
      details: { role: resolved.roleId, via: resolved.via }, ip: req.ip,
    });
  }

  recordLogin(userId);
  audit({ actorId: userId, action: 'auth.sso.login.success', details: { role: resolved.roleId }, ip: req.ip });

  const handoff = token();
  sweepCodes.run(new Date(Date.now() - EXCHANGE_TTL_MS).toISOString());
  insertCode.run(handoff, userId, stateRow.nonce, now());
  return res.redirect(302, `/?sso=1&code=${encodeURIComponent(handoff)}`);
});

// --- exchange ----------------------------------------------------------------

router.post('/exchange', (req, res) => {
  const limited = ssoLimiter(req);
  if (!limited.ok) {
    res.set('Retry-After', String(Math.ceil(limited.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many attempts' });
  }
  const code = req.body?.code;
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'Invalid or expired sign-in code' });

  const cutoff = new Date(Date.now() - EXCHANGE_TTL_MS).toISOString();
  const row = findCode.get(code, cutoff);
  // Consume unconditionally: even a miss sweeps, and a hit can never be reused.
  deleteCode.run(code);
  sweepCodes.run(cutoff);
  if (!row) return res.status(400).json({ error: 'Invalid or expired sign-in code' });

  // The code is only redeemable in the browser that started the flow, so a code
  // pasted into someone else's browser is inert.
  if (!sameNonce(req.cookies?.[FLOW_COOKIE], row.nonce)) {
    audit({ actorId: row.user_id, action: 'auth.sso.denied', details: { reason: 'flow_mismatch' }, ip: req.ip });
    clearFlowCookie(res);
    return res.status(400).json({ error: 'Invalid or expired sign-in code' });
  }

  const sess = createSession({ userId: row.user_id, ip: req.ip, userAgent: req.get('user-agent') || '' });
  clearFlowCookie(res);
  setAuthCookies(res, sess);
  res.json({ ok: true });
});

export default router;
