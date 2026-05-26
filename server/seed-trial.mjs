// =============================================================================
// seed-trial.mjs — Trial seeding script for NeoCloud B2 demo environment.
//
// Creates 2 accounts per group (6 total), then for each account:
//   • Creates buckets (private/public, SSE-B2, Object Lock, lifecycle rules)
//   • Uploads realistic synthetic files (small + large multipart)
//   • Creates scoped application keys
//   • Stores credentials encrypted in the app database
//
// Usage (run from project root on EC2):
//   node server/seed-trial.mjs             # live run
//   node server/seed-trial.mjs --dry-run   # preview, no API calls made
//
// Required env vars (loaded from .env automatically):
//   B2_MASTER_KEY_ID           Master application key ID
//   B2_MASTER_APP_KEY          Master application key
//   CREDENTIAL_ENCRYPTION_KEY  Key for encrypting stored credentials
// =============================================================================

import 'dotenv/config';
import crypto from 'node:crypto';
import { upsertCredential } from './credentials.js';
import { db } from './db.js';

const DRY_RUN  = process.argv.includes('--dry-run');
const SEEDED_AT = new Date().toISOString();

// ─── Validate env ─────────────────────────────────────────────────────────────

const MASTER_KEY_ID  = process.env.B2_MASTER_KEY_ID;
const MASTER_APP_KEY = process.env.B2_MASTER_APP_KEY;
const ENC_KEY_HEX    = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!MASTER_KEY_ID || !MASTER_APP_KEY) {
  console.error('ERROR: B2_MASTER_KEY_ID and B2_MASTER_APP_KEY must be set in .env');
  process.exit(1);
}
if (!ENC_KEY_HEX) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set in .env');
  process.exit(1);
}

// ─── Credential fallback (for accounts that already exist in B2) ──────────────
// Mirrors the decryption logic in seed-data.mjs exactly.

const ENC_KEY = crypto.createHash('sha256').update(ENC_KEY_HEX, 'utf8').digest();

function loadStoredCredential(email) {
  const row = db.prepare('SELECT * FROM account_credentials WHERE email = ?').get(email);
  if (!row) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(row.key_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.key_tag, 'base64'));
  const applicationKey = Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_application_key, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return {
    accountId:        row.account_id,
    applicationKeyId: row.application_key_id,
    applicationKey,
  };
}

// ─── Trial account definitions ────────────────────────────────────────────────

