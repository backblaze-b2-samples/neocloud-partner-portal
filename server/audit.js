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

export function listAudit({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT id, actor_id, action, target_user_id, details, ip, created_at
    FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(limit);
}
