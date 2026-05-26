#!/usr/bin/env node
// Run this on the EC2 server from /var/www/backblaze-neocloud-demo:
//   node fix-missing-credentials.mjs
//
// Tries several approaches to get credentials for accounts whose initial
// keys were never stored: Partner API b2_create_group_member_key, then
// delete-and-recreate as a last resort.

import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ----------------------------------------------------------------
const MISSING_EMAILS = [
  'customer3-eu@neocloud-storage.com',   // LinguaNet   (group 165915)
  'customer8-west@neocloud-storage.com', // StreamVault (group 165916)
];
const B2_MASTER_KEY_ID = process.env.B2_MASTER_KEY_ID?.trim();
const B2_MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY?.trim();
const ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
const GROUP_IDS = ['165914', '165915', '165916'];

if (!B2_MASTER_KEY_ID || !B2_MASTER_APP_KEY || !ENCRYPTION_KEY) {
  console.error('Missing required env vars. Check .env for B2_MASTER_KEY_ID, B2_MASTER_APP_KEY, CREDENTIAL_ENCRYPTION_KEY');
  process.exit(1);
}

// ---- Encryption (must match server/routes/credentials.js) ------------------
function encrypt(plaintext) {
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

async function b2Post(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// ---- Authorize master -------------------------------------------------------
console.log('Authorizing master account...');
const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
  headers: { Authorization: 'Basic ' + Buffer.from(`${B2_MASTER_KEY_ID}:${B2_MASTER_APP_KEY}`).toString('base64') },
});
const auth = await authRes.json();
if (!auth.authorizationToken) {
  console.error('Auth failed:', JSON.stringify(auth, null, 2));
  process.exit(1);
}
const masterToken = auth.authorizationToken;
const masterAccountId = auth.accountId;
const apiUrl = auth.apiInfo?.storageApi?.apiUrl;
const groupsApiUrl = auth.apiInfo?.groupsApi?.groupsApiUrl;
console.log(`  accountId:    ${masterAccountId}`);
console.log(`  apiUrl:       ${apiUrl}`);
console.log(`  groupsApiUrl: ${groupsApiUrl}`);

// ---- Fetch group members ---------------------------------------------------
console.log('\nFetching group members...');
const memberByEmail = {};
for (const groupId of GROUP_IDS) {
  let startEmail = null;
  do {
    const { ok, data } = await b2Post(
      `${groupsApiUrl}/b2api/v3/b2_list_group_members`,
      masterToken,
      { adminAccountId: masterAccountId, groupId, ...(startEmail ? { startEmail } : {}) }
    );
    if (!ok || !data.groupMembers) { console.error(`  group ${groupId} error:`, data); break; }
    for (const m of data.groupMembers) {
      memberByEmail[m.email] = { accountId: m.accountId, groupId };
      console.log(`  [${groupId}] ${m.email} → ${m.accountId}`);
    }
    startEmail = data.nextEmail || null;
  } while (startEmail);
}

const missing = MISSING_EMAILS.filter(e => !memberByEmail[e]);
if (missing.length) {
  console.error('\nCould not find these emails in any group:', missing);
  process.exit(1);
}

// ---- Open DB ---------------------------------------------------------------
const dbPath = path.join(__dirname, 'server/data/app.db');
console.log(`\nOpening DB: ${dbPath}`);
const db = new Database(dbPath);