const ACCOUNTS = [
  // ── Internal / IT ──────────────────────────────────────────────────────────
  {
    email:       'marcus.brennan@neocloud-storage.com',
    groupId:     '165914',
    groupName:   'Internal / IT',
    region:      'us-west',
    shortCode:   'int-brennan',
    type:        'internal',
    subType:     'backup',
  },
  {
    email:       'wei.tanaka@neocloud-storage.com',
    groupId:     '165914',
    groupName:   'Internal / IT',
    region:      'us-east',
    shortCode:   'int-tanaka',
    type:        'internal',
    subType:     'infra',
  },
  // ── AI Customers ───────────────────────────────────────────────────────────
  {
    email:       'mira.delgado@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c1',
    type:        'ai',
    displayName: 'VectorMind AI',
  },
  {
    email:       'tomas.engman@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c3',
    type:        'ai',
    displayName: 'LinguaNet',
  },
  // ── AI Customers (c4 – c43) ────────────────────────────────────────────────
  {
    email:       'leah.zhou@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c4',
    type:        'ai',
    displayName: 'NeuralDrift',
  },
  {
    email:       'arjun.kapoor@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c5',
    type:        'ai',
    displayName: 'SynthAI',
  },
  {
    email:       'katja.holm@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c6',
    type:        'ai',
    displayName: 'DataNeural',
  },
  {
    email:       'eun.park@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c7',
    type:        'ai',
    displayName: 'VectorEdge',
  },
  {
    email:       'zara.adebayo@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c8',
    type:        'ai',
    displayName: 'DeepSynth',
  },
  {
    email:       'diego.alvarez@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c9',
    type:        'ai',
    displayName: 'ModelBridge',
  },
  {
    email:       'freya.steiner@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c10',
    type:        'ai',
    displayName: 'CortexLabs',
  },
  {
    email:       'rohan.shetty@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c11',
    type:        'ai',
    displayName: 'NovaMind',
  },
  {
    email:       'alma.castro@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c12',
    type:        'ai',
    displayName: 'TensorPath',
  },
  {
    email:       'kenji.sato@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c13',
    type:        'ai',
    displayName: 'AIMatrix',
  },
  {
    email:       'elsa.klein@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c14',
    type:        'ai',
    displayName: 'AlphaLearn',
  },
  {
    email:       'kofi.mensah@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c15',
    type:        'ai',
    displayName: 'PulseAI',
  },
  {
    email:       'aleksei.volkov@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c16',
    type:        'ai',
    displayName: 'InferEdge',
  },
  {
    email:       'tarek.khalil@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c17',
    type:        'ai',
    displayName: 'SynapticLab',
  },
  {
    email:       'manon.leclerc@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c18',
    type:        'ai',
    displayName: 'NeuralStack',
  },
  {
    email:       'ming.zhao@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c19',
    type:        'ai',
    displayName: 'FlowML',
  },
  {
    email:       'divya.iyer@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c20',
    type:        'ai',
    displayName: 'QuantumML',
  },
  {
    email:       'kwame.boateng@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c21',
    type:        'ai',
    displayName: 'DeepVector',
  },
  {
    email:       'lina.bergman@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c22',
    type:        'ai',
    displayName: 'EuroML',
  },
  {
    email:       'julian.rojas@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c23',
    type:        'ai',
    displayName: 'AxisNeural',
  },
  {
    email:       'mei.wang@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c24',
    type:        'ai',
    displayName: 'ModelForge',
  },
  {
    email:       'owen.kelly@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c25',
    type:        'ai',
    displayName: 'CognexAI',
  },
  {
    email:       'niamh.byrne@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c26',
    type:        'ai',
    displayName: 'SentinelAI',
  },
  {
    email:       'han.li@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c27',
    type:        'ai',
    displayName: 'TensorScale',
  },
  {
    email:       'akira.fujimoto@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c28',
    type:        'ai',
    displayName: 'NeuralBytes',
  },
  {
    email:       'dmitri.sokolov@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c29',
    type:        'ai',
    displayName: 'FeatureLab',
  },
  {
    email:       'mai.nguyen@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c30',
    type:        'ai',
    displayName: 'EvoNeural',
  },
  {
    email:       'tobias.lind@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c31',
    type:        'ai',
    displayName: 'SignalForge',
  },
  {
    email:       'matias.oliveira@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c32',
    type:        'ai',
    displayName: 'InferCore',
  },
  {
    email:       'ananya.shah@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c33',
    type:        'ai',
    displayName: 'NovaCortex',
  },
  {
    email:       'tal.weiss@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c34',
    type:        'ai',
    displayName: 'CognifyLabs',
  },
  {
    email:       'henrik.lundqvist@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c35',
    type:        'ai',
    displayName: 'NeuralPath',
  },
  {
    email:       'jana.kovacic@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c36',
    type:        'ai',
    displayName: 'DataForge',
  },
  {
    email:       'liam.donovan@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c37',
    type:        'ai',
    displayName: 'SynapseML',
  },
  {
    email:       'giulia.romano@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c38',
    type:        'ai',
    displayName: 'FluxAI',
  },
  {
    email:       'otieno.kamau@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c39',
    type:        'ai',
    displayName: 'VectorStack',
  },
  {
    email:       'jiwoo.han@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c40',
    type:        'ai',
    displayName: 'DeepForge',
  },
  {
    email:       'matteo.bianchi@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'eu-central',
    shortCode:   'c41',
    type:        'ai',
    displayName: 'ItalAI',
  },
  {
    email:       'eva.vandenberg@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-west',
    shortCode:   'c42',
    type:        'ai',
    displayName: 'ModelPilot',
  },
  {
    email:       'ethan.ward@neocloud-storage.com',
    groupId:     '165915',
    groupName:   'AI Customers',
    region:      'us-east',
    shortCode:   'c43',
    type:        'ai',
    displayName: 'PromptBase',
  },
  // ── SaaS Customers ─────────────────────────────────────────────────────────
  {
    email:       'noah.hayes@neocloud-storage.com',
    groupId:     '165916',
    groupName:   'SaaS Customers',
    region:      'us-west',
    shortCode:   'c8',
    type:        'saas',
    displayName: 'StreamVault',
  },
  {
    email:       'silke.ackermann@neocloud-storage.com',
    groupId:     '165916',
    groupName:   'SaaS Customers',
    region:      'eu-central',
    shortCode:   'c11',
    type:        'saas',
    displayName: 'MediVault',
  },
];

