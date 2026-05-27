// Append-only audit log.
// Actor email is intentionally NOT stored: the user_id is the durable
// reference and emails are PII that should not multiply across tables.

import { db } from './db.js';

const insert = db.prepare(`
  INSERT INTO audit_log (actor_id, action, target_user_id, details, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function audit({ actorId = null, action, targetUserId = null, details = null, ip = null }) {
  insert.run(
    actorId,
    action,
    targetUserId,
    details ? JSON.stringify(details) : null,
    ip,
    new Date().toISOString()
  );
}

// Query audit_log with optional filters. Returns rows + a total count for
// pagination. All filter args are optional.
export function listAudit({
  limit = 100,
  offset = 0,
  action,           // substring match on action (e.g. "auth." matches all auth events)
  actorId,          // exact match on actor_id
  targetUserId,     // exact match on target_user_id
  involvingUserId,  // matches if either actor_id OR target_user_id equals the value
  fromDate,         // ISO date string (inclusive)
  toDate,           // ISO date string (exclusive)
} = {}) {
  const where = [];
  const args  = [];
  if (action)               { where.push('al.action LIKE ?');     args.push(`%${action}%`); }
  if (actorId != null)      { where.push('al.actor_id = ?');      args.push(actorId); }
  if (targetUserId != null) { where.push('al.target_user_id = ?'); args.push(targetUserId); }
  if (involvingUserId != null) {
    where.push('(al.actor_id = ? OR al.target_user_id = ?)');
    args.push(involvingUserId, involvingUserId);
  }
  if (fromDate) { where.push('al.created_at >= ?');   args.push(fromDate); }
  if (toDate)   { where.push('al.created_at < ?');    args.push(toDate); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // LEFT JOIN users twice so the UI can render actor + target emails without
  // a second query. This is read-only enrichment — no email is written back
  // to audit_log.
  const rows = db.prepare(`
    SELECT
      al.id, al.actor_id, al.action, al.target_user_id, al.details, al.ip, al.created_at,
      ua.email AS actor_email,
      ut.email AS target_email
    FROM audit_log al
    LEFT JOIN users ua ON ua.id = al.actor_id
    LEFT JOIN users ut ON ut.id = al.target_user_id
    ${clause}
    ORDER BY al.id DESC
    LIMIT ? OFFSET ?
  `).all(...args, Math.max(1, Math.min(500, limit)), Math.max(0, offset));

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM audit_log al ${clause}`).get(...args);
  return { entries: rows, total: n };
}

// Delete entries older than `days`. Used by the daily prune cron.
// Returns the number of rows removed.
export function pruneAudit(days = 365) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff).changes;
}
