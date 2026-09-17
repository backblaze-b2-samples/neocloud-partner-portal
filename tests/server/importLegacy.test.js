// Tests for import-legacy-portal.mjs.
//
// This script runs once, against a customer's real database, so the properties
// that matter are: it never touches an account that already exists here, it
// never silently widens permissions, it refuses to leave the portal with no way
// back in, and running it twice does nothing the second time.
//
// The script is executed as a child process against temp databases, so the real
// entry point is exercised rather than a re-implementation of it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'import-legacy-portal.mjs');
let tmp;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-import-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const T = '2025-03-04T10:00:00.000Z';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';

let seq = 0;

/** A database shaped like the old portal's. */
function makeLegacy(seed = () => {}) {
  const file = path.join(tmp, `legacy-${++seq}.db`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE role_permissions (role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission));
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role_id TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_login_at TEXT, auth_source TEXT NOT NULL DEFAULT 'local');
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, user_email TEXT, action TEXT NOT NULL,
      target_type TEXT, target_id TEXT, details TEXT, ip_address TEXT, occurred_at TEXT NOT NULL);
    CREATE TABLE oidc_group_mappings (id TEXT PRIMARY KEY, azure_group_id TEXT NOT NULL, role_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0);
  `);
  const role = db.prepare('INSERT INTO roles (id,name,description,created_at) VALUES (?,?,?,?)');
  role.run(ADMIN, 'Administrator', 'Full access', T);
  role.run(VIEWER, 'Viewer', 'Read only', T);
  const perm = db.prepare('INSERT INTO role_permissions (role_id,permission) VALUES (?,?)');
  for (const p of ['users:read', 'users:write', 'audit:read', 'settings:read']) perm.run(ADMIN, p);
  for (const p of ['groups:read', 'reports:read']) perm.run(VIEWER, p);
  seed(db);
  db.close();
  return file;
}

function addUser(db, { id, email, roleId = VIEWER, active = 1, authSource = 'local' }) {
  db.prepare(
    'INSERT INTO users (id,email,password_hash,role_id,is_active,created_at,updated_at,last_login_at,auth_source) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, email, '$2b$12$bcrypthash', roleId, active, T, T, null, authSource);
}

/** A target database, migrated, optionally with users already in it. */
function makeTarget(seed = () => {}) {
  const file = path.join(tmp, `target-${++seq}.db`);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { db } = await import('${path.join(ROOT, 'server/db.js').replace(/\\/g, '/')}');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (email,password_hash,role,active,must_change_password,auth_source,created_at,updated_at) VALUES ('root@corp.com','x','admin',1,0,'local',?,?)").run(now, now);
  `], { cwd: ROOT, env: { ...process.env, DB_PATH: file }, stdio: 'ignore' });
  const db = new Database(file);
  seed(db);
  db.close();
  return file;
}

function run(target, legacy, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--from', legacy, ...args], {
      cwd: ROOT, env: { ...process.env, DB_PATH: target }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

const open = (f) => new Database(f, { readonly: true });

// ---------------------------------------------------------------------------

describe('dry run', () => {
  it('writes nothing by default', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'alice@corp.com' }));
    const target = makeTarget();
    const before = open(target).prepare('SELECT COUNT(*) n FROM users').get().n;
    const res = run(target, legacy);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN/);
    expect(open(target).prepare('SELECT COUNT(*) n FROM users').get().n).toBe(before);
    expect(open(target).prepare('SELECT COUNT(*) n FROM roles WHERE legacy_id IS NOT NULL').get().n).toBe(0);
  });

  it('tells the operator to back up including the WAL file', () => {
    const legacy = makeLegacy();
    const res = run(makeTarget(), legacy);
    expect(res.stdout).toMatch(/app\.db-wal/);
  });
});

