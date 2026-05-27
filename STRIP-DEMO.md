# Strip demo features

This portal ships with a "demo mode" alongside live mode — useful for
exploration but not for a partner running it as a production customer
portal. This guide walks through removing the demo path cleanly.

Total time: **half a day** for a developer comfortable with React + Express.
The architecture isolates demo behind a single `useMocks()` flag in two
adapter files, so you're modifying — not untangling.

---

## Phase 1 — Operational toggles (~30 min, no code changes)

These steps disable demo features without editing source. Useful if you
want to keep the demo path available behind a feature flag for a while.

### 1.1 Stop seeding demo users

```js
// server/index.js — comment out the demo-seed call
// await seedDemoUsers();
```

Removes the first-boot creation of `demo@backblaze.com`,
`lumora-admin@demo.com`, `lumora-viewer@demo.com`, `support@demo.com`.

### 1.2 Clear or replace the protected-emails list

```bash
# .env
PROTECTED_ACCOUNT_EMAIL=your-admin@your-domain.com
```

By default the list is empty (no accounts protected). Add only emails you
genuinely want to shield from peer-admin modification.

### 1.3 Purge any demo rows already in the DB

```sql
DELETE FROM users
WHERE email LIKE '%@demo.com'
   OR email = 'demo@backblaze.com';
```

### 1.4 Restart the API

```bash
pm2 restart neocloud-api
```

After this phase the portal still has the demo *mode* toggle in the
header — clicking it loads mock data — but no demo *accounts* exist.

---

## Phase 2 — Remove demo code paths (~2–4 hours)

Now strip the demo-mode branches and mock data files. Everything below
is mechanical; the build will break loudly if you miss anything.

### 2.1 Force live mode in the runtime config

```js
// src/api/b2Adapter.js
const useMocks = () => false;     // was: runtimeConfig.mode !== 'live'

// src/api/partnerApi.js
const useMocks = () => false;     // same
```

### 2.2 Delete the demo-data files

These are imported only inside `if (useMocks())` branches:

```bash
rm src/data/customers.js
rm src/data/buckets.js
rm src/data/applicationKeys.js
rm src/data/groups.js
rm src/data/files.js
rm src/data/usageMetrics.js
rm src/data/sampleDailyUsage.csv
rm src/data/apiExamples.js     # if you also remove the API console
```

### 2.3 Remove the `useMocks()` branches

In `src/api/b2Adapter.js` and `src/api/partnerApi.js`, search for every
`if (useMocks())` block and delete it. Each block looks like:

```js
if (useMocks()) {
  await wait();
  // …mock branch using BUCKETS / CUSTOMERS / etc.…
  return { … };
}
// live-mode code below
```

Keep the live-mode code below each branch. There are roughly 40 of these
across the two files — all small, all isolated.

Also remove the now-unused mock-data imports at the top of each file:

```js
// b2Adapter.js — remove these
import { BUCKETS } from '../data/buckets.js';
import { APPLICATION_KEYS } from '../data/applicationKeys.js';
import { DAILY_USAGE, REGION_USAGE, ACTIVITY_HEATMAP } from '../data/usageMetrics.js';
import { FILES_BY_BUCKET } from '../data/files.js';

// partnerApi.js — remove these
import { CUSTOMERS, aggregate } from '../data/customers.js';
import { GROUPS } from '../data/groups.js';
```

### 2.4 Drop the demo-account middleware

```js
// server/middleware/requireAuth.js — remove these exports entirely
const DEMO_EMAILS = new Set(['demo@backblaze.com']);
export const isDemoEmail = (email) => …;
export function requireNotDemo(req, res, next) { … }
```

Find and remove every `requireNotDemo` from route definitions:

```bash
grep -rln "requireNotDemo" server/routes/
# usually: customerB2.js, masterB2.js, possibly others
```

And every `isDemoEmail` check:

```bash
grep -rln "isDemoEmail" server/
# usually: routes/auth.js (change-password block)
```

### 2.5 Remove the demo seed scripts

These exist for the bundled demo deployment. A real partner doesn't need
any of them:

```bash
rm server/seed-trial.mjs              # creates demo sub-accounts
rm server/seed-data.mjs               # bulk demo uploads
rm server/seed-empty-accounts.mjs     # seeds bucket data for empty accounts
rm server/seed-daily.mjs              # daily activity simulator
rm server/seed-transactions.mjs       # generates Class A/B/C transactions
rm server/seed-master-buckets.mjs     # seeds the partner's master account
```

Keep these — they're legitimate ops tooling:

| File | Purpose |
|---|---|
| `server/seed.js` | First-admin seeder. Reads `DEFAULT_ADMIN_*` from `.env`. |
| `server/archive-reports.mjs` | Mirrors B2 reports CSVs into local cache. |
| `server/health-monitor.mjs` | Long-running watchdog for the API. |
| `server/reset-password.mjs` | Emergency admin password reset. |
| `server/check-data.mjs` | Read-only inventory check across sub-accounts. |
| `server/show-users.mjs` | Read-only user table dump. |