// ─── Bucket + file definitions ────────────────────────────────────────────────

function regionAbbrev(region) {
  return region === 'us-west' ? 'west' : region === 'us-east' ? 'east' : 'eu';
}

function getBucketDefs(account) {
  const { shortCode, type, subType, region } = account;
  const r = regionAbbrev(region);

  // ── Internal / Backup ──────────────────────────────────────────────────────
  if (type === 'internal' && subType === 'backup') return [
    {
      name:       `nc-${shortCode}-sysbackups-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      objectLock: true,
      lifecycle:  [{ fileNamePrefix: 'backups/daily/', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 180 }],
      files: [
        {
          path: 'manifests/restore-point-2026-05-07.json',
          content: JSON.stringify({ createdAt: SEEDED_AT, type: 'full', sourceHost: 'prod-app-01', sizeBytes: 53687091200, checksum: crypto.randomBytes(20).toString('hex') }, null, 2),
          contentType: 'application/json',
        },
        {
          path: 'backups/incremental/2026-05-07/delta.tar.gz',
          content: crypto.randomBytes(2048),
          contentType: 'application/gzip',
        },
      ],
      largeFiles: [
        { path: 'backups/daily/2026-05-07/system-full.tar.gz', contentType: 'application/gzip' },
      ],
    },
    {
      name:       `nc-${shortCode}-manifests-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      files: [
        {
          path: 'manifests/restore-point-2026-05-06.json',
          content: JSON.stringify({ createdAt: '2026-05-06T02:00:00Z', type: 'full', status: 'verified', sizeBytes: 52613349376 }, null, 2),
          contentType: 'application/json',
        },
        {
          path: 'compliance/gdpr-report-2026-q1.txt',
          content: 'GDPR Compliance Report — Q1 2026\nStatus: COMPLIANT\nReviewed: 2026-05-01\nRetention policy: active\n',
          contentType: 'text/plain',
        },
      ],
    },
  ];

  // ── Internal / Infra ───────────────────────────────────────────────────────
  if (type === 'internal' && subType === 'infra') return [
    {
      name:       `nc-${shortCode}-infra-configs-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      lifecycle:  [],
      // Upload same file twice to demonstrate versioning
      files: [
        {
          path: 'configs/network-topology.json',
          content: JSON.stringify({ version: '1.0', updated: '2026-04-01T00:00:00Z', subnets: ['10.0.1.0/24', '10.0.2.0/24'], region }, null, 2),
          contentType: 'application/json',
        },
        {
          path: 'configs/network-topology.json',  // same name → creates v2
          content: JSON.stringify({ version: '1.1', updated: SEEDED_AT, subnets: ['10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24'], region }, null, 2),
          contentType: 'application/json',
        },
        {
          path: 'configs/load-balancer.json',
          content: JSON.stringify({ algorithm: 'round-robin', healthCheck: '/health', timeoutSec: 30, backends: ['10.0.1.10', '10.0.1.11'] }, null, 2),
          contentType: 'application/json',
        },
      ],
    },
    {
      name:       `nc-${shortCode}-deploy-artifacts-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      lifecycle:  [{ fileNamePrefix: 'releases/', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 90 }],
      files: [
        {
          path: 'releases/v1.2.3/manifest.json',
          content: JSON.stringify({ version: '1.2.3', builtAt: SEEDED_AT, sha256: crypto.randomBytes(32).toString('hex'), artifacts: ['app.tar.gz', 'checksums.sha256'] }, null, 2),
          contentType: 'application/json',
        },
        {
          path: 'releases/v1.2.3/checksums.sha256',
          content: `${crypto.randomBytes(32).toString('hex')}  app.tar.gz\n${crypto.randomBytes(32).toString('hex')}  config.tar.gz\n`,
          contentType: 'text/plain',
        },
      ],
    },
  ];

  // ── AI Customers ───────────────────────────────────────────────────────────
  if (type === 'ai') {
    const buckets = [
      {
        name:       `nc-${shortCode}-datasets-${r}`,
        bucketType: 'allPrivate',
        sse:        true,
        lifecycle:  [{ fileNamePrefix: 'datasets/raw/', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 7 }],
        files: [
          {
            path: 'datasets/raw/training-batch-001.csv',
            content: 'id,feature1,feature2,feature3,label\n1,0.82,0.34,0.71,1\n2,0.21,0.94,0.13,0\n3,0.67,0.51,0.88,1\n4,0.45,0.23,0.56,0\n',
            contentType: 'text/csv',
          },
          {
            path: 'datasets/raw/training-batch-002.csv',
            content: 'id,feature1,feature2,feature3,label\n5,0.91,0.22,0.44,1\n6,0.58,0.63,0.29,1\n7,0.33,0.87,0.95,0\n8,0.76,0.41,0.62,1\n',
            contentType: 'text/csv',
          },
          {
            path: 'datasets/processed/features-v1.json',
            content: JSON.stringify({ version: 1, dimensions: 128, sampleCount: 50000, createdAt: SEEDED_AT, source: 'training-batch-001,training-batch-002' }, null, 2),
            contentType: 'application/json',
          },
        ],
      },
      {
        name:       `nc-${shortCode}-checkpoints-${r}`,
        bucketType: 'allPrivate',
        sse:        true,
        files: [
          {
            path: 'checkpoints/epoch-001/config.json',
            content: JSON.stringify({ epoch: 1, trainLoss: 0.8821, valLoss: 0.9104, accuracy: 0.6234, learningRate: 0.001, timestamp: SEEDED_AT }, null, 2),
            contentType: 'application/json',
          },
          {
            path: 'checkpoints/epoch-010/config.json',
            content: JSON.stringify({ epoch: 10, trainLoss: 0.2341, valLoss: 0.2519, accuracy: 0.9112, learningRate: 0.0001, timestamp: SEEDED_AT }, null, 2),
            contentType: 'application/json',
          },
          {
            path: 'checkpoints/epoch-010/config.json',  // v2 — demonstrates versioning
            content: JSON.stringify({ epoch: 10, trainLoss: 0.2201, valLoss: 0.2380, accuracy: 0.9187, learningRate: 0.0001, note: 'best checkpoint', timestamp: SEEDED_AT }, null, 2),
            contentType: 'application/json',
          },
        ],
      },
      {
        name:       `nc-${shortCode}-public-demos-${r}`,
        bucketType: 'allPublic',
        sse:        false,
        files: [
          {
            path: 'demos/sample-inference.json',
            content: JSON.stringify({ model: 'v1.0', input: 'The quick brown fox jumps', embedding: Array.from({ length: 8 }, () => +Math.random().toFixed(6)), latencyMs: 12, tokens: 6 }, null, 2),
            contentType: 'application/json',
          },
          {
            path: 'demos/readme.txt',
            content: `NeoCloud B2 Demo — Public Assets\nCustomer: ${account.displayName || shortCode}\nRegion: ${region}\nSeeded: ${SEEDED_AT}\n`,
            contentType: 'text/plain',
          },
        ],
      },
    ];

    // LinguaNet gets an extra embeddings bucket with Object Lock
    if (shortCode === 'c3') {
      buckets.splice(1, 0, {
        name:       `nc-${shortCode}-embeddings-${r}`,
        bucketType: 'allPrivate',
        sse:        true,
        objectLock: true,
        files: [
          {
            path: 'embeddings/sentence-v3-sample.bin',
            content: crypto.randomBytes(4096),
            contentType: 'application/octet-stream',
          },
          {
            path: 'embeddings/metadata.json',
            content: JSON.stringify({ model: 'sentence-transformer-v3', dimensions: 768, vectorCount: 1000000, createdAt: SEEDED_AT, license: 'proprietary' }, null, 2),
            contentType: 'application/json',
          },
        ],
      });
    }

    return buckets;
  }

  // ── SaaS Customers ─────────────────────────────────────────────────────────
  if (type === 'saas') return [
    {
      name:       `nc-${shortCode}-uploads-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      lifecycle:  [{ fileNamePrefix: '', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 30 }],
      files: [
        {
          path: 'uploads/images/product-001.jpg',
          content: crypto.randomBytes(1024),
          contentType: 'image/jpeg',
        },
        {
          path: 'uploads/images/product-002.jpg',
          content: crypto.randomBytes(1024),
          contentType: 'image/jpeg',
        },
        {
          path: 'uploads/documents/invoice-2026-001.pdf',
          content: crypto.randomBytes(2048),
          contentType: 'application/pdf',
        },
        {
          path: 'logs/2026/05/07/access.log',
          content: [
            `[${SEEDED_AT}] GET /api/v1/products 200 42ms user-agent=demo`,
            `[${SEEDED_AT}] POST /api/v1/orders 201 87ms user-agent=demo`,
            `[${SEEDED_AT}] GET /api/v1/users/123 200 15ms user-agent=demo`,
          ].join('\n') + '\n',
          contentType: 'text/plain',
        },
      ],
    },
    {
      name:       `nc-${shortCode}-assets-${r}`,
      bucketType: 'allPublic',
      sse:        false,
      files: [
        {
          path: 'assets/logo.png',
          content: crypto.randomBytes(512),
          contentType: 'image/png',
        },
        {
          path: 'assets/banner.jpg',
          content: crypto.randomBytes(1024),
          contentType: 'image/jpeg',
        },
        {
          path: 'assets/app.css',
          content: `/* ${account.displayName || shortCode} — NeoCloud demo */\nbody { font-family: sans-serif; margin: 0; }\n`,
          contentType: 'text/css',
        },
      ],
    },
    {
      name:       `nc-${shortCode}-audit-logs-${r}`,
      bucketType: 'allPrivate',
      sse:        true,
      objectLock: true,
      files: [
        {
          path: 'audit/2026/05/07/events.log',
          content: [
            `[${SEEDED_AT}] user:u123 action:login ip:203.0.113.1 result:success`,
            `[${SEEDED_AT}] user:u123 action:view_record resource:r456 result:success`,
            `[${SEEDED_AT}] user:u456 action:export resource:report-q1 result:success`,
          ].join('\n') + '\n',
          contentType: 'text/plain',
        },
        {
          path: 'audit/2026/05/06/events.log',
          content: `[2026-05-06T09:00:00Z] user:admin action:config_change details:retention_policy_updated result:success\n`,
          contentType: 'text/plain',
        },
      ],
    },
  ];

  return [];
}

function getKeyDefs(account, createdBuckets) {
  const { shortCode, region } = account;
  const r = regionAbbrev(region);

  const keys = [
    {
      name:         `nc-key-${shortCode}-${r}-readonly`,
      capabilities: ['listBuckets', 'listFiles', 'readFiles'],
    },
    {
      name:         `nc-key-${shortCode}-${r}-full`,
      capabilities: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'deleteFiles'],
    },
  ];

  // Bucket-scoped write-only key for the primary data bucket
  const primary = createdBuckets.find(b =>
    b.name.includes('datasets') || b.name.includes('uploads') || b.name.includes('sysbackups')
  );
  if (primary?.bucketId) {
    keys.push({
      name:         `nc-key-${shortCode}-${r}-write-${primary.name.split('-')[3] ?? 'data'}`,
      capabilities: ['listFiles', 'writeFiles'],
      bucketId:     primary.bucketId,
    });
  }

  return keys;
}

// ─── B2 API helpers ───────────────────────────────────────────────────────────

async function b2Authorize(keyId, appKey) {
  const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`b2_authorize_account: ${data.message ?? res.status}`);
  return {
    authToken:    data.authorizationToken,
    apiUrl:       data.apiInfo.storageApi.apiUrl,
    groupsApiUrl: data.apiInfo.groupsApi?.groupsApiUrl,
    accountId:    data.accountId,
  };
}

async function b2Post(apiUrl, authToken, endpoint, body) {
  const res = await fetch(`${apiUrl}/b2api/v3/${endpoint}`, {
    method:  'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${endpoint}: ${data.message ?? res.status}`);
  return data;
}

function sha1hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function encodeBzFileName(name) {
  // B2 requires percent-encoding of most chars except / and a safe set
  return name.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

async function uploadSmallFile(uploadUrl, uploadAuthToken, fileName, content, contentType, extraMeta = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const metaHeaders = Object.fromEntries(
    Object.entries(extraMeta).map(([k, v]) => [`X-Bz-Info-${k}`, encodeURIComponent(String(v))])
  );
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:       uploadAuthToken,
      'X-Bz-File-Name':    encodeBzFileName(fileName),
      'Content-Type':      contentType,
      'Content-Length':    String(buf.length),
      'X-Bz-Content-Sha1': sha1hex(buf),
      'X-Bz-Info-environment': 'demo',
      'X-Bz-Info-seeded-at':   encodeURIComponent(SEEDED_AT),
      ...metaHeaders,
    },
    body: buf,
    // Node's native fetch buffers the body; duplex not needed for Buffer
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`b2_upload_file (${fileName}): ${data.message ?? res.status}`);
  return data;
}

