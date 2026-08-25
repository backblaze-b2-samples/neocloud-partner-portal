#!/usr/bin/env node
// Usage:
//   node import-legacy-portal.mjs --from /path/to/old-portal.db              # dry run (default)
//   node import-legacy-portal.mjs --from /path/to/old-portal.db --execute    # actually write
//
// Imports portal users, roles, permissions, the audit trail, and SSO group
// mappings from the older backblaze-b2-samples/b2-partner-portal into this
// portal's database.
//
// What it does NOT import, and why:
//   credential_vault  — Fernet-encrypted with that portal's CREDENTIAL_VAULT_KEY.
//                       Different crypto to ours; needs a separate decrypt/re-encrypt
//                       pass, or re-provision the keys through the Partner API.
//   oidc_config       — the client secret cannot transfer, and a move to a new
//                       identity provider means a new app registration anyway.
//                       Configure SSO in Settings instead.
//   group_pricing     — that portal prices per partner GROUP in $/TB; this one
//                       prices per plan tier with per-account overrides. Not a
//                       1:1 mapping, so it is a decision rather than a copy.
//   sessions, refresh tokens, report cache, lockout counters — ephemeral, or
//                       handled differently here (we rate limit rather than lock).
//
// Passwords are NOT migrated: that portal uses bcrypt, this one uses argon2id,
// and a hash cannot be converted. Imported users therefore get an unusable
// random hash. With --auth-source sso (the default) they sign in through your
// identity provider and never need one. With --auth-source local they are
// flagged must_change_password and an admin has to issue a reset.
//
// Safe to re-run: rows already imported are matched on legacy_id and skipped.
//
// Env:
//   DB_PATH   — this portal's database (defaults to server/data/app.db)

import 'dotenv/config';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EXECUTE        = process.argv.includes('--execute');
const SOURCE         = arg('--from');
const AUTH_SOURCE    = arg('--auth-source', 'sso');
const MERGE_BUILTINS = process.argv.includes('--merge-builtins');
const ALLOW_NO_LOCAL = process.argv.includes('--allow-no-local-admin');

if (!SOURCE) {
  console.error('Missing --from <path to the old portal\'s .db file>');
  console.error('Run with --help for usage.');
  process.exit(1);
}
if (!['sso', 'local'].includes(AUTH_SOURCE)) {
  console.error(`--auth-source must be 'sso' or 'local' (got '${AUTH_SOURCE}')`);
  process.exit(1);
}

// Importing this runs the schema migrations on the target, which must happen
// before we write anything into it.
const { db } = await import('./server/db.js');
const { hashPassword } = await import('./server/auth.js');
const { isValidPermission } = await import('./server/rbac.js');

let src;
try {
  src = new Database(SOURCE, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`Could not open ${SOURCE}: ${e.message}`);
  process.exit(1);
}

// Fail early and clearly if this is not the database we think it is.
const tables = new Set(
  src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);