### 2.6 Remove the demo-bypass in reset-password.mjs

```js
// server/reset-password.mjs — remove the isDemoSeed bypass
if (password.length < 8) {
  console.error('ERROR: password must be at least 8 characters.');
  process.exit(1);
}
```

### 2.7 Update PM2 to drop the demo-only processes

If you used the upstream PM2 setup:

```bash
pm2 delete neocloud-daily-seed
pm2 delete neocloud-transactions
pm2 save
```

Keep `neocloud-api`, `neocloud-monitor`, `neocloud-archive`.

### 2.8 Verify

```bash
npm test                # all server tests should still pass
npm run build           # no missing-import errors
```

Sign in to the portal — there should be no Demo/Live toggle behavior, and
loading any view should hit your live B2 Partner API.

---

## Phase 3 — Re-brand (~4–8 hours)

### 3.1 Replace "Neocloud" strings

```bash
grep -rln "[Nn]eocloud" src/ server/ index.html package.json
```

Touchpoints:
- `index.html` — `<title>` and meta
- `package.json` — `"name"`
- `src/App.jsx` — app titles
- `src/components/Layout.jsx` — header "Partner Portal" eyebrow
- `src/views/LoginView.jsx` — sign-in branding
- `src/views/ExecutiveOverview.jsx` — page header
- Various comment strings (cosmetic)

### 3.2 Swap accent colors

`tailwind.config.js` defines:

```js
'bb-red':    '#E61F18',  // primary accent
'bb-redDim': '#B0150F',
```

Change to your brand color; every button, badge, and chart will pick it up.

### 3.3 Replace placeholder copy

```bash
grep -rn "Acme Corp\|contact@example.com" src/components/dialogs.jsx
```

Substitute your preferred examples, or leave them generic.

### 3.4 Logo / favicon

- `public/favicon.svg` — replace with your icon
- `src/components/Layout.jsx` `<Logo />` — currently renders a styled "B"
  in a red rounded square. Edit the JSX or swap for an `<img>`.

### 3.5 Update DEPLOY.md + README.md

Replace "Neocloud Partner Portal" references and add a section on your
specific deployment topology (host, key management, monitoring).

---

## What NOT to remove

Even though they say "Backblaze" or "B2", these are educational for a
B2 partner and should stay:

- **API Console** (`src/views/ApiConsoleView.jsx`, `src/data/apiExamples.js`)
  — shows real `b2_*` and `b2api/v3` calls. Useful to customers learning
  the surface.
- **Class A/B/C/D transactions** — Backblaze's billing model. Visible in
  Usage & Billing and Reseller Plans.
- **B2 region IDs** (`us-east-005`, `eu-central-003`, etc.) — these are
  the real B2 region identifiers.
- **`b2_authorize_account`, `b2_list_buckets`, b2-reports-*` etc.** — these
  are real B2 API endpoints / system buckets the portal depends on.

If you want a portal for a non-Backblaze storage backend, you're better
off starting from a different repo than stripping this one.

---

## Phase 4 — Re-baseline tests

After stripping demo paths, some tests reference removed code. Walk the
suite and update:

```bash
npm test 2>&1 | grep -E "FAIL|Error"
```

Common updates:
- `tests/setup.js` — drop the `PROTECTED_ACCOUNT_EMAIL` pin if you set a
  real one in `.env`.
- Any test that constructed mock customer rows from `CUSTOMERS` — replace
  with explicit fixtures in the test file.

---

## Checklist

- [ ] Phase 1 — operational toggles applied
- [ ] Phase 2.1 — `useMocks()` forced to false
- [ ] Phase 2.2 — demo-data files deleted
- [ ] Phase 2.3 — `if (useMocks())` branches stripped from both adapters
- [ ] Phase 2.4 — `requireNotDemo` / `isDemoEmail` removed
- [ ] Phase 2.5 — demo seed scripts removed
- [ ] Phase 2.6 — `reset-password.mjs` demo bypass removed
- [ ] Phase 2.7 — PM2 demo processes removed
- [ ] Phase 2.8 — `npm test` + `npm run build` green
- [ ] Phase 3.1 — "Neocloud" strings replaced
- [ ] Phase 3.2 — accent colors swapped
- [ ] Phase 3.3 — placeholder copy updated
- [ ] Phase 3.4 — logo / favicon replaced
- [ ] Phase 3.5 — DEPLOY.md / README.md updated
- [ ] Phase 4 — test suite re-baselined
- [ ] Deploy to staging, verify live B2 calls work end-to-end
- [ ] Backup `CREDENTIAL_ENCRYPTION_KEY` to a vault (see DEPLOY.md)
- [ ] Production deploy

When every box is checked, this is the partner's portal, not the demo.
