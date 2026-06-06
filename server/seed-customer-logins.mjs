// =============================================================================
// seed-customer-logins.mjs — Create customer-portal logins for an account.
//
// Use when the customer logins you have are tied to an ejected sub-account
// (those logins are now deactivated by the eject cascade) and you need a
// working pair to test the customer portal.
//
// Usage (run from project root):
//   node server/seed-customer-logins.mjs                 # pick a random active account
//   node server/seed-customer-logins.mjs <accountId>     # target a specific account
//   node server/seed-customer-logins.mjs --list          # list active accounts and exit
//
// Behaviour:
//   - Refuses to target an ejected account (anything with ejected_at set).
//   - Skips if an admin/viewer login already exists for the account, unless
//     --replace is passed (in which case it resets passwords).
//   - Prints the credentials at the end. Treat them like any seed value.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './auth.js';
import {
  findByEmail, createUser, setPasswordHash, setActive,
} from './users.js';
import { audit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const REPLACE = args.includes('--replace');
const LIST    = args.includes('--list');
const TARGET  = args.find((a) => a && !a.startsWith('--')) || null;

// --- Active-account inventory --------------------------------------------------
// An "active" account = has credentials stored AND is not flagged ejected.
const activeAccounts = db.prepare(`
  SELECT c.account_id, c.email, c.group_id, c.region,
         m.display_name, m.ejected_at
  FROM account_credentials c
  LEFT JOIN customer_metadata m ON m.account_id = c.account_id
  WHERE m.ejected_at IS NULL
  ORDER BY c.email
`).all().filter((a) => !a.ejected_at);

if (LIST) {
  if (activeAccounts.length === 0) {
    console.log('No active accounts with stored credentials.');
  } else {
    console.log(`Active accounts (${activeAccounts.length}):`);
    for (const a of activeAccounts) {
      console.log(`  ${a.account_id.padEnd(16)}  ${(a.display_name || a.email || '').padEnd(40)}  region=${a.region}`);
    }
  }
  process.exit(0);
}

if (activeAccounts.length === 0) {
  console.error('No active accounts found. Restore an ejected account first or seed credentials.');
  process.exit(1);
}

// --- Pick target ---------------------------------------------------------------
let target;
if (TARGET) {
  target = activeAccounts.find((a) => a.account_id === TARGET);
  if (!target) {
    const ejected = db.prepare('SELECT ejected_at FROM customer_metadata WHERE account_id = ?').get(TARGET);
    if (ejected?.ejected_at) {
      console.error(`Account ${TARGET} is ejected (${ejected.ejected_at}). Restore it first or pick another.`);
    } else {
      console.error(`Account ${TARGET} not found in active accounts. Run with --list to see options.`);
    }
    process.exit(1);
  }
} else {
  target = activeAccounts[0];
  console.log(`No accountId given — picking first active: ${target.account_id} (${target.email})`);
}

// --- Build credentials ---------------------------------------------------------
// Use the account email's local part as a stable prefix so re-running yields
// the same pair of emails (deterministic, easy to remember).
const localPart  = String(target.email || target.account_id).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
const adminEmail  = `${localPart}-admin@portal.local`;
const viewerEmail = `${localPart}-viewer@portal.local`;
const password    = crypto.randomBytes(9).toString('base64url'); // ~12 chars

const hash = await hashPassword(password);

const upserts = [];
async function upsert(email, role) {
  const existing = findByEmail(email);
  if (existing) {
    if (!REPLACE) {
      upserts.push({ email, role, status: 'exists (skipped)', id: existing.id });
      return;
    }
    setPasswordHash(existing.id, hash, 0);
    setActive(existing.id, true);
    audit({ actorId: null, action: 'customer_user.reseeded', targetUserId: existing.id, details: { accountId: target.account_id, role } });
    upserts.push({ email, role, status: 'replaced', id: existing.id });
    return;
  }
  const u = createUser({
    email,
    passwordHash: hash,
    role,
    accountId: target.account_id,
    mustChangePassword: false,
  });
  audit({ actorId: null, action: 'customer_user.seeded', targetUserId: u.id, details: { accountId: target.account_id, role } });
  upserts.push({ email, role, status: 'created', id: u.id });
}

await upsert(adminEmail,  'customer_admin');
await upsert(viewerEmail, 'customer_readonly');

// --- Report --------------------------------------------------------------------
console.log('');
console.log('=========================================================');
console.log(`  Account:  ${target.account_id}  (${target.email})`);
console.log(`  Display:  ${target.display_name || '—'}`);
console.log('=========================================================');
for (const r of upserts) {
  console.log(`  ${r.email.padEnd(36)}  role=${r.role.padEnd(20)}  ${r.status}  id=${r.id}`);
}
const anyChanged = upserts.some((r) => r.status === 'created' || r.status === 'replaced');
if (anyChanged) {
  console.log('');
  console.log(`  Password (BOTH users): ${password}`);
  console.log('  Share securely. Both users are NOT flagged for forced reset.');
} else {
  console.log('');
  console.log('  No changes — pass --replace to reset passwords on existing logins.');
}
console.log('=========================================================');
