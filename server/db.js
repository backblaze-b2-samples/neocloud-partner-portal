// SQLite-backed persistence (better-sqlite3, synchronous).
// Tables: users, sessions, audit_log, account_credentials.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_ROLES } from './rbac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ':memory:' is SQLite's reserved name for a transient in-memory database, not
// a filename — resolving it would create a literal ':memory:' file on disk and
// silently persist state between test runs. Pass it through untouched.
const IN_MEMORY = process.env.DB_PATH === ':memory:';
const DB_PATH = IN_MEMORY
  ? ':memory:'
  : (process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data', 'app.db'));

if (!IN_MEMORY) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
if (!IN_MEMORY) db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','manager','user')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    details TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

  CREATE TABLE IF NOT EXISTS account_credentials (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    -- B2 identifiers (non-secret, stored plaintext)
    account_id                TEXT NOT NULL UNIQUE,
    email                     TEXT NOT NULL,
    group_id                  TEXT NOT NULL,
    region                    TEXT NOT NULL,
    application_key_id        TEXT NOT NULL,
    -- applicationKey encrypted with AES-256-GCM; never stored or returned in plaintext
    encrypted_application_key TEXT NOT NULL,
    key_iv                    TEXT NOT NULL,
    key_tag                   TEXT NOT NULL,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_creds_group ON account_credentials(group_id);
  CREATE INDEX IF NOT EXISTS idx_creds_email ON account_credentials(email);

  -- Customer metadata: local-only fields (plan, pricing overrides, display name, etc.).
  -- Separate from account_credentials so accounts without B2 keys can still have metadata.
  CREATE TABLE IF NOT EXISTS customer_metadata (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id            TEXT NOT NULL UNIQUE,
    display_name          TEXT,
    industry              TEXT,
    plan                  TEXT,
    price_per_gb_storage  REAL,   -- $/GB/month override (null = use standard)
    price_per_gb_download REAL,   -- $/GB egress override (null = use standard)
    notes                 TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meta_account ON customer_metadata(account_id);

  -- MCP server connection (single partner-level row, id always 1). Used by
  -- partner staff = full scope. The bearer token is encrypted at rest.
  CREATE TABLE IF NOT EXISTS mcp_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    base_url        TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 0,
    encrypted_token TEXT,
    token_iv        TEXT,
    token_tag       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  -- Per-customer scoped MCP tokens. A customer-portal session resolves to its
  -- own account's token; absence => MCP access denied (fail closed).
  CREATE TABLE IF NOT EXISTS mcp_account_tokens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL UNIQUE,
    label           TEXT,
    encrypted_token TEXT NOT NULL,
    token_iv        TEXT NOT NULL,
    token_tag       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_tokens_account ON mcp_account_tokens(account_id);

  -- Object counts: cached per-bucket file counts from b2_list_file_names.
  -- Written by the 24-hour background job (server/jobs/objectCountJob.js).
  -- Page loads read this table directly — no B2 API call needed at request time.
  CREATE TABLE IF NOT EXISTS object_counts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_id    TEXT NOT NULL UNIQUE,
    account_id   TEXT NOT NULL,
    bucket_name  TEXT,
    object_count INTEGER NOT NULL DEFAULT 0,
    counted_at   TEXT NOT NULL,   -- ISO timestamp of when this count was taken
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_objcnt_account ON object_counts(account_id);

  -- File index: per-file metadata written by the 24-hour background job.
  -- Allows instant, sort-by-anything queries without hitting the B2 API at request time.
  -- PRIMARY KEY is (bucket_id, file_name) — upserts are idempotent; stale files are
  -- deleted after each full bucket walk by comparing indexed_at < job run timestamp.
  CREATE TABLE IF NOT EXISTS file_index (
    bucket_id    TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    file_id      TEXT NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    uploaded_at  TEXT,           -- ISO timestamp of uploadTimestamp from B2
    content_type TEXT,
    indexed_at   TEXT NOT NULL,  -- ISO timestamp of when this row was written
    PRIMARY KEY (bucket_id, file_name)
  );
  CREATE INDEX IF NOT EXISTS idx_fidx_bucket   ON file_index(bucket_id);
  CREATE INDEX IF NOT EXISTS idx_fidx_uploaded ON file_index(bucket_id, uploaded_at);
  CREATE INDEX IF NOT EXISTS idx_fidx_size     ON file_index(bucket_id, size);
`);

// Migration: add account_id column and expand role CHECK on users table.
// Uses a recreate-and-rename pattern because SQLite doesn't support ALTER COLUMN.
{
  const cols = db.pragma('table_info(users)');
  const hasAccountId = cols.some(c => c.name === 'account_id');
  if (!hasAccountId) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_v2 (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        email                TEXT NOT NULL UNIQUE,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK(role IN ('admin','manager','user','support','customer_admin','customer_readonly')),
        account_id           TEXT,
        active               INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        last_login_at        TEXT
      );
      INSERT INTO users_v2 (id, email, password_hash, role, account_id, active, must_change_password, created_at, updated_at, last_login_at)
        SELECT id, email, password_hash, role, NULL, active, must_change_password, created_at, updated_at, last_login_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
    `);
    db.pragma('foreign_keys = ON');
  }
}