describe('roles', () => {
  it('slugifies names and preserves the exact permission set', () => {
    const legacy = makeLegacy();
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const db = open(target);
    const admin = db.prepare("SELECT * FROM roles WHERE id='administrator'").get();
    expect(admin.scope).toBe('partner');
    expect(admin.built_in).toBe(0);
    expect(admin.legacy_id).toBe(ADMIN);
    const perms = db.prepare("SELECT permission FROM role_permissions WHERE role_id='administrator' ORDER BY permission").all().map((r) => r.permission);
    expect(perms).toEqual(['audit:read', 'settings:read', 'users:read', 'users:write']);
  });

  it('does not merge onto a same-named built-in, which would widen access', () => {
    // Their "Administrator" has 4 permissions; ours has all 23. Importing must
    // not quietly promote their admins.
    const legacy = makeLegacy();
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const db = open(target);
    expect(db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role_id='administrator'").get().n).toBe(4);
    expect(db.prepare("SELECT built_in FROM roles WHERE id='admin'").get().built_in).toBe(1);
  });

  it('drops permissions this portal does not have, and says so', () => {
    const legacy = makeLegacy((db) => db.prepare('INSERT INTO role_permissions (role_id,permission) VALUES (?,?)').run(VIEWER, 'billing:invent'));
    const target = makeTarget();
    const res = run(target, legacy, ['--execute']);
    expect(res.stdout).toMatch(/dropped unknown permission\(s\) billing:invent/);
    expect(open(target).prepare("SELECT COUNT(*) n FROM role_permissions WHERE permission='billing:invent'").get().n).toBe(0);
  });

  it('suffixes rather than overwriting when the slug is taken', () => {
    const legacy = makeLegacy();
    const target = makeTarget((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO roles (id,name,description,scope,built_in,created_at,updated_at) VALUES ('viewer','Pre-existing viewer','','partner',0,?,?)").run(now, now);
    });
    run(target, legacy, ['--execute']);
    const db = open(target);
    expect(db.prepare("SELECT name FROM roles WHERE id='viewer'").get().name).toBe('Pre-existing viewer');
    expect(db.prepare("SELECT COUNT(*) n FROM roles WHERE id='viewer_2'").get().n).toBe(1);
  });
});

describe('users', () => {
  it('imports them as partner staff with their history intact', () => {
    const legacy = makeLegacy((db) => {
      addUser(db, { id: 'u1', email: 'alice@corp.com', roleId: ADMIN });
      addUser(db, { id: 'u2', email: 'dave@corp.com', active: 0 });
    });
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const db = open(target);
    const alice = db.prepare("SELECT * FROM users WHERE email='alice@corp.com'").get();
    expect(alice.role).toBe('administrator');
    expect(alice.account_id).toBeNull();          // that portal has no tenants
    expect(alice.auth_source).toBe('sso');        // default, since they use Entra
    expect(alice.created_at).toBe(T);             // original signup date kept
    expect(alice.legacy_id).toBe('u1');
    expect(db.prepare("SELECT active FROM users WHERE email='dave@corp.com'").get().active).toBe(0);
  });

  it('never touches an account that already exists here', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'root@corp.com', roleId: ADMIN }));
    const target = makeTarget();
    const res = run(target, legacy, ['--execute']);
    expect(res.stdout).toMatch(/already exists here/);
    const row = open(target).prepare("SELECT role, auth_source, legacy_id FROM users WHERE email='root@corp.com'").get();
    expect(row).toMatchObject({ role: 'admin', auth_source: 'local', legacy_id: null });
  });

  it('keeps a user who was already federated federated', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'carol@corp.com', authSource: 'sso' }));
    const target = makeTarget();
    run(target, legacy, ['--execute', '--auth-source', 'local']);
    expect(open(target).prepare("SELECT auth_source FROM users WHERE email='carol@corp.com'").get().auth_source).toBe('sso');
  });

  it('flags a password import for reset, since the hash cannot come across', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'bob@corp.com' }));
    const target = makeTarget();
    run(target, legacy, ['--execute', '--auth-source', 'local']);
    const row = open(target).prepare("SELECT auth_source, must_change_password, password_hash FROM users WHERE email='bob@corp.com'").get();
    expect(row.auth_source).toBe('local');
    expect(row.must_change_password).toBe(1);
    expect(row.password_hash.startsWith('$argon2')).toBe(true);   // not the bcrypt one
  });
});

