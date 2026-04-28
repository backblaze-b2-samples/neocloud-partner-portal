// In-memory sliding-window rate limiter. Keyed by (route, ip+email-bucket).
// Suitable for a single-process demo deploy. For multi-instance, swap to a
// shared store (Redis) — the interface stays the same.

const buckets = new Map();

function prune(now) {
  if (buckets.size < 10000) return;
  for (const [k, arr] of buckets) {
    const fresh = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) buckets.delete(k);
    else buckets.set(k, fresh);
  }
}

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const arr = buckets.get(key) || [];
  const fresh = arr.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    const retryAfterMs = windowMs - (now - fresh[0]);
    return { ok: false, retryAfterMs };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  prune(now);
  return { ok: true };
}

export function loginLimiter(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const emailBucket = String(req.body?.email || '').toLowerCase().trim().slice(0, 64);
  // Two limits: per-IP (slows brute force from one host), per-(IP+email)
  // (slows credential stuffing of a specific account).
  const a = rateLimit({ key: `login:ip:${ip}`,                limit: 30, windowMs: 15 * 60 * 1000 });
  if (!a.ok) return a;
  const b = rateLimit({ key: `login:user:${ip}:${emailBucket}`, limit: 8,  windowMs: 15 * 60 * 1000 });
  return b;
}
