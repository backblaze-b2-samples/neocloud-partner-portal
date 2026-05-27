// Print every user row so we can see whether resets are actually taking.
// Read-only — never writes the DB.
import { db } from './db.js';

const rows = db.prepare(`
  SELECT id, email, role, active, must_change_password,
         substr(password_hash, 1, 30) AS hash_prefix,
         created_at, updated_at, last_login_at
  FROM users ORDER BY email
`).all();

if (rows.length === 0) {
  console.log('(no users)');
} else {
  for (const r of rows) {
    console.log(
      `id=${r.id}  ${r.email.padEnd(28)}  role=${r.role.padEnd(18)}  ` +
      `active=${r.active}  must_change=${r.must_change_password}  ` +
      `hash=${r.hash_prefix}…`
    );
    console.log(`    created ${r.created_at}  updated ${r.updated_at}  last_login ${r.last_login_at || '—'}`);
  }
  console.log(`\nTotal: ${rows.length}`);
}