for (const required of ['users', 'roles', 'role_permissions']) {
  if (!tables.has(required)) {
    console.error(`${SOURCE} does not look like a b2-partner-portal database (no '${required}' table).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();
const report = { roles: [], users: [], audit: 0, mappings: [], skipped: [], warnings: [] };

/** Role ids here are slugs; theirs are UUIDs. Derive one from the role name. */
function slugify(name, fallback) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(s)) s = 'r_' + s;
  s = s.slice(0, 31);
  if (s.length < 2) s = fallback;
  return s;
}

function uniqueRoleId(base) {
  const taken = (id) => !!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id);
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}_${n}`.slice(0, 31);
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`Could not find a free role id based on '${base}'`);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const legacyRoles = src.prepare('SELECT id, name, description FROM roles ORDER BY name').all();
const legacyPerms = src.prepare('SELECT role_id, permission FROM role_permissions').all();
const permsByRole = new Map();
for (const p of legacyPerms) {
  if (!permsByRole.has(p.role_id)) permsByRole.set(p.role_id, []);
  permsByRole.get(p.role_id).push(p.permission);
}

const roleIdByLegacy = new Map();   // legacy uuid -> our role id

function planRoles() {
  for (const r of legacyRoles) {
    const existing = db.prepare('SELECT id FROM roles WHERE legacy_id = ?').get(r.id);
    if (existing) {
      roleIdByLegacy.set(r.id, existing.id);
      report.roles.push({ legacy: r.name, id: existing.id, action: 'already imported' });
      continue;
    }

    const wanted = slugify(r.name, 'imported_role');
    const collides = !!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(wanted);

    // Merging onto a same-named built-in is opt-in: our built-ins are broader
    // than theirs, so doing it silently would hand imported users more access
    // than they had.
    if (collides && MERGE_BUILTINS) {
      const target = db.prepare('SELECT id, built_in FROM roles WHERE id = ?').get(wanted);
      roleIdByLegacy.set(r.id, target.id);
      report.roles.push({ legacy: r.name, id: target.id, action: 'merged onto existing role' });
      continue;
    }

    const id = uniqueRoleId(wanted);
    const perms = (permsByRole.get(r.id) || []).filter(isValidPermission);
    const dropped = (permsByRole.get(r.id) || []).filter((p) => !isValidPermission(p));
    if (dropped.length) {
      report.warnings.push(`role '${r.name}': dropped unknown permission(s) ${dropped.join(', ')}`);
    }
    roleIdByLegacy.set(r.id, id);
    report.roles.push({
      legacy: r.name, id, action: collides ? 'created (name taken, suffixed)' : 'created',
      permissions: perms.length, perms, description: r.description || '', legacyId: r.id,
    });
  }
}

function writeRoles() {
  const insRole = db.prepare(
    'INSERT INTO roles (id, name, description, scope, built_in, legacy_id, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)'
  );
  const insPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)');
  for (const r of report.roles) {
    if (!r.action.startsWith('created')) continue;
    // Every imported role is partner scope: that portal has no tenant concept,
    // its users are all staff of the partner running it.
    insRole.run(r.id, r.legacy, r.description, 'partner', r.legacyId, now(), now());
    for (const p of r.perms) insPerm.run(r.id, p);
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const legacyUsers = src.prepare(`
  SELECT id, email, role_id, is_active, created_at, updated_at, last_login_at,
         ${tables.has('users') && src.pragma('table_info(users)').some((c) => c.name === 'auth_source')
           ? 'auth_source' : "'local' AS auth_source"}
  FROM users ORDER BY created_at, id
`).all();

const userIdByLegacy = new Map();   // legacy uuid -> our integer id

function planUsers() {
  for (const u of legacyUsers) {
    const email = String(u.email || '').trim().toLowerCase();
    if (!email) { report.skipped.push(`user ${u.id}: no email`); continue; }

    const already = db.prepare('SELECT id FROM users WHERE legacy_id = ?').get(u.id);
    if (already) {
      userIdByLegacy.set(u.id, already.id);
      report.users.push({ email, action: 'already imported', role: null });
      continue;
    }
    const clash = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
    if (clash) {
      // Never touch an account that already exists here. An operator can link
      // it deliberately; guessing would be worse than reporting it.
      userIdByLegacy.set(u.id, clash.id);
      report.skipped.push(`user ${email}: an account with this email already exists here (role '${clash.role}'), left untouched`);
      continue;
    }

    const roleId = roleIdByLegacy.get(u.role_id);
    if (!roleId) {
      report.skipped.push(`user ${email}: role ${u.role_id} did not import, cannot place them`);
      continue;
    }
    // A user already federated over there stays federated here regardless of
    // the flag; downgrading them to a password account they do not have would
    // just lock them out.
    const authSource = u.auth_source === 'sso' ? 'sso' : AUTH_SOURCE;
    report.users.push({
      email, role: roleId, authSource,
      active: u.is_active ? 1 : 0,
      createdAt: u.created_at || now(),
      updatedAt: u.updated_at || now(),
      lastLoginAt: u.last_login_at || null,
      legacyId: u.id,
      action: 'create',
    });
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const legacyAudit = tables.has('audit_log')
  ? src.prepare('SELECT id, user_id, user_email, action, target_type, target_id, details, ip_address, occurred_at FROM audit_log ORDER BY id').all()
  : [];

// Already-imported rows carry their source id, so a re-run does not duplicate.
const importedAuditIds = new Set(
  db.prepare("SELECT details FROM audit_log WHERE details LIKE '%legacy_audit_id%'").all()
    .map((r) => { try { return JSON.parse(r.details).legacy_audit_id; } catch { return null; } })
    .filter((v) => v != null)
);

function planAudit() {
  report.audit = legacyAudit.filter((a) => !importedAuditIds.has(a.id)).length;
}

function writeAudit() {
  const ins = db.prepare(
    'INSERT INTO audit_log (actor_id, action, target_user_id, details, ip, created_at) VALUES (?,?,?,?,?,?)'
  );
  for (const a of legacyAudit) {
    if (importedAuditIds.has(a.id)) continue;
    const actorId = userIdByLegacy.get(a.user_id) ?? null;
    // Their target can be any entity type; ours is a user id. Anything that is
    // not a portal user is preserved in the details rather than dropped.
    const targetUserId = a.target_type === 'portal_user' ? (userIdByLegacy.get(a.target_id) ?? null) : null;
    let original = null;
    if (a.details) { try { original = JSON.parse(a.details); } catch { original = { raw: a.details }; } }
    const details = {
      ...(original || {}),
      imported_from: 'b2-partner-portal',
      legacy_audit_id: a.id,
      ...(a.user_email && actorId == null ? { legacy_actor_email: a.user_email } : {}),
      ...(a.target_type && targetUserId == null ? { legacy_target_type: a.target_type, legacy_target_id: a.target_id } : {}),
    };
    ins.run(actorId, a.action, targetUserId, JSON.stringify(details), a.ip_address || null, a.occurred_at || now());
  }
}

// ---------------------------------------------------------------------------
// SSO group mappings
// ---------------------------------------------------------------------------

const legacyMappings = tables.has('oidc_group_mappings')
  ? src.prepare('SELECT azure_group_id, role_id, label, sort_order FROM oidc_group_mappings ORDER BY sort_order').all()
  : [];

function planMappings() {
  for (const m of legacyMappings) {
    const roleId = roleIdByLegacy.get(m.role_id);
    if (!roleId) { report.skipped.push(`group mapping ${m.azure_group_id}: role did not import`); continue; }
    const exists = db.prepare('SELECT 1 FROM sso_group_mappings WHERE group_value = ?').get(m.azure_group_id);
    if (exists) { report.skipped.push(`group mapping ${m.azure_group_id}: already present`); continue; }
    report.mappings.push({ groupValue: m.azure_group_id, roleId, label: m.label || '', sortOrder: m.sort_order ?? 0 });
  }
}

function writeMappings() {
  const ins = db.prepare('INSERT INTO sso_group_mappings (group_value, role_id, label, sort_order) VALUES (?,?,?,?)');
  for (const m of report.mappings) ins.run(m.groupValue, m.roleId, m.label, m.sortOrder);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

planRoles();
planUsers();
planAudit();
planMappings();

// Break-glass: at least one active admin must still be able to sign in without
// the identity provider, or an outage locks everyone out of administration.
function localAdminsAfter() {
  const existing = db.prepare(
    "SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND auth_source = 'local'"
  ).get().n;
  const incoming = report.users.filter(
    (u) => u.action === 'create' && u.authSource === 'local' && u.active && u.role === 'admin'
  ).length;
  return existing + incoming;
}

console.log('');
console.log('='.repeat(72));
console.log(`  Import from ${SOURCE}`);
console.log(`  Mode: ${EXECUTE ? 'EXECUTE (writes)' : 'DRY RUN (no changes)'}   auth-source: ${AUTH_SOURCE}`);
console.log('='.repeat(72));

console.log('\nRoles');
for (const r of report.roles) {
  console.log(`  ${String(r.legacy).padEnd(24)} -> ${String(r.id).padEnd(24)} ${r.action}${r.permissions != null ? ` (${r.permissions} permissions)` : ''}`);
}
if (!report.roles.length) console.log('  (none)');

console.log('\nUsers');
const creating = report.users.filter((u) => u.action === 'create');
for (const u of creating) {
  console.log(`  ${u.email.padEnd(34)} role=${String(u.role).padEnd(20)} ${u.authSource}${u.active ? '' : '  (inactive)'}`);
}
console.log(`  ${creating.length} to create, ${report.users.length - creating.length} already imported`);

console.log(`\nAudit entries to import: ${report.audit}`);
console.log(`SSO group mappings to import: ${report.mappings.length}`);

if (report.skipped.length) {
  console.log('\nSkipped');
  for (const s of report.skipped) console.log(`  ${s}`);
}
if (report.warnings.length) {
  console.log('\nWarnings');
  for (const w of report.warnings) console.log(`  ${w}`);
}

const localAdmins = localAdminsAfter();
console.log(`\nActive admins able to sign in WITHOUT the identity provider, after import: ${localAdmins}`);
if (localAdmins === 0 && !ALLOW_NO_LOCAL) {
  console.error('\nRefusing to proceed: that would leave nobody able to administer the portal');
  console.error('if the identity provider is unreachable. Create a local admin first, or');
  console.error('pass --allow-no-local-admin if you are certain.');
  process.exit(1);
}

if (!EXECUTE) {
  console.log('\nDry run only. Re-run with --execute to apply.');
  console.log('Back up the database first: sqlite3 app.db ".backup backup.db"');
  console.log('(copying app.db alone loses anything still in app.db-wal)\n');
  process.exit(0);
}

// argon2 hashing is async, so users are hashed up front and the writes then
// happen in one synchronous transaction: all of it lands, or none of it does.
const pending = [];
for (const u of report.users.filter((x) => x.action === 'create')) {
  pending.push({ u, hash: await hashPassword(crypto.randomBytes(32).toString('base64url')) });
}
const insUser = db.prepare(`
  INSERT INTO users (email, password_hash, role, account_id, active, must_change_password,
                     auth_source, legacy_id, created_at, updated_at, last_login_at)
  VALUES (?,?,?,NULL,?,?,?,?,?,?,?)
`);

const apply = db.transaction(() => {
  writeRoles();
  for (const { u, hash } of pending) {
    const info = insUser.run(
      u.email, hash, u.role, u.active,
      u.authSource === 'local' ? 1 : 0,
      u.authSource, u.legacyId, u.createdAt, u.updatedAt, u.lastLoginAt,
    );
    userIdByLegacy.set(u.legacyId, info.lastInsertRowid);
  }
  writeAudit();
  writeMappings();
});

try {
  apply();
  console.log('\nImported successfully.');
  console.log(`  roles created:   ${report.roles.filter((r) => r.action.startsWith('created')).length}`);
  console.log(`  users created:   ${pending.length}`);
  console.log(`  audit entries:   ${report.audit}`);
  console.log(`  group mappings:  ${report.mappings.length}`);
  console.log('\nNext: configure SSO under Settings, then check Administration > Roles & permissions.\n');
} catch (e) {
  console.error(`\nImport failed, nothing was written: ${e.message}\n`);
  process.exit(1);
}
