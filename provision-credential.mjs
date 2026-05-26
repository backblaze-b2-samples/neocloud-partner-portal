#!/usr/bin/env node
// Usage:
//   node provision-credential.mjs <accountId> [region]
//
// One-shot: provisions a sub-account application key via the Partner API
// (groupsApiUrl b2_create_key) and stores it (encrypted) in account_credentials
// via the live upsertCredential helper. If credentials already exist for the
// accountId, exits without making any B2 calls.
//
// Env (from .env or shell):
//   B2_MASTER_KEY_ID, B2_MASTER_APP_KEY        — Partner master key
//   CREDENTIAL_ENCRYPTION_KEY                  — server-side encryption key
//   PROVISION_GROUP_IDS                        — comma-separated; default 165914,165915,165916
//
// Region: inferred from email (-eu@ → eu-central, -east@ → us-east, else us-west)
// unless passed as the 2nd CLI arg.

import 'dotenv/config';
import { upsertCredential, getCredential } from './server/credentials.js';

const accountId  = process.argv[2]?.trim();
const regionArg  = process.argv[3]?.trim() || null;

if (!accountId) {
  console.error('Usage: node provision-credential.mjs <accountId> [region]');
  process.exit(1);
}

const B2_MASTER_KEY_ID  = process.env.B2_MASTER_KEY_ID?.trim();
const B2_MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY?.trim();
const GROUP_IDS = (process.env.PROVISION_GROUP_IDS || '165914,165915,165916')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!B2_MASTER_KEY_ID || !B2_MASTER_APP_KEY) {
  console.error('Missing B2_MASTER_KEY_ID or B2_MASTER_APP_KEY in env (.env)');
  process.exit(1);
}
if (!process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()) {
  console.error('Missing CREDENTIAL_ENCRYPTION_KEY in env (.env)');
  process.exit(1);
}

if (getCredential(accountId)) {
  console.log(`Credentials already exist for ${accountId}. Nothing to do.`);
  process.exit(0);
}

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

console.log(`\nSearching groups ${GROUP_IDS.join(', ')} for accountId ${accountId}...`);
let memberMatch = null;
for (const groupId of GROUP_IDS) {
  let startEmail = null;
  do {
    const r = await fetch(`${groupsApiUrl}/b2api/v3/b2_list_group_members`, {
      method: 'POST',
      headers: { Authorization: masterToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminAccountId: masterAccountId, groupId, ...(startEmail ? { startEmail } : {}) }),
    });
    const data = await r.json();
    if (!r.ok || !data.groupMembers) {
      console.error(`  group ${groupId}: ${JSON.stringify(data)}`);
      break;
    }
    const found = data.groupMembers.find((m) => m.accountId === accountId);
    if (found) { memberMatch = { ...found, groupId }; break; }
    startEmail = data.nextEmail || null;
  } while (startEmail);
  if (memberMatch) break;
}

if (!memberMatch) {
  console.error(`\nAccount ${accountId} not found in any of groups: ${GROUP_IDS.join(', ')}`);
  console.error('Adjust PROVISION_GROUP_IDS env var if the customer is in a different group.');
  process.exit(1);
}
console.log(`  Found: email=${memberMatch.email}, groupId=${memberMatch.groupId}`);

// Try multiple shapes — Backblaze's Partner b2_create_key has shifted across
// versions and the docs lag behind the live API.
const capabilities = [
  'listBuckets', 'readBuckets', 'writeBuckets', 'deleteBuckets',
  'listFiles', 'readFiles', 'writeFiles', 'deleteFiles', 'shareFiles',
  'listKeys', 'writeKeys', 'deleteKeys',
];
const attempts = [
  { label: 'groupsApiUrl b2_create_key { accountId, capabilities, keyName }',
    url:   `${groupsApiUrl}/b2api/v3/b2_create_key`,
    body:  { accountId, capabilities, keyName: 'neocloud-control-plane' } },
  { label: 'groupsApiUrl b2_create_key { accountId, capabilities, keyName } v4',
    url:   `${groupsApiUrl}/b2api/v4/b2_create_key`,
    body:  { accountId, capabilities, keyName: 'neocloud-control-plane' } },
  { label: 'master apiUrl b2_create_key { accountId (sub), capabilities, keyName }',
    url:   `${auth.apiInfo?.storageApi?.apiUrl}/b2api/v3/b2_create_key`,
    body:  { accountId, capabilities, keyName: 'neocloud-control-plane' } },
];

let keyData = null;
for (const a of attempts) {
  console.log(`\nAttempt: ${a.label}`);
  const r = await fetch(a.url, {
    method: 'POST',
    headers: { Authorization: masterToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(a.body),
  });
  const data = await r.json();
  if (r.ok && data.applicationKeyId && data.applicationKey) {
    console.log(`  Key created: ${data.applicationKeyId}`);
    keyData = data;
    break;
  }
  console.log(`  ${r.status}: ${JSON.stringify(data)}`);
}
if (!keyData) {
  console.error('\nAll b2_create_key attempts failed.');
  process.exit(1);
}

let region = regionArg;
if (!region) {
  const email = memberMatch.email || '';
  region = email.includes('-eu@')   ? 'eu-central'
         : email.includes('-east@') ? 'us-east'
         : 'us-west';
  console.log(`  Region inferred from email: ${region}`);
} else {
  console.log(`  Region (from CLI): ${region}`);
}

console.log('\nStoring in account_credentials...');
const saved = upsertCredential({
  accountId,
  email:    memberMatch.email,
  groupId:  memberMatch.groupId,
  region,
  applicationKeyId: keyData.applicationKeyId,
  applicationKey:   keyData.applicationKey,
});
console.log(`  Stored. id=${saved.id} account_id=${saved.account_id} email=${saved.email} group_id=${saved.group_id} region=${saved.region}`);
console.log('\nDone.');