describe('audit trail', () => {
  it('resolves actors and preserves targets it cannot map', () => {
    const legacy = makeLegacy((db) => {
      addUser(db, { id: 'u1', email: 'alice@corp.com', roleId: ADMIN });
      const a = db.prepare('INSERT INTO audit_log (user_id,user_email,action,target_type,target_id,details,ip_address,occurred_at) VALUES (?,?,?,?,?,?,?,?)');
      a.run('u1', 'alice@corp.com', 'auth.login.success', null, null, null, '10.0.0.1', T);
      a.run('u1', 'alice@corp.com', 'member.ejected', 'member', 'acct-9f2b', JSON.stringify({ group: '165914' }), '10.0.0.1', T);
      a.run(null, 'gone@corp.com', 'auth.login.failed', null, null, null, '10.0.0.9', T);
    });
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const db = open(target);
    const alice = db.prepare("SELECT id FROM users WHERE email='alice@corp.com'").get();
    expect(db.prepare("SELECT actor_id FROM audit_log WHERE action='auth.login.success'").get().actor_id).toBe(alice.id);

    const ejected = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='member.ejected'").get().details);
    expect(ejected.group).toBe('165914');                 // original detail kept
    expect(ejected.legacy_target_type).toBe('member');    // non-user target preserved
    expect(ejected.imported_from).toBe('b2-partner-portal');

    const orphan = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='auth.login.failed'").get().details);
    expect(orphan.legacy_actor_email).toBe('gone@corp.com');
  });
});

describe('SSO group mappings', () => {
  it('carries them over pointing at the imported roles', () => {
    const legacy = makeLegacy((db) => {
      db.prepare('INSERT INTO oidc_group_mappings (id,azure_group_id,role_id,label,sort_order) VALUES (?,?,?,?,?)').run('m1', 'group-guid-1', ADMIN, 'Portal admins', 0);
      db.prepare('INSERT INTO oidc_group_mappings (id,azure_group_id,role_id,label,sort_order) VALUES (?,?,?,?,?)').run('m2', 'group-guid-2', VIEWER, '', 1);
    });
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const rows = open(target).prepare('SELECT group_value, role_id, sort_order FROM sso_group_mappings ORDER BY sort_order').all();
    expect(rows).toEqual([
      { group_value: 'group-guid-1', role_id: 'administrator', sort_order: 0 },
      { group_value: 'group-guid-2', role_id: 'viewer', sort_order: 1 },
    ]);
  });
});

describe('safety', () => {
  it('refuses to leave nobody able to sign in without the identity provider', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'alice@corp.com', roleId: ADMIN }));
    const target = makeTarget((db) => db.prepare("UPDATE users SET auth_source='sso' WHERE role='admin'").run());
    const res = run(target, legacy, ['--execute']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/Refusing to proceed/);
    expect(open(target).prepare('SELECT COUNT(*) n FROM users WHERE legacy_id IS NOT NULL').get().n).toBe(0);
  });

  it('allows it when the operator overrides deliberately', () => {
    const legacy = makeLegacy((db) => addUser(db, { id: 'u1', email: 'alice@corp.com', roleId: ADMIN }));
    const target = makeTarget((db) => db.prepare("UPDATE users SET auth_source='sso' WHERE role='admin'").run());
    expect(run(target, legacy, ['--execute', '--allow-no-local-admin']).code).toBe(0);
  });

  it('rejects a database that is not a b2-partner-portal one', () => {
    const notLegacy = path.join(tmp, 'random.db');
    const d = new Database(notLegacy); d.exec('CREATE TABLE widgets (id INTEGER)'); d.close();
    const res = run(makeTarget(), notLegacy);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/does not look like a b2-partner-portal database/);
  });

  it('rejects an unknown --auth-source', () => {
    const res = run(makeTarget(), makeLegacy(), ['--auth-source', 'ldap']);
    expect(res.code).toBe(1);
  });
});

describe('re-running', () => {
  it('is a no-op the second time', () => {
    const legacy = makeLegacy((db) => {
      addUser(db, { id: 'u1', email: 'alice@corp.com', roleId: ADMIN });
      db.prepare('INSERT INTO audit_log (user_id,user_email,action,occurred_at) VALUES (?,?,?,?)').run('u1', 'alice@corp.com', 'auth.login.success', T);
      db.prepare('INSERT INTO oidc_group_mappings (id,azure_group_id,role_id,label,sort_order) VALUES (?,?,?,?,?)').run('m1', 'g1', ADMIN, '', 0);
    });
    const target = makeTarget();
    run(target, legacy, ['--execute']);
    const snapshot = () => {
      const db = open(target);
      return {
        users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
        roles: db.prepare('SELECT COUNT(*) n FROM roles').get().n,
        audit: db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
        maps: db.prepare('SELECT COUNT(*) n FROM sso_group_mappings').get().n,
      };
    };
    const first = snapshot();
    const res = run(target, legacy, ['--execute']);
    expect(res.stdout).toMatch(/0 to create/);
    expect(snapshot()).toEqual(first);
  });
});
