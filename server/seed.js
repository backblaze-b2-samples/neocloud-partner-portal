// Seed the default admin from environment variables.
//
// Runs at startup. If at least one admin already exists, we do nothing —
// rotating env values does NOT silently mutate live accounts.
//
// The seed values come from process.env (DEFAULT_ADMIN_EMAIL /
// DEFAULT_ADMIN_PASSWORD) and are never written into committed source,
// frontend bundles, or HTTP responses.

import { hashPassword, destroyAllSessionsFor } from './auth.js';
import { audit } from './audit.js';
import {
  activeAdminCount, createUser, findByEmail, isValidEmail,
  CUSTOMER_ROLES, setActive,
} from './users.js';
import { db } from './db.js';

const DEMO_USERS = [
  { email: 'demo@backblaze.com',     role: 'admin',             accountId: null },
  { email: 'lumora-admin@demo.com',  role: 'customer_admin',    accountId: '7f3a91d2c4b8' },
  { email: 'lumora-viewer@demo.com', role: 'customer_readonly', accountId: '7f3a91d2c4b8' },
  { email: 'support@demo.com',       role: 'support',           accountId: null },
];

export async function seedDemoUsers() {
  const hash = await hashPassword('demo');
  let created = 0;
  for (const { email, role, accountId } of DEMO_USERS) {
    if (findByEmail(email)) continue;
    const u = createUser({ email, passwordHash: hash, role, accountId, mustChangePassword: false });
    audit({ actorId: null, action: 'admin.seeded', targetUserId: u.id, details: { source: 'demo-seed' } });
    console.log(`[seed] Demo user provisioned: ${email} (${role})`);
    created++;
  }
  return { created };
}

// One-time reconciliation: for every customer-portal user whose account is
// currently flagged ejected in customer_metadata, deactivate the user row and
// kill any live sessions. Idempotent — safe to call on every boot.
//
// This handles two cases the per-request cascade doesn't:
//   (1) accounts ejected BEFORE the cascade was deployed (history),
//   (2) accounts ejected via direct DB writes that bypass the route.
export function reconcileCustomerLoginsAgainstEjection() {
  const stale = db.prepare(`
    SELECT u.id, u.email, u.account_id
    FROM users u
    JOIN customer_metadata m ON m.account_id = u.account_id
    WHERE u.active = 1
      AND m.ejected_at IS NOT NULL
      AND u.role IN (${CUSTOMER_ROLES.map(() => '?').join(',')})
  `).all(...CUSTOMER_ROLES);

  for (const u of stale) {
    setActive(u.id, false);
    destroyAllSessionsFor(u.id);
    audit({
      actorId: null,
      action: 'customer_user.deactivated_by_ejection',
      targetUserId: u.id,
      details: { accountId: u.account_id, source: 'boot_reconcile' },
    });
  }
  if (stale.length > 0) {
    console.log(`[seed] reconciled ${stale.length} customer login(s) on ejected accounts`);
  }
  return { deactivated: stale.length };
}

export async function seedDefaultAdmin() {
  if (activeAdminCount() > 0) return { seeded: false, reason: 'admin-exists' };

  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!email || !password) {
    // No admin and no seed configured. Make this impossible to miss — the
    // app would otherwise start and reject every login with the unhelpful
    // "Invalid credentials" because there is no admin to log in as.
    console.error('');
    console.error('═════════════════════════════════════════════════════════════════');
    console.error('  ERROR: no admin user in DB and DEFAULT_ADMIN_* env vars unset.');
    console.error('  The portal will accept no logins until an admin is provisioned.');
    console.error('  Set DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD in .env, then');
    console.error('  restart. See DEPLOY.md → "First-run setup".');
    console.error('═════════════════════════════════════════════════════════════════');
    console.error('');
    return { seeded: false, reason: 'no-env' };
  }
  if (!isValidEmail(email)) {
    console.error('[seed] DEFAULT_ADMIN_EMAIL is not a valid email; skipping seed.');
    return { seeded: false, reason: 'bad-email' };
  }
  // Accept any non-trivial operator-chosen seed password. Strong-password
  // policy (8+ chars) still applies to admin-created users and to
  // change-password flows.
  if (typeof password !== 'string' || password.length < 4 || password.length > 200) {
    console.error('[seed] DEFAULT_ADMIN_PASSWORD must be 4-200 chars; skipping seed.');
    return { seeded: false, reason: 'bad-password' };
  }

  // Defensive: if a user with that email exists but is not active or not admin,
  // do not silently take it over. Operators can promote them manually.
  if (findByEmail(email)) {
    console.warn('[seed] A user with the configured admin email already exists; not modifying it.');
    return { seeded: false, reason: 'email-taken' };
  }

  const hash = await hashPassword(password);
  // mustChangePassword=false (per product decision); admins can rotate later.
  const user = createUser({ email, passwordHash: hash, role: 'admin', mustChangePassword: false });
  audit({ actorId: null, action: 'admin.seeded', targetUserId: user.id, details: { source: 'env' } });
  // Log only that an admin was created, NOT the email value.
  console.log(`[seed] Default admin provisioned (id=${user.id}).`);
  return { seeded: true, userId: user.id };
}