// ---- Process each missing account ------------------------------------------
for (const email of MISSING_EMAILS) {
  const { accountId, groupId } = memberByEmail[email];
  console.log(`\nProcessing ${email} (accountId=${accountId}, groupId=${groupId})...`);

  const existing = db.prepare('SELECT account_id FROM account_credentials WHERE account_id = ?').get(accountId);
  if (existing) { console.log(`  Already have credentials — skipping.`); continue; }

  let keyId, appKey;

  // ── Attempt 1: Partner API b2_create_key on groupsApiUrl -----------------
  console.log(`  Attempt 1: b2_create_key via groupsApiUrl...`);
  {
    const { ok, data } = await b2Post(
      `${groupsApiUrl}/b2api/v3/b2_create_key`,
      masterToken,
      {
        adminAccountId: masterAccountId,
        accountId,
        capabilities: ['listBuckets','listFiles','readFiles','shareFiles','writeBuckets','deleteFiles','writeFiles','listKeys','writeKeys','deleteKeys'],
        keyName: 'neocloud-control-plane',
      }
    );
    if (ok && data.applicationKeyId && data.applicationKey) {
      keyId = data.applicationKeyId;
      appKey = data.applicationKey;
      console.log(`  ✓ Key created via groupsApiUrl: ${keyId}`);
    } else {
      console.log(`  ✗ groupsApiUrl b2_create_key: ${JSON.stringify(data)}`);
    }
  }

  // ── Attempt 2: Standard b2_create_key on apiUrl (master accountId) --------
  if (!keyId) {
    console.log(`  Attempt 2: b2_create_key via apiUrl with master accountId...`);
    const { ok, data } = await b2Post(
      `${apiUrl}/b2api/v3/b2_create_key`,
      masterToken,
      {
        accountId: masterAccountId,  // create under master account as proxy
        capabilities: ['listBuckets','listFiles','readFiles'],
        keyName: `neocloud-cp-${accountId}`,
      }
    );
    console.log(`  Attempt 2 result:`, JSON.stringify(data));
    // This would create a key on the MASTER account, not useful for sub-account auth
    // Just logging — we don't use this
  }

  // ── Attempt 3: Delete group member and recreate to get fresh credentials --
  if (!keyId) {
    console.log(`  Attempt 3: Remove and recreate group member to get fresh credentials...`);

    // Get account region from DB or guess from email
    const region = email.includes('-eu@') ? 'eu-central' : 'us-west';

    // Remove from group
    const removeRes = await b2Post(
      `${groupsApiUrl}/b2api/v3/b2_remove_group_member`,
      masterToken,
      { adminAccountId: masterAccountId, groupId, memberEmail: email }
    );
    console.log(`  remove_group_member:`, removeRes.ok ? 'OK' : JSON.stringify(removeRes.data));

    if (removeRes.ok) {
      // Recreate
      const createRes = await b2Post(
        `${groupsApiUrl}/b2api/v3/b2_create_group_member`,
        masterToken,
        { adminAccountId: masterAccountId, groupId, memberEmail: email, region }
      );
      if (createRes.ok && createRes.data.applicationKeyId) {
        keyId = createRes.data.applicationKeyId;
        appKey = createRes.data.applicationKey;
        const newAccountId = createRes.data.groupMember?.accountId;
        console.log(`  ✓ Recreated: new accountId=${newAccountId}, keyId=${keyId}`);
        // Update accountId if it changed
        if (newAccountId && newAccountId !== accountId) {
          memberByEmail[email].accountId = newAccountId;
          console.log(`  ⚠ accountId changed from ${accountId} to ${newAccountId} — update seed data if needed`);
        }
      } else {
        console.log(`  ✗ create_group_member failed:`, JSON.stringify(createRes.data));
      }
    }
  }

  if (!keyId) {
    console.error(`  ✗ All attempts failed for ${email}. Manual intervention required.`);
    continue;
  }

  // ---- Store credentials ---------------------------------------------------
  const finalAccountId = memberByEmail[email].accountId;
  const encrypted = encrypt(JSON.stringify({ applicationKeyId: keyId, applicationKey: appKey }));
  db.prepare(`
    INSERT OR REPLACE INTO account_credentials (account_id, encrypted_credentials, created_at)
    VALUES (?, ?, datetime('now'))
  `).run(finalAccountId, encrypted);
  console.log(`  ✓ Stored credentials for ${email} (${finalAccountId})`);
}

// ---- Summary ---------------------------------------------------------------
console.log('\n=== Final credentials in DB ===');
const rows = db.prepare('SELECT account_id, created_at FROM account_credentials').all();
for (const r of rows) console.log(`  ${r.account_id}  (added ${r.created_at})`);
db.close();
console.log('\nDone.');
