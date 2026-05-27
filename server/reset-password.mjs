// =============================================================================
// reset-password.mjs — Reset a user's password directly in SQLite.
//
// Useful when both admin accounts are locked out and you can't reach the
// User Management UI to reset via the normal flow. Writes a fresh argon2id
// hash and clears the `must_change_password` flag.
//
// Usage (run on EC2):
//   node server/reset-password.mjs <email> <new-password>
//
// Example:
//   node server/reset-password.mjs klott@backblaze.com 'NewSecret!2026'
//
// Plaintext password is never written to disk — only its argon2id hash.
// Active sessions for the user are killed so the next login picks up the
// new hash.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { hashPassword } from './auth.js';
import { db } from './db.js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node server/reset-password.mjs <email> <new-password>');
  process.exit(1);
}
// Emergency / admin tool — no length floor. The normal admin-created-user
// flow in the web UI still requires 8+ chars; this script is for cases like
// restoring the documented seed password (`demo`) or unsticking a locked-out
// account with whatever the operator chooses.

const user = db.prepare('SELECT id, email, active, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user found with email ${email}`);
  process.exit(1);
}

const hash = await hashPassword(password);
const now  = new Date().toISOString();

db.prepare(
  'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'
).run(hash, now, user.id);

const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;

console.log(`✓ Password reset for ${user.email} (id=${user.id}, role=${user.role}, active=${!!user.active})`);
console.log(`  Sessions terminated: ${killed}`);
console.log('  Sign in with the new password now. Note: password is not echoed back.');
