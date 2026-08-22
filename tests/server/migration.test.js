// Upgrade-path tests for the users_v3 migration.
//
// This is the riskiest code in the RBAC change: it runs automatically on an
// existing production database the first time the new server boots, and it
// rebuilds the users table to drop a CHECK constraint. If it goes wrong the
// portal does not start.
//
// Each case boots server/db.js in a CHILD PROCESS against a temp database, so
// the module-level connection this test file already holds is never involved
// and the real boot path is exercised exactly as it would be on the box.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { V1, V2, DEPENDENTS } from '../fixtures/legacySchemas.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
let tmpDir;

beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-migration-')); });
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

let seq = 0;
function makeLegacyDb(schema, seed) {
  const file = path.join(tmpDir, `legacy-${++seq}.db`);
  const db = new Database(file);
  db.exec(schema + DEPENDENTS);
  seed(db);
  db.close();
  return file;
}

/** Boot server/db.js against `file`, then run `script` in the same process. */
function bootAndQuery(file, script) {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const { db } = await import('${path.join(ROOT, 'server/db.js').replace(/\\/g, '/')}');
      const result = (() => { ${script} })();
      process.stdout.write('@@' + JSON.stringify(result) + '@@');
    `],
    { cwd: ROOT, env: { ...process.env, DB_PATH: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const m = out.match(/@@([\s\S]*)@@/);
  if (!m) throw new Error('no result marker in child output: ' + out);
  return JSON.parse(m[1]);
}

const now = new Date().toISOString();
const later = new Date(Date.now() + 86_400_000).toISOString();

describe('users_v3 migration from the v2 schema', () => {
  let file;
  beforeAll(() => {
    file = makeLegacyDb(V2, (db) => {
      const ins = db.prepare(
        'INSERT INTO users (email,password_hash,role,account_id,active,must_change_password,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?)'
      );
      ins.run('boss@corp.com', 'argon2-boss', 'admin', null, 1, 0, now, now, now);
      ins.run('mgr@corp.com', 'argon2-mgr', 'manager', null, 1, 1, now, now, null);
      ins.run('sup@corp.com', 'argon2-sup', 'support', null, 0, 0, now, now, null);
      ins.run('tenant@corp.com', 'argon2-ten', 'customer_admin', 'acct-77', 1, 0, now, now, now);
      db.prepare('INSERT INTO sessions (id,user_id,csrf_token,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?,?)')
        .run('sid-live', 1, 'csrf-live', now, later, '10.0.0.1', 'ua');
      db.prepare('INSERT INTO audit_log (actor_id,action,target_user_id,details,ip,created_at) VALUES (?,?,?,?,?,?)')
        .run(1, 'auth.login.success', null, null, '10.0.0.1', now);
    });
  });

  it('preserves every user row, id, and flag', () => {
    const users = bootAndQuery(file, `
      return db.prepare('SELECT id,email,role,account_id,active,must_change_password,auth_source,password_hash,last_login_at FROM users ORDER BY id').all();
    `);
    expect(users).toHaveLength(4);
    expect(users[0]).toMatchObject({
      id: 1, email: 'boss@corp.com', role: 'admin', account_id: null,
      active: 1, must_change_password: 0, auth_source: 'local', password_hash: 'argon2-boss',
    });
    expect(users[1]).toMatchObject({ id: 2, role: 'manager', must_change_password: 1 });
    expect(users[2]).toMatchObject({ id: 3, role: 'support', active: 0 });
    expect(users[3]).toMatchObject({ id: 4, role: 'customer_admin', account_id: 'acct-77' });
    // last_login_at must survive — it is the only "have they ever signed in" signal.
    expect(users[0].last_login_at).toBe(now);
  });

  it('does not cascade-delete dependent rows during the table rebuild', () => {
    const counts = bootAndQuery(file, `
      return {
        sessions: db.prepare('SELECT COUNT(*) n FROM sessions').get().n,
        audit: db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
        sid: db.prepare('SELECT user_id, csrf_token FROM sessions WHERE id = ?').get('sid-live'),
      };
    `);
    expect(counts.sessions).toBe(1);
    expect(counts.audit).toBe(1);
    expect(counts.sid).toEqual({ user_id: 1, csrf_token: 'csrf-live' });
  });

  it('drops the CHECK constraint so custom roles become assignable', () => {
    const res = bootAndQuery(file, `
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql;
      const n = new Date().toISOString();
      db.prepare("INSERT INTO roles (id,name,description,scope,built_in,created_at,updated_at) VALUES ('custom','Custom','','partner',0,?,?)").run(n, n);
      db.prepare("INSERT INTO users (email,password_hash,role,active,must_change_password,created_at,updated_at) VALUES ('custom@corp.com','h','custom',1,0,?,?)").run(n, n);
      return { hasCheck: /CHECK\\(role/.test(sql), assigned: db.prepare("SELECT role FROM users WHERE email='custom@corp.com'").get().role };
    `);
    expect(res.hasCheck).toBe(false);
    expect(res.assigned).toBe('custom');
  });

  it('leaves no foreign-key violations behind', () => {
    const violations = bootAndQuery(file, `return db.pragma('foreign_key_check');`);
    expect(violations).toEqual([]);
  });

  it('is idempotent across repeated boots', () => {
    const a = bootAndQuery(file, `return db.prepare('SELECT COUNT(*) n FROM users').get().n;`);
    const b = bootAndQuery(file, `return db.prepare('SELECT COUNT(*) n FROM users').get().n;`);
    const c = bootAndQuery(file, `return db.prepare('SELECT COUNT(*) n FROM users').get().n;`);
    expect([a, b, c]).toEqual([a, a, a]);
  });

  it('does not re-seed a built-in role an operator has edited', () => {
    const before = bootAndQuery(file, `
      db.prepare("DELETE FROM role_permissions WHERE role_id='manager' AND permission='billing:read'").run();
      return db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role_id='manager'").get().n;
    `);
    const after = bootAndQuery(file, `
      return db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role_id='manager'").get().n;
    `);
    expect(after).toBe(before);
  });
});

describe('users_v3 migration from the original v1 schema', () => {
  // A deployment that never saw the account_id migration has to chain v2 then v3
  // in a single boot.
  it('chains both migrations and preserves data', () => {
    const file = makeLegacyDb(V1, (db) => {
      const ins = db.prepare(
        'INSERT INTO users (email,password_hash,role,active,must_change_password,created_at,updated_at,last_login_at) VALUES (?,?,?,?,?,?,?,?)'
      );
      ins.run('old-admin@corp.com', 'argon2-old', 'admin', 1, 0, now, now, now);
      ins.run('old-user@corp.com', 'argon2-old2', 'user', 1, 0, now, now, null);
    });
    const users = bootAndQuery(file, `
      return db.prepare('SELECT id,email,role,account_id,auth_source,password_hash FROM users ORDER BY id').all();
    `);
    expect(users).toEqual([
      { id: 1, email: 'old-admin@corp.com', role: 'admin', account_id: null, auth_source: 'local', password_hash: 'argon2-old' },
      { id: 2, email: 'old-user@corp.com', role: 'user', account_id: null, auth_source: 'local', password_hash: 'argon2-old2' },
    ]);
  });
});

describe('users_v3 migration edge cases', () => {
  it('parks a user whose role has no matching row rather than failing the boot', () => {
    // Simulates a hand-edited database, or a role that only ever existed in an
    // older build. Failing the whole boot over one bad row would be worse.
    //
    // Note the v2 CHECK constraint refuses this row outright, so the fixture is
    // built from an unconstrained variant — a row like this can only reach us
    // from outside the app's own writes.
    const UNCONSTRAINED = V2.replace(/ CHECK\(role IN \([^)]*\)\)/, '');
    const file = makeLegacyDb(UNCONSTRAINED, (db) => {
      db.prepare('INSERT INTO users (email,password_hash,role,active,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run('ghost@corp.com', 'h', 'nonexistent_role', 1, 0, now, now);
    });
    const users = bootAndQuery(file, `return db.prepare('SELECT email, role FROM users').all();`);
    expect(users).toEqual([{ email: 'ghost@corp.com', role: 'user' }]);
  });

  it('handles an empty users table', () => {
    const file = makeLegacyDb(V2, () => {});
    const res = bootAndQuery(file, `
      return {
        users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
        roles: db.prepare('SELECT COUNT(*) n FROM roles').get().n,
      };
    `);
    expect(res).toEqual({ users: 0, roles: 6 });
  });

  it('creates a working database from nothing', () => {
    const file = path.join(tmpDir, 'brand-new.db');
    const res = bootAndQuery(file, `
      return {
        roles: db.prepare('SELECT COUNT(*) n FROM roles').get().n,
        perms: db.prepare("SELECT COUNT(*) n FROM role_permissions WHERE role_id='admin'").get().n,
        authSource: db.pragma('table_info(users)').some((c) => c.name === 'auth_source'),
        ssoTables: db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'sso_%'").get().n,
      };
    `);
    expect(res.roles).toBe(6);
    expect(res.perms).toBe(23);
    expect(res.authSource).toBe(true);
    expect(res.ssoTables).toBe(4);
  });
});