// =============================================================================
// Roles + permissions.
// =============================================================================
// Roles are rows, not a hardcoded list, so an operator can define their own and
// so an SSO group mapping has something meaningful to point at. `scope` keeps
// the partner/customer split that account_id enforces elsewhere: a customer
// role must never carry partner permissions.
//
// Built-ins are inserted only when missing — re-seeding on every boot would
// clobber an operator's deliberate edits to a built-in role's permission set.
// =============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL CHECK(scope IN ('partner','customer')),
    built_in    INTEGER NOT NULL DEFAULT 0,
    legacy_id   TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
  );
  CREATE INDEX IF NOT EXISTS idx_role_perms_role ON role_permissions(role_id);
`);

{
  const now = new Date().toISOString();
  const roleExists  = db.prepare('SELECT 1 FROM roles WHERE id = ?');
  const insertRole  = db.prepare(
    'INSERT INTO roles (id, name, description, scope, built_in, created_at, updated_at) VALUES (?,?,?,?,1,?,?)'
  );
  const insertPerm  = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?,?)');
  const seedBuiltIns = db.transaction(() => {
    for (const r of BUILT_IN_ROLES) {
      if (roleExists.get(r.id)) continue;
      insertRole.run(r.id, r.name, r.description, r.scope, now, now);
      for (const p of r.permissions) insertPerm.run(r.id, p);
      console.log(`[db] seeded built-in role: ${r.id} (${r.permissions.length} permissions)`);
    }
  });
  seedBuiltIns();
}

// Migration: users_v3 — drop the six-value CHECK on users.role so operator-defined
// roles are possible, point role at roles(id), and add auth_source + legacy_id.
//
// Runs AFTER the roles seed above: the new table has a real foreign key, so the
// INSERT..SELECT would fail if the referenced role rows did not exist yet. Any
// row whose role somehow has no matching roles entry is parked on 'user' rather
// than failing the boot.
//
// Same recreate-and-rename shape as the users_v2 migration above (SQLite cannot
// drop a CHECK constraint in place). Keyed on auth_source so it runs once.
{
  const cols = db.pragma('table_info(users)');
  const hasAuthSource = cols.some((c) => c.name === 'auth_source');
  if (!hasAuthSource) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_v3 (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        email                TEXT NOT NULL UNIQUE,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL REFERENCES roles(id),
        account_id           TEXT,
        active               INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        auth_source          TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local','sso')),
        legacy_id            TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        last_login_at        TEXT
      );
      INSERT INTO users_v3 (id, email, password_hash, role, account_id, active, must_change_password, auth_source, created_at, updated_at, last_login_at)
        SELECT u.id, u.email, u.password_hash,
               CASE WHEN r.id IS NULL THEN 'user' ELSE u.role END,
               u.account_id, u.active, u.must_change_password, 'local',
               u.created_at, u.updated_at, u.last_login_at
        FROM users u LEFT JOIN roles r ON r.id = u.role;
      DROP TABLE users;
      ALTER TABLE users_v3 RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);
    db.pragma('foreign_keys = ON');
    console.log('[db] migration: users_v3 (role FK + auth_source + legacy_id)');
  }
}

// Reseller plan tiers — editable from the Reseller Plans page.
// Seeded on first boot from the defaults in src/data/resellerPlans.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS reseller_plans (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT,
    storage_per_tb      REAL NOT NULL DEFAULT 0,
    egress_per_gb       REAL NOT NULL DEFAULT 0,
    class_a_per_10k     REAL NOT NULL DEFAULT 0,
    class_b_per_10k     REAL NOT NULL DEFAULT 0,
    class_c_per_10k     REAL NOT NULL DEFAULT 0,
    class_d_per_10k     REAL NOT NULL DEFAULT 0,
    position            INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL
  );
`);