async function uploadLargeFile(apiUrl, authToken, bucketId, fileName, contentType, totalSizeBytes) {
  const MIN_PART = 5 * 1024 * 1024; // 5 MB minimum per B2 spec

  // Start
  const started = await b2Post(apiUrl, authToken, 'b2_start_large_file', {
    bucketId,
    fileName,
    contentType,
    fileInfo: {
      'src_last_modified_millis': String(Date.now()),
    },
  });

  const partSha1Array = [];
  let remaining = totalSizeBytes;
  let partNumber = 1;

  while (remaining > 0) {
    const partSize = Math.min(MIN_PART, remaining);
    const partBuf  = crypto.randomBytes(partSize);

    const partUrlData = await b2Post(apiUrl, authToken, 'b2_get_upload_part_url', {
      fileId: started.fileId,
    });

    const res = await fetch(partUrlData.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization:       partUrlData.authorizationToken,
        'X-Bz-Part-Number':  String(partNumber),
        'Content-Length':    String(partSize),
        'X-Bz-Content-Sha1': sha1hex(partBuf),
      },
      body: partBuf,
    });
    const partData = await res.json();
    if (!res.ok) throw new Error(`b2_upload_part ${partNumber}: ${partData.message ?? res.status}`);

    partSha1Array.push(sha1hex(partBuf));
    remaining -= partSize;
    partNumber++;
  }

  return await b2Post(apiUrl, authToken, 'b2_finish_large_file', {
    fileId:       started.fileId,
    partSha1Array,
  });
}

