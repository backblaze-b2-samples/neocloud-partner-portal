// Test argon2 verify against the stored hash for a given email + password.
// Bypasses HTTP, rate limiting, and the frontend — pure DB+crypto check.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { db } from './db.js';
import { verifyPassword } from './auth.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node server/test-login.mjs <email> <password>');
  process.exit(1);
}

const row = db.prepare('SELECT id, email, role, active, must_change_password, password_hash FROM users WHERE email = ?').get(email);
if (!row) {
  console.log(`✗ no user row for ${email}`);
  process.exit(1);
}

console.log(`row: id=${row.id} role=${row.role} active=${row.active} must_change=${row.must_change_password}`);
console.log(`hash prefix: ${row.password_hash.slice(0, 50)}...`);

const ok = await verifyPassword(row.password_hash, password);
console.log(`verifyPassword('${password}'): ${ok ? '✓ MATCH' : '✗ no match'}`);
