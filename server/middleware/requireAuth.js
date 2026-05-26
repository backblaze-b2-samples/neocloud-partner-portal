// Auth + CSRF middleware.
// - attachSession: best-effort lookup; never errors. Used for /me.
// - requireAuth: 401 if no valid session.
// - requireRole(...roles): 403 if role not allowed.
// - requireCsrf: enforce double-submit token on state-changing requests.
//   Cookie value must match X-CSRF-Token header.

import { getSession, SESSION_COOKIE, CSRF_COOKIE } from '../auth.js';

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
  if (isDemoEmail(req.session?.user?.email)) {
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
  next();
}
