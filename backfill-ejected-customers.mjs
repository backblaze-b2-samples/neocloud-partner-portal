#!/usr/bin/env node
// One-shot: insert customer_metadata rows for the 46 sub-accounts ejected
// earlier today (2026-05-26) so the portal can render them as "Inactive"
// alongside active customers. Adds the schema columns (status, ejected_at,
// email, group_id, region) on first run via ALTER TABLE — SQLite-safe.
//
// Usage:
//   node backfill-ejected-customers.mjs              # dry-run, prints plan
//   node backfill-ejected-customers.mjs --execute    # apply schema + inserts
//
// Idempotent: skips rows already present in customer_metadata.

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const EXECUTE = process.argv.includes('--execute');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EJECTED_AT = '2026-05-26';

// Captured from the eject-unmanaged-customers.mjs dry-run output earlier today.
const EJECTED = [
  { accountId: '1bbd653bc92f', email: 'alex.johnson@neocloud-storage.com',     groupId: '165914' },
  { accountId: 'f993f0b8ed2e', email: 'james.rivera@neocloud-storage.com',     groupId: '165914' },
  { accountId: 'b9f0de9466ae', email: 'aisha.okonkwo@neocloud-storage.com',    groupId: '165915' },
  { accountId: '1527dd8fe65d', email: 'alex.osei@neocloud-storage.com',        groupId: '165915' },
  { accountId: '53ffe62a3982', email: 'anna.svensson@neocloud-storage.com',    groupId: '165915' },
  { accountId: '08ffdf519c06', email: 'ben.okonkwo@neocloud-storage.com',      groupId: '165915' },
  { accountId: '69c78b1baedf', email: 'carlos.mendez@neocloud-storage.com',    groupId: '165915' },
  { accountId: '2ba91efcfc81', email: 'claire.dupont@neocloud-storage.com',    groupId: '165915' },
  { accountId: 'a78c4c854804', email: 'customer1-west@neocloud-storage.com',   groupId: '165915' },
  { accountId: '8efecf1c9577', email: 'customer3-eu@neocloud-storage.com',     groupId: '165915' },
  { accountId: 'deb57a5ab1a3', email: 'dev.sharma@neocloud-storage.com',       groupId: '165915' },
  { accountId: 'a201a4685755', email: 'diana.chen@neocloud-storage.com',       groupId: '165915' },
  { accountId: 'bfaad8f90713', email: 'eliot.burke@neocloud-storage.com',      groupId: '165915' },
  { accountId: '7bfe1a301904', email: 'emma.weber@neocloud-storage.com',       groupId: '165915' },
  { accountId: 'ec51616c69f2', email: 'fiona.walsh@neocloud-storage.com',      groupId: '165915' },
  { accountId: '33b4714fefe3', email: 'guo.wei@neocloud-storage.com',          groupId: '165915' },
  { accountId: '307b288c8773', email: 'hana.nakamura@neocloud-storage.com',    groupId: '165915' },
  { accountId: '7850af84e6f6', email: 'ivan.petrov@neocloud-storage.com',      groupId: '165915' },
  { accountId: 'f63c78ac05fe', email: 'james.liu@neocloud-storage.com',        groupId: '165915' },
  { accountId: '77ca8c5715b0', email: 'jasmine.tran@neocloud-storage.com',     groupId: '165915' },
  { accountId: 'dcda18366af8', email: 'jordan.kim@neocloud-storage.com',       groupId: '165915' },
  { accountId: 'aaa94a0288dc', email: 'kai.bergstrom@neocloud-storage.com',    groupId: '165915' },
  { accountId: '7cb597d21d6d', email: 'lena.hoffmann@neocloud-storage.com',    groupId: '165915' },
  { accountId: '42f7bda5892e', email: 'leo.santos@neocloud-storage.com',       groupId: '165915' },
  { accountId: '2cbd13ba7a50', email: 'lucas.patel@neocloud-storage.com',      groupId: '165915' },
  { accountId: 'd39900a8cf97', email: 'maya.patel@neocloud-storage.com',       groupId: '165915' },
  { accountId: '1803384d6dc8', email: 'miguel.garcia@neocloud-storage.com',    groupId: '165915' },
  { accountId: '7f5865a67870', email: 'nina.petrov@neocloud-storage.com',      groupId: '165915' },
  { accountId: 'dfba1bd395a7', email: 'noa.cohen@neocloud-storage.com',        groupId: '165915' },
  { accountId: '1cdba66802c7', email: 'omar.hassan@neocloud-storage.com',      groupId: '165915' },
  { accountId: 'caedf6c5cc91', email: 'oscar.lindqvist@neocloud-storage.com',  groupId: '165915' },
  { accountId: '33345dc93a9b', email: 'petra.novak@neocloud-storage.com',      groupId: '165915' },
  { accountId: '4c516b1fb885', email: 'priya.reddy@neocloud-storage.com',      groupId: '165915' },
  { accountId: 'bcf919276641', email: 'quinn.murphy@neocloud-storage.com',     groupId: '165915' },
  { accountId: '03877bde65b9', email: 'rosa.moretti@neocloud-storage.com',     groupId: '165915' },
  { accountId: 'ac5dda2fd1fa', email: 'ryan.torres@neocloud-storage.com',      groupId: '165915' },
  { accountId: '1671b85a18d0', email: 'sam.oduya@neocloud-storage.com',        groupId: '165915' },
  { accountId: '05fa32fd0179', email: 'sara.chen@neocloud-storage.com',        groupId: '165915' },
  { accountId: 'b4414ac5d518', email: 'sofia.mueller@neocloud-storage.com',    groupId: '165915' },
  { accountId: 'f96560d1fbaa', email: 'tara.kim@neocloud-storage.com',         groupId: '165915' },
  { accountId: '4126894034ed', email: 'ugo.rossi@neocloud-storage.com',        groupId: '165915' },
  { accountId: '4cbae07c6659', email: 'vera.jansen@neocloud-storage.com',      groupId: '165915' },
  { accountId: '48a4c9d4659e', email: 'will.carter@neocloud-storage.com',      groupId: '165915' },
  { accountId: '0b82d7434054', email: 'yuki.nakamura@neocloud-storage.com',    groupId: '165915' },
  { accountId: '268e62b2c5c0', email: 'customer11-eu@neocloud-storage.com',    groupId: '165916' },
  { accountId: '617d4769de42', email: 'customer8-west@neocloud-storage.com',   groupId: '165916' },
];

