import { describe, it, expect, beforeAll } from 'vitest';
import {
  isValidEmail, isStrongPassword, isValidRole, ROLES,
  createUser, findByEmail, findById, listUsers, publicUser,
  setRole, setActive, setMustChangePassword,
  activeAdminCount, activeAdminCountExcept,
} from '../../server/users.js';
import { db } from '../../server/db.js';

// Reset DB before this file's tests — guards against shared in-memory DB state
// when Vitest reuses module instances across test files.
beforeAll(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
});

let seq = 0;
const email = () => `user${++seq}@test.com`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe('isValidEmail', () => {
  it('accepts valid addresses', () => {
    expect(isValidEmail('alice@example.com')).toBe(true);
    expect(isValidEmail('a+b@x.co')).toBe(true);
    expect(isValidEmail('USER@EXAMPLE.ORG')).toBe(true);
  });
  it('rejects invalid addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@no-local.com')).toBe(false);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe('isStrongPassword', () => {
  it('accepts 8+ character strings', () => {
    expect(isStrongPassword('password')).toBe(true);
    expect(isStrongPassword('12345678')).toBe(true);
    expect(isStrongPassword('a'.repeat(200))).toBe(true);
  });
  it('rejects too-short or non-string values', () => {
    expect(isStrongPassword('abc')).toBe(false);
    expect(isStrongPassword('')).toBe(false);
    expect(isStrongPassword(null)).toBe(false);
    expect(isStrongPassword('a'.repeat(201))).toBe(false);
  });
});

describe('isValidRole', () => {
  it('accepts all defined roles', () => {
    for (const r of ROLES) expect(isValidRole(r)).toBe(true);
  });
  it('rejects unknown roles', () => {
    expect(isValidRole('superadmin')).toBe(false);
    expect(isValidRole('')).toBe(false);
    expect(isValidRole(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('createUser / findByEmail / findById', () => {
  it('creates and retrieves a user by email', () => {
    const e = email();
    const u = createUser({ email: e, passwordHash: 'hash', role: 'user' });
    expect(u.id).toBeGreaterThan(0);
    expect(findByEmail(e)).not.toBeNull();
    expect(findByEmail(e).email).toBe(e);
  });

  it('normalises email to lowercase', () => {
    const e = `Upper${++seq}@Test.COM`;
    createUser({ email: e, passwordHash: 'hash', role: 'user' });
    expect(findByEmail(e.toLowerCase())).not.toBeNull();
  });

  it('findById returns falsy for unknown id', () => {
    expect(findById(999999)).toBeFalsy();
  });

  it('listUsers grows after create', () => {
    const before = listUsers().length;
    createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    expect(listUsers().length).toBe(before + 1);
  });

  it('stores accountId for customer roles', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'customer_admin', accountId: 'acct-xyz' });
    expect(findById(u.id).account_id).toBe('acct-xyz');
  });

  it('mustChangePassword defaults to false', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    expect(findById(u.id).must_change_password).toBe(0);
  });

  it('mustChangePassword can be set at creation', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user', mustChangePassword: true });
    expect(findById(u.id).must_change_password).toBe(1);
  });
});

describe('publicUser', () => {
  it('omits password_hash', () => {
    const u = createUser({ email: email(), passwordHash: 'supersecret', role: 'admin' });
    const pub = publicUser(u);
    expect(pub).not.toHaveProperty('password_hash');
  });

  it('exposes expected fields', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'manager' });
    const pub = publicUser(u);
    expect(pub).toMatchObject({ role: 'manager', active: true, mustChangePassword: false });
    expect(pub).toHaveProperty('id');
    expect(pub).toHaveProperty('email');
  });

  it('returns null for null input', () => {
    expect(publicUser(null)).toBeNull();
  });
});

describe('setRole / setActive / setMustChangePassword', () => {
  it('setRole updates the role', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    setRole(u.id, 'manager');
    expect(findById(u.id).role).toBe('manager');
  });

  it('setRole rejects invalid roles', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    expect(() => setRole(u.id, 'god')).toThrow();
  });

  it('setActive deactivates and reactivates', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    setActive(u.id, false);
    expect(findById(u.id).active).toBe(0);
    setActive(u.id, true);
    expect(findById(u.id).active).toBe(1);
  });

  it('setMustChangePassword toggles the flag', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'user' });
    setMustChangePassword(u.id, true);
    expect(findById(u.id).must_change_password).toBe(1);
    setMustChangePassword(u.id, false);
    expect(findById(u.id).must_change_password).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Admin count (last-admin protection helpers)
// ---------------------------------------------------------------------------

describe('activeAdminCount / activeAdminCountExcept', () => {
  it('counts only active admins', () => {
    const before = activeAdminCount();
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'admin' });
    expect(activeAdminCount()).toBe(before + 1);
    setActive(u.id, false);
    expect(activeAdminCount()).toBe(before);
  });

  it('activeAdminCountExcept excludes the given id', () => {
    const u = createUser({ email: email(), passwordHash: 'hash', role: 'admin' });
    const total = activeAdminCount();
    expect(activeAdminCountExcept(u.id)).toBe(total - 1);
  });

  it('non-admin users are not counted', () => {
    const before = activeAdminCount();
    createUser({ email: email(), passwordHash: 'hash', role: 'manager' });
    createUser({ email: email(), passwordHash: 'hash', role: 'support' });
    expect(activeAdminCount()).toBe(before);
  });
});
