// Auth + CSRF middleware.
// - attachSession: best-effort lookup; never errors. Used for /me.
// - requireAuth: 401 if no valid session.
// - requireRole(...roles): 403 if role not allowed.
// - requireCsrf: enforce double-submit token on state-changing requests.
//   Cookie value must match X-CSRF-Token header.

import { getSession, SESSION_COOKIE, CSRF_COOKIE } from '../auth.js';
import { audit } from '../audit.js';

// During a read-only impersonation, writes are 403-blocked at the CSRF
// chokepoint — except for the routes that *end* impersonation or the session
// entirely. Matched against originalUrl (sans query string).
const IMPERSONATION_WRITE_ALLOWLIST = new Set([
  '/api/impersonate/stop',
  '/api/auth/logout',
  // /start is allowlisted so its handler runs and can return a specific
  // 409 ("already impersonating") instead of a generic readonly 403.
  '/api/impersonate/start',
]);

export function attachSession(req, _res, next) {
  const sid = req.cookies?.[SESSION_COOKIE];
  req.session = sid ? getSession(sid) : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

const DEMO_EMAILS = new Set(['demo@backblaze.com']);
export const isDemoEmail = (email) =>
  typeof email === 'string' && (email.endsWith('@demo.com') || DEMO_EMAILS.has(email));

export function requireNotDemo(req, res, next) {
  // When impersonating, judge by the *actor* — a real admin viewing as a
  // demo customer should still be able to reach partner endpoints. The
  // read-only block in requireCsrf still prevents any mutation.
  const actorEmail = req.session?.impersonator?.email || req.session?.user?.email;
  if (isDemoEmail(actorEmail)) {
    return res.status(403).json({ error: 'Not available for demo accounts.' });
  }
  next();
}

export function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Bad CSRF token' });
  }
  // Block every write while impersonating, except the routes that end the
  // impersonation (or the whole session). This is the single chokepoint that
  // makes "view as customer" guaranteed read-only — no per-route checks needed.
  //
  // A few B2 endpoints use POST as a transport for read operations
  // (e.g. b2_list_buckets). Those routes set req.allowDuringImpersonation in
  // a middleware that runs *before* requireCsrf — and we let them through.
  if (req.session?.impersonator) {
    const urlPath = (req.originalUrl || '').split('?')[0];
    const allowed = IMPERSONATION_WRITE_ALLOWLIST.has(urlPath) || req.allowDuringImpersonation === true;
    if (!allowed) {
      audit({
        actorId: req.session.impersonator.id,
        action:  'impersonation.write_blocked',
        targetUserId: req.session.user.id,
        details: { method: req.method, path: urlPath },
        ip:      req.ip,
      });
      return res.status(403).json({
        error: 'impersonating_readonly',
        message: 'Read-only impersonation — write operations are blocked. Exit impersonation to make changes.',
      });
    }
  }
  next();
}

// Partner staff (admin/manager/user/support — accountId is null) may access
// any sub-account. Customer roles are locked to their own assigned accountId.
// Use from any route that takes accountId as a request param.
export function canAccessAccount(user, accountId) {
  if (!user) return false;
  if (!user.accountId) return true;
  return user.accountId === accountId;
}