// Derive a display name from email local-part: "alex.johnson" → "Alex Johnson"
function nameFromEmail(email) {
  const local = email.split('@')[0];
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

// Email convention → short B2 region.
function regionFromEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if (local.endsWith('-eu'))   return 'eu-central';
  if (local.endsWith('-east')) return 'us-east';
  if (local.endsWith('-west')) return 'us-west';
  if (local.includes('rivera')) return 'us-east';
  return 'us-west';
}

const dbPath = path.join(__dirname, 'server/data/app.db');
const db = new Database(dbPath, { readonly: !EXECUTE });

// ---------- Schema check & migration ----------
const cols = new Set(db.prepare('PRAGMA table_info(customer_metadata)').all().map((c) => c.name));
const needed = ['status', 'ejected_at', 'email', 'group_id', 'region'];
const missing = needed.filter((c) => !cols.has(c));

console.log(`Mode: ${EXECUTE ? '*** EXECUTE ***' : 'DRY-RUN'}`);
console.log(`customer_metadata existing columns: ${[...cols].join(', ')}`);
console.log(`columns to add: ${missing.length ? missing.join(', ') : '(none)'}`);

if (missing.length && EXECUTE) {
  for (const col of missing) {
    const def =
      col === 'status'     ? "TEXT NOT NULL DEFAULT 'active'" :
      col === 'ejected_at' ? "TEXT" :
      col === 'email'      ? "TEXT" :
      col === 'group_id'   ? "TEXT" :
      col === 'region'     ? "TEXT" : "TEXT";
    db.exec(`ALTER TABLE customer_metadata ADD COLUMN ${col} ${def}`);
    console.log(`  + added column ${col}`);
  }
}

// ---------- Backfill rows ----------
// Dry-run path: don't prepare statements that reference new columns (they
// may not exist yet). Just print the plan based on the input list.
console.log(`\nbackfill plan: ${EJECTED.length} rows`);
const now = new Date().toISOString();

if (!EXECUTE) {
  for (const e of EJECTED) {
    console.log(`  + ${e.accountId}  ${nameFromEmail(e.email).padEnd(25)} ${e.email.padEnd(40)} grp=${e.groupId} region=${regionFromEmail(e.email)}`);
  }
  console.log(`\nDry-run only — no inserts. Re-run with --execute to apply.`);
  db.close();
  process.exit(0);
}

// Execute path: migration already ran, safe to prepare statements that
// reference the new columns.
const stmtSelect = db.prepare('SELECT account_id, status FROM customer_metadata WHERE account_id = ?');
const stmtUpsert = db.prepare(`
  INSERT INTO customer_metadata
    (account_id, display_name, email, group_id, region, status, ejected_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'ejected', ?, ?, ?)
  ON CONFLICT(account_id) DO UPDATE SET
    display_name = excluded.display_name,
    email        = excluded.email,
    group_id     = excluded.group_id,
    region       = excluded.region,
    status       = 'ejected',
    ejected_at   = excluded.ejected_at,
    updated_at   = excluded.updated_at
`);

let inserted = 0, updated = 0, skipped = 0;

for (const e of EJECTED) {
  const existing = stmtSelect.get(e.accountId);
  const displayName = nameFromEmail(e.email);
  const region      = regionFromEmail(e.email);

  if (existing) {
    if (existing.status === 'ejected') { skipped++; continue; }
    console.log(`  ~ update existing metadata for ${e.accountId} → ejected (${e.email})`);
    stmtUpsert.run(e.accountId, displayName, e.email, e.groupId, region, EJECTED_AT, now, now);
    updated++;
  } else {
    console.log(`  + ${e.accountId}  ${displayName.padEnd(25)} ${e.email.padEnd(40)} grp=${e.groupId} region=${region}`);
    stmtUpsert.run(e.accountId, displayName, e.email, e.groupId, region, EJECTED_AT, now, now);
    inserted++;
  }
}

console.log(`\nresult: inserted=${inserted} updated=${updated} skipped(already ejected)=${skipped}`);
if (!EXECUTE) console.log('Re-run with --execute to apply.');
db.close();