// Tiny helper: add a column iff missing, log when we do.
function addColumnIfMissing(table, col, type) {
  const cols = db.pragma(`table_info(${table})`);
  if (cols.some((c) => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  console.log(`[db] migration: ${table}.${col} added`);
}

// Migration: add total_bytes column to object_counts.
// Populated by the objectCountJob during its file walk so the UI can show
// real-time storage size (not just object count) without hitting the B2 API.
addColumnIfMissing('object_counts', 'total_bytes', 'INTEGER NOT NULL DEFAULT 0');

// Migration: add ejection snapshot columns to customer_metadata.
// The Partner API does not return ejected sub-accounts, so we snapshot the
// fields we need to render them on the "Inactive" tab at eject time.
addColumnIfMissing('customer_metadata', 'ejected_at',       'TEXT');
addColumnIfMissing('customer_metadata', 'ejected_email',    'TEXT');
addColumnIfMissing('customer_metadata', 'ejected_group_id', 'TEXT');
addColumnIfMissing('customer_metadata', 'ejected_region',   'TEXT');

// Migration: pin a reseller plan to a B2 partner group. When set, every member
// of that group bills at this plan unless the account carries its own explicit
// plan. Partner-API group members arrive with no plan at all, so without this
// a newly added account silently inherited DEFAULT_PLAN_NAME — the most
// expensive tier — which is a misbilling, not a sane default.
addColumnIfMissing('reseller_plans', 'group_id', 'TEXT');

// One plan per group, or "which plan applies to this group" has no answer.
// Partial index: unpinned plans (group_id IS NULL) are unconstrained.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_plans_group
    ON reseller_plans(group_id) WHERE group_id IS NOT NULL;
`);

// Migration: per-customer transaction-rate overrides. computeBilling has always
// read these four fields, but nothing stored them, so a negotiated Class A/B/C/D
// rate had nowhere to live and silently fell back to the plan rate.
addColumnIfMissing('customer_metadata', 'price_per_10k_class_a', 'REAL');
addColumnIfMissing('customer_metadata', 'price_per_10k_class_b', 'REAL');
addColumnIfMissing('customer_metadata', 'price_per_10k_class_c', 'REAL');
addColumnIfMissing('customer_metadata', 'price_per_10k_class_d', 'REAL');

// Migration: record whether a bucket's files were actually indexed.
// walkBucket paginates b2_list_file_names 1000 at a time and writes a file_index
// row per file, which is fine for millions of objects and hopeless for billions
// (one real partner account holds 2.46e9 files across 36 buckets — ~2.46M
// sequential API calls against a job that reruns every 24h). Buckets over the
// ceiling are recorded as skipped so later runs cost nothing and the read path
// knows the totals are not usable.
//   'indexed'           — walked fully; object_count/total_bytes are authoritative
//   'skipped_too_large' — over the ceiling; counts are 0 and must not be trusted
addColumnIfMissing('object_counts', 'index_status', "TEXT NOT NULL DEFAULT 'indexed'");

// Small key/value table for one-off control-plane state that doesn't warrant a
// table of its own. First use: remembering that the reseller_plans defaults have
// been seeded, so an operator who deletes them is not handed them back on the
// next server start.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Plan names are the join key — customer_metadata.plan stores the name, not the
// id — so two plans sharing one would make planByName pick between them at
// random. Enforced here rather than trusted to the callers.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_plans_name ON reseller_plans(name);
`);

// Migration: support read-only impersonation. When non-null, the session is
// acting *as* the impersonating_user_id (effective identity); the original
// sessions.user_id remains the staff actor for audit purposes.
addColumnIfMissing('sessions', 'impersonating_user_id', 'INTEGER');

// Migration: MCP transport + auth mode. transport = 'http' (Streamable HTTP) or
// 'sse'. auth_mode = 'bearer' (single Authorization token) or 'headers' (custom
// header set, e.g. the four X-B2-* values). The encrypted credential blob holds
// the bearer token OR a JSON object of header name→value, per auth_mode.
// header_names stores the header KEYS in plaintext (not secret) for UI display.
addColumnIfMissing('mcp_config', 'transport',   "TEXT NOT NULL DEFAULT 'http'");
addColumnIfMissing('mcp_config', 'auth_mode',   "TEXT NOT NULL DEFAULT 'bearer'");
addColumnIfMissing('mcp_config', 'header_names', 'TEXT');
addColumnIfMissing('mcp_account_tokens', 'header_names', 'TEXT');

// =============================================================================
// SSO (OIDC) — optional. Nothing here is required for the portal to run; the
// login page only offers SSO once an admin enables a connection.
// =============================================================================
// sso_config mirrors mcp_config: single row, secret encrypted at rest via
// server/secretbox.js. Group mappings point at roles(id) so an IdP group can
// grant an operator-defined role, not just a built-in one.
db.exec(`
  CREATE TABLE IF NOT EXISTS sso_config (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    enabled                 INTEGER NOT NULL DEFAULT 0,
    issuer_url              TEXT NOT NULL DEFAULT '',
    client_id               TEXT NOT NULL DEFAULT '',
    encrypted_client_secret TEXT,
    secret_iv               TEXT,
    secret_tag              TEXT,
    redirect_uri            TEXT NOT NULL DEFAULT '',
    groups_claim            TEXT NOT NULL DEFAULT 'groups',
    button_label            TEXT NOT NULL DEFAULT 'Sign in with SSO',
    default_role            TEXT REFERENCES roles(id),
    allow_admin_role        INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sso_group_mappings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_value TEXT NOT NULL,
    role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sso_map_order ON sso_group_mappings(sort_order);

  -- Short-lived CSRF state for the redirect to the IdP (10 minute TTL).
  -- The nonce is echoed in an httpOnly cookie set when the flow starts, so a
  -- sign-in can only be completed in the same browser that began it.
  CREATE TABLE IF NOT EXISTS sso_states (
    state      TEXT PRIMARY KEY,
    nonce      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- One-time handoff codes (60 second TTL, deleted on first use). The callback
  -- mints one and the SPA swaps it for a session, so no credential ever travels
  -- in a URL and the session cookie can stay SameSite=Strict.
  CREATE TABLE IF NOT EXISTS sso_exchange_codes (
    code       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    nonce      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

addColumnIfMissing('sso_states', 'nonce', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('sso_exchange_codes', 'nonce', "TEXT NOT NULL DEFAULT ''");

// Clear out any stale SSO handoff state on boot — both tables are ephemeral.
db.exec('DELETE FROM sso_states; DELETE FROM sso_exchange_codes;');

// Best-effort sweep of expired sessions on every boot.
db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
