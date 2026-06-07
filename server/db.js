// SQLite-backed persistence (better-sqlite3, synchronous).
// Tables: users, sessions, audit_log, account_credentials.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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

// Best-effort sweep of expired sessions on every boot.
db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
