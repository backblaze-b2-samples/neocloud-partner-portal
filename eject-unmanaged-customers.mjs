#!/usr/bin/env node
// Usage:
//   node eject-unmanaged-customers.mjs              # dry-run (default), prints plan only
//   node eject-unmanaged-customers.mjs --execute    # actually eject + clean metadata
//
// Lists every Partner group member, cross-references account_credentials in
// the local SQLite DB, and ejects any member that has NO stored credentials
// (since they can't be operated on per-customer anyway — every list/create
// call against them fails with "no_credentials"). Also deletes any
// customer_metadata rows tied to ejected accountIds.
//
// IMPORTANT: Ejection is one-way per Partner API docs. Once ejected, the
// email CANNOT be re-added via API. There is no undo.
//
// Env (from .env):
//   B2_MASTER_KEY_ID, B2_MASTER_APP_KEY    — Partner master key
//   PROVISION_GROUP_IDS                    — comma-separated; default 165914,165915,165916

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const EXECUTE = process.argv.includes('--execute');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const B2_MASTER_KEY_ID  = process.env.B2_MASTER_KEY_ID?.trim();
const B2_MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY?.trim();
const GROUP_IDS = (process.env.PROVISION_GROUP_IDS || '165914,165915,165916')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!B2_MASTER_KEY_ID || !B2_MASTER_APP_KEY) {
  console.error('Missing B2_MASTER_KEY_ID or B2_MASTER_APP_KEY in env (.env)');
  process.exit(1);
}

console.log(`Mode: ${EXECUTE ? '*** EXECUTE *** (ejections will happen)' : 'DRY-RUN (no changes)'}`);
console.log();

// ---- Auth master ----------------------------------------------------------
console.log('Authorizing master account...');
const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
  headers: { Authorization: 'Basic ' + Buffer.from(`${B2_MASTER_KEY_ID}:${B2_MASTER_APP_KEY}`).toString('base64') },
});
const auth = await authRes.json();
if (!auth.authorizationToken) {
  console.error('Master auth failed:', JSON.stringify(auth, null, 2));
  process.exit(1);
}
const masterToken     = auth.authorizationToken;
const masterAccountId = auth.accountId;
const groupsApiUrl    = auth.apiInfo?.groupsApi?.groupsApiUrl;
if (!groupsApiUrl) {
  console.error('No groupsApiUrl on master auth — Partner program enrollment required.');
  process.exit(1);
}
console.log(`  masterAccountId: ${masterAccountId}`);
console.log(`  groupsApiUrl:    ${groupsApiUrl}`);

// ---- Pull every group member ---------------------------------------------
console.log(`\nFetching members from groups ${GROUP_IDS.join(', ')}...`);
const allMembers = [];
for (const groupId of GROUP_IDS) {
  let startEmail = null;
  do {
    const r = await fetch(`${groupsApiUrl}/b2api/v3/b2_list_group_members`, {
      method: 'POST',
      headers: { Authorization: masterToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminAccountId: masterAccountId,
        groupId,
        maxMemberCount: 100,
        ...(startEmail ? { startEmail } : {}),
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.groupMembers) {
      console.error(`  group ${groupId}: ${JSON.stringify(data)}`);
      break;
    }
    for (const m of data.groupMembers) {
      allMembers.push({ ...m, groupId });
    }
    startEmail = data.nextEmail || null;
  } while (startEmail);
}
console.log(`  total members across all groups: ${allMembers.length}`);

// ---- Cross-reference with account_credentials ----------------------------
const dbPath = path.join(__dirname, 'server/data/app.db');
const db = new Database(dbPath, { readonly: !EXECUTE });
const storedIds = new Set(
  db.prepare('SELECT account_id FROM account_credentials').all().map((r) => r.account_id),
);
console.log(`  members with stored credentials: ${storedIds.size}`);

const keep   = allMembers.filter((m) => storedIds.has(m.accountId));
const ejects = allMembers.filter((m) => !storedIds.has(m.accountId));

console.log(`\n=== KEEP (${keep.length}) — has stored credentials ===`);
for (const m of keep) console.log(`  ${m.accountId}  ${m.email}  grp=${m.groupId}`);

console.log(`\n=== TO EJECT (${ejects.length}) — no stored credentials ===`);
for (const m of ejects) console.log(`  ${m.accountId}  ${m.email}  grp=${m.groupId}`);

if (!EXECUTE) {
  console.log('\nDry-run complete. Re-run with --execute to actually eject the above.');
  console.log('REMINDER: ejection is one-way. Email addresses cannot be re-added via API.');
  db.close();
  process.exit(0);
}

// ---- Execute ejections ---------------------------------------------------
console.log(`\nExecuting ${ejects.length} ejections...`);
const ejectedAccountIds = [];
let ok = 0, fail = 0;
for (const m of ejects) {
  process.stdout.write(`  eject ${m.accountId} (${m.email})... `);
  try {
    const r = await fetch(`${groupsApiUrl}/b2api/v3/b2_eject_group_member`, {
      method: 'POST',
      headers: { Authorization: masterToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminAccountId:  masterAccountId,
        groupId:         m.groupId,
        memberAccountId: m.accountId,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log(`FAIL ${r.status} ${JSON.stringify(data)}`);
      fail++;
      continue;
    }
    console.log('OK');
    ejectedAccountIds.push(m.accountId);
    ok++;
  } catch (e) {
    console.log(`ERROR ${e.message}`);
    fail++;
  }
}

// ---- Clean up customer_metadata orphans ----------------------------------
if (ejectedAccountIds.length) {
  console.log(`\nDeleting customer_metadata rows for ${ejectedAccountIds.length} ejected accountIds...`);
  const stmt = db.prepare('DELETE FROM customer_metadata WHERE account_id = ?');
  let metaDeleted = 0;
  for (const id of ejectedAccountIds) {
    const info = stmt.run(id);
    metaDeleted += info.changes;
  }
  console.log(`  ${metaDeleted} customer_metadata row(s) deleted`);
}

db.close();
console.log(`\nDone. ${ok} ejected, ${fail} failed.`);