// ─── Per-account seeding ──────────────────────────────────────────────────────

async function seedAccount(masterAuth, account) {
  const tag = `[${account.email}]`;
  console.log(`\n${tag}`);

  if (DRY_RUN) {
    console.log(`  DRY-RUN: b2_create_group_member → groupId:${account.groupId} region:${account.region}`);
    const defs = getBucketDefs(account);
    for (const b of defs) {
      const flags = [b.bucketType, b.sse && 'SSE-B2', b.objectLock && 'ObjectLock'].filter(Boolean).join(', ');
      console.log(`  DRY-RUN: bucket ${b.name} (${flags})`);
      if (b.lifecycle?.length) console.log(`           lifecycle: ${JSON.stringify(b.lifecycle[0])}`);
      for (const f of b.files ?? [])      console.log(`           file: ${f.path}`);
      for (const f of b.largeFiles ?? []) console.log(`           large-file: ${f.path}`);
    }
    return;
  }

  // 1 ── Create group member (or fall back to stored credentials if already exists)
  let applicationKeyId, applicationKey;
  try {
    const res = await fetch(`${masterAuth.groupsApiUrl}/b2api/v3/b2_create_group_member`, {
      method:  'POST',
      headers: { Authorization: masterAuth.authToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        adminAccountId: masterAuth.accountId,
        groupId:        account.groupId,
        memberEmail:    account.email,
        region:         account.region,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message ?? res.status);
    applicationKeyId = data.applicationKeyId;
    applicationKey   = data.applicationKey;
    console.log(`  ✓ Account created  accountId:${data.groupMember.accountId}`);

    // Store credentials immediately (encrypted at rest)
    try {
      upsertCredential({
        accountId:        data.groupMember.accountId,
        email:            account.email,
        groupId:          account.groupId,
        region:           account.region,
        applicationKeyId: data.applicationKeyId,
        applicationKey:   data.applicationKey,
      });
      console.log(`  ✓ Credentials stored (AES-256-GCM)`);
    } catch (credErr) {
      console.error(`  ✗ Credential storage failed: ${credErr.message}`);
    }
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      // Account was created in a previous run — load keys from DB and continue
      const stored = loadStoredCredential(account.email);
      if (!stored) {
        console.error(`  ✗ Account already exists but no credentials found in DB — skipping`);
        return;
      }
      applicationKeyId = stored.applicationKeyId;
      applicationKey   = stored.applicationKey;
      console.log(`  ↩ Account already exists — resuming with stored credentials`);
    } else {
      console.error(`  ✗ b2_create_group_member failed: ${err.message}`);
      return;
    }
  }

  // 2 ── Authorize sub-account
  let sub;
  try {
    sub = await b2Authorize(applicationKeyId, applicationKey);
    console.log(`  ✓ Sub-account authorized`);
  } catch (err) {
    console.error(`  ✗ Sub-account auth failed: ${err.message}`);
    return;
  }

  // 4 ── Create buckets
  const bucketDefs  = getBucketDefs(account);
  const createdBuckets = [];

  for (const def of bucketDefs) {
    try {
      const body = {
        accountId:  sub.accountId,
        bucketName: def.name,
        bucketType: def.bucketType,
      };
      if (def.sse) {
        body.defaultServerSideEncryption = { mode: 'SSE-B2', algorithm: 'AES256' };
      }
      if (def.objectLock) {
        body.fileLockEnabled = true;
      }

      const bucket = await b2Post(sub.apiUrl, sub.authToken, 'b2_create_bucket', body);
      def.bucketId = bucket.bucketId;
      createdBuckets.push(def);

      const flags = [def.bucketType, def.sse && 'SSE-B2', def.objectLock && 'ObjectLock'].filter(Boolean).join(', ');
      console.log(`  ✓ Bucket  ${def.name}  (${flags})`);

      // Apply lifecycle rules
      if (def.lifecycle?.length) {
        await b2Post(sub.apiUrl, sub.authToken, 'b2_update_bucket', {
          accountId:      sub.accountId,
          bucketId:       def.bucketId,
          lifecycleRules: def.lifecycle,
        });
        console.log(`         lifecycle applied`);
      }
    } catch (err) {
      console.error(`  ✗ Bucket ${def.name}: ${err.message}`);
    }
  }

  // 5 ── Upload files
  for (const def of createdBuckets) {
    const allFiles    = def.files    ?? [];
    const largeFiles  = def.largeFiles ?? [];
    if (!allFiles.length && !largeFiles.length) continue;

    let uploadUrlData;
    try {
      uploadUrlData = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId: def.bucketId });
    } catch (err) {
      console.error(`  ✗ get_upload_url for ${def.name}: ${err.message}`);
      continue;
    }

    for (const file of allFiles) {
      try {
        await uploadSmallFile(
          uploadUrlData.uploadUrl,
          uploadUrlData.authorizationToken,
          file.path,
          file.content,
          file.contentType,
          { customer: account.shortCode },
        );
        console.log(`         ↑ ${file.path}`);
      } catch (err) {
        // Upload URLs expire — refresh once and retry
        if (/expired|bad_auth/i.test(err.message)) {
          try {
            uploadUrlData = await b2Post(sub.apiUrl, sub.authToken, 'b2_get_upload_url', { bucketId: def.bucketId });
            await uploadSmallFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, file.path, file.content, file.contentType, { customer: account.shortCode });
            console.log(`         ↑ ${file.path} (retried)`);
          } catch (err2) {
            console.error(`  ✗ Upload ${file.path}: ${err2.message}`);
          }
        } else {
          console.error(`  ✗ Upload ${file.path}: ${err.message}`);
        }
      }
    }

    for (const lf of largeFiles) {
      try {
        await uploadLargeFile(sub.apiUrl, sub.authToken, def.bucketId, lf.path, lf.contentType, 10 * 1024 * 1024);
        console.log(`         ↑ ${lf.path}  (10 MB multipart)`);
      } catch (err) {
        console.error(`  ✗ Large upload ${lf.path}: ${err.message}`);
      }
    }
  }

  // 6 ── Create application keys
  const keyDefs = getKeyDefs(account, createdBuckets);

  for (const kd of keyDefs) {
    try {
      const body = { accountId: sub.accountId, capabilities: kd.capabilities, keyName: kd.name };
      if (kd.bucketId) body.bucketId = kd.bucketId;
      await b2Post(sub.apiUrl, sub.authToken, 'b2_create_key', body);
      console.log(`  ✓ Key  ${kd.name}`);
    } catch (err) {
      console.error(`  ✗ Key ${kd.name}: ${err.message}`);
    }
  }

  console.log(`  ── done`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const hr = '═'.repeat(62);
  console.log(`\n${hr}`);
  console.log(`  NeoCloud B2 — Trial Seed${DRY_RUN ? '  [DRY RUN — no API calls]' : ''}`);
  console.log(`  Accounts : ${ACCOUNTS.length}  (2 internal, 42 AI, 2 SaaS)`);
  console.log(`  Time     : ${SEEDED_AT}`);
  console.log(hr);

  // Authorize master
  let masterAuth;
  try {
    masterAuth = await b2Authorize(MASTER_KEY_ID, MASTER_APP_KEY);
    console.log(`\n✓ Master authorized  accountId:${masterAuth.accountId}`);
  } catch (err) {
    console.error(`FATAL: master auth failed: ${err.message}`);
    process.exit(1);
  }

  for (const account of ACCOUNTS) {
    await seedAccount(masterAuth, account);
  }

  console.log(`\n${hr}`);
  console.log(`  Seed ${DRY_RUN ? 'dry-run ' : ''}complete.`);
  console.log(`${hr}\n`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
