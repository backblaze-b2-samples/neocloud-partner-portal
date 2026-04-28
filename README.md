# Backblaze for Neocloud · Partner Portal (Demo)

A polished, dark-mode partner portal demo built for selling **Backblaze B2** into **neocloud / AI cloud / SaaS** customers. Engineered to feel like a real co-branded reseller product so it can be shown to executives and storage engineers in a sales meeting.

The app focuses on **app storage, AI workloads, object storage, and partner use cases** — not backup. Every metric is labeled with its true data source (Native API, Partner API, Daily CSV, or derived) so the demo accurately reflects what's possible against the real Backblaze API surface.

---

## Run it

```bash
cd backblaze-neocloud-demo
npm install
npm run dev
```

Then open <http://localhost:5173>.

To produce a static build (e.g. for a sales-engineering demo box):

```bash
npm run build
npm run preview
```

Tested with Node 18+. No environment variables are required to run the demo — all data is mocked.

---

## What's in the demo

Eight views accessible from the left sidebar:

| View | What it shows | Primary data source |
|---|---|---|
| **Executive overview** | Total storage, egress, transactions, customers, buckets, regions, MRR, gross margin, growth trends | CSV + Partner + derived |
| **Customers & sub-accounts** | Group members, per-customer storage / egress / revenue / margin, drill-down | Partner API + CSV |
| **Storage & buckets** | Per-bucket lifecycle (hide/delete only — no tiering), encryption, file lock, versioning, CORS, replication | B2 Native API + CSV |
| **Regions & placement** | Per-region storage, growth, bucket placement, p99 (demo), availability (demo) | CSV + static |
| **Usage & billing** | Daily / weekly / monthly trends, Class A/B/C transactions, cost model with adjustable resale multiplier, raw CSV preview | CSV + derived |
| **Application keys & security** | Key inventory, scopes, bucket restrictions, expiration, posture cards, audit-style activity feed, least-privilege examples | B2 Native API + derived |
| **API console** | Embedded request/response viewer with examples for auth, list buckets, create key, list files, partner groups, usage CSV | Demo / live with real keys |
| **AI / Neocloud workloads** | Reference NVMe-staging architecture, dataset & checkpoint storage, tenant isolation, margin vs hyperscaler S3 | Derived + Partner |

---

## Backblaze APIs used (and where to plug in real credentials)

The demo separates UI from API behind a thin adapter layer. All adapters return Promises so swapping mocks for real API calls is a one-line change.

### `src/api/b2Adapter.js` — B2 Native API v4

| Function | Real endpoint | Reference |
|---|---|---|
| `authorizeAccount()` | `GET https://api.backblazeb2.com/b2api/v4/b2_authorize_account` | [docs](https://www.backblaze.com/apidocs/b2-authorize-account) |
| `listBuckets()` | `POST {apiUrl}/b2api/v4/b2_list_buckets` | [docs](https://www.backblaze.com/apidocs/b2-list-buckets) |
| `listApplicationKeys()` | `POST {apiUrl}/b2api/v4/b2_list_keys` | [docs](https://www.backblaze.com/apidocs/b2-list-keys) |
| `createApplicationKey(payload)` | `POST {apiUrl}/b2api/v4/b2_create_key` | [docs](https://www.backblaze.com/apidocs/b2-create-key) |
| `listFileVersions({bucketId,...})` | `POST {apiUrl}/b2api/v4/b2_list_file_versions` | [docs](https://www.backblaze.com/apidocs/b2-list-file-versions) |

### `src/api/partnerApi.js` — Backblaze Partner API v3

Requires Backblaze Partner Program enrollment. Contact Backblaze sales to provision.

| Function | Real endpoint | Reference |
|---|---|---|
| `listGroups()` | `POST https://api123.backblazeb2.com/b2api/v3/b2_list_groups` | [docs](https://www.backblaze.com/docs/cloud-storage-partner-api) |
| `listGroupMembers({groupId})` | `POST https://api123.backblazeb2.com/b2api/v3/b2_list_group_members` | [docs](https://www.backblaze.com/docs/cloud-storage-partner-api) |
| `getCustomers()` | (composite — list members + join CSV usage) | derived |

### `src/api/csvParser.js` — Daily Usage CSV report

The Backblaze Native API does **not** expose aggregated usage in JSON form. Storage bytes, egress, and Class A/B/C transaction counts are delivered daily as CSV files in the special `b2-reports-$ACCOUNTID/YYYY-MM-DD/Usage.csv` bucket.

```js
import { parseDailyUsageCsv, rollupBy, estimateCost, PRICING } from './api/csvParser.js';

const csv = await fetch('https://f005.backblazeb2.com/file/b2-reports-7f3a91d2c4b8/2026-04-25/Usage.csv', {
  headers: { Authorization: authorizationToken },
}).then((r) => r.text());

const rows = parseDailyUsageCsv(csv);
const perCustomer = rollupBy(rows, 'sub_account_id');
```

Reference: [Generate and Use Reports with the Backblaze Partner API](https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports).

### Wiring real credentials

In `src/api/b2Adapter.js`, set `useMocks = false` and provide credentials via Vite env:

```bash
# .env.local (gitignored)
VITE_B2_KEY_ID=00500000000000000000000
VITE_B2_APPLICATION_KEY=K005************************************
VITE_B2_PARTNER_ACCOUNT_ID=PARTNER_ACCOUNT_ID
```

Then implement the real `b2_authorize_account` HTTP call inside `ensureAuth()` (a TODO is left in place). For production deployments you should **never call B2 directly from the browser** — proxy these calls through a backend that holds the key. The adapter is structured so the proxy URL is the only thing the UI needs to know.

---

## Data source labeling

Every metric carries a small badge so the demo never overstates Backblaze's API surface:

- `B2 API` — live data from the Native API (or S3-compatible API)
- `Partner API` — live data from the Partner v3 API
- `Daily CSV` — pulled from the Daily Usage CSV report
- `Derived` — calculated client-side from the above (cost, margin, growth, etc.)
- `Demo only` — placeholder values where Backblaze does not expose a real metric (e.g. region p99 latency)

The Executive Overview footer summarizes which sections come from which sources.

---

## What's accurate vs intentionally synthetic

✅ **Accurate to the API**

- B2 Native API v4 endpoint shapes and response fields
- `b2_list_buckets` returns metadata only — no storage bytes / object count
- Application key capabilities, prefix scoping, expiration semantics
- Daily Usage CSV is the authoritative source for storage / egress / transactions
- Backblaze pricing model (Class A free, Class B/C metered after free tier, 3× egress free, $0.005/GB-mo storage, $0.01/GB egress)
- 4 regions: US East (Reston VA), US West (Sacramento + Phoenix), EU Central (Amsterdam), CA East (Toronto)
- Region is set at account creation — multi-region presence requires multiple sub-accounts
- Partner API v3 surface for Group / sub-account management
- B2 has a **single hot storage class** — no Glacier-style cold tiers, no transitions
- Lifecycle rules on B2 only **hide and delete** files (`daysFromUploadingToHiding` / `daysFromHidingToDeleting`). They do not tier or transition objects. The UI never presents tiers.

🟡 **Demo-only placeholders**

- Region p99 latency and availability percentages (not exposed by the Backblaze API)
- Customer names and account IDs (synthetic)
- Activity feed timestamps (would normally come from key-use logs)
- Resale margin multipliers (depend on your pricing agreement)

---

## Project structure

```
backblaze-neocloud-demo/
├─ index.html
├─ package.json
├─ vite.config.js
├─ tailwind.config.js
├─ postcss.config.js
├─ public/
│  └─ favicon.svg
└─ src/
   ├─ main.jsx
   ├─ App.jsx
   ├─ index.css
   ├─ lib/
   │  └─ format.js              # bytes / currency / percent helpers
   ├─ api/
   │  ├─ b2Adapter.js           # B2 Native API mock + real-API integration points
   │  ├─ partnerApi.js          # Partner API v3 mock
   │  └─ csvParser.js           # Daily Usage CSV parser + cost model
   ├─ data/
   │  ├─ regions.js             # 4 B2 regions
   │  ├─ customers.js           # Demo sub-accounts
   │  ├─ buckets.js             # Demo buckets with metadata
   │  ├─ usageMetrics.js        # 30-day usage time series + region rollups + heatmap
   │  ├─ applicationKeys.js     # Demo keys + audit-style activity feed
   │  ├─ apiExamples.js         # Request/response examples for the API console
   │  └─ sampleDailyUsage.csv   # Sample CSV file shaped like a real Backblaze Daily Usage report
   ├─ components/
   │  ├─ ui.jsx                 # Card, MetricCard, Tabs, Table, badges, source labels, states
   │  ├─ charts.jsx             # Sparkline, area chart, stacked bar, donut, heatmap
   │  └─ Layout.jsx             # Sidebar nav + topbar
   └─ views/
      ├─ ExecutiveOverview.jsx
      ├─ PartnerView.jsx
      ├─ StorageView.jsx
      ├─ RegionView.jsx
      ├─ UsageBillingView.jsx
      ├─ ApplicationKeysView.jsx
      ├─ ApiConsoleView.jsx
      └─ AINeocloudView.jsx
```

---

## Tech stack

- **React 18** + Vite 5
- **Tailwind CSS** for the dark mode palette and component primitives
- **Recharts** for line / area / bar / donut visualizations (the heatmap is hand-rolled)
- **lucide-react** for icons
- No state library — `useState` and component composition keep it readable
- Lazy-loaded views via `React.lazy` keep the initial bundle small

---

## Replacing the placeholder logo

The header uses a stylized "B2" wordmark. To use a different logo (e.g. the one at `https://pcr.cloud-mercato.com/providers/backblaze`), edit the `Logo` component in `src/components/Layout.jsx`:

```jsx
function Logo() {
  return (
    <img src="/your-logo.svg" alt="Backblaze for Neocloud" className="h-9" />
  );
}
```

Drop the file in `public/` so Vite serves it from the root.

---

## Demo talk track suggestions

When walking through this with neocloud executives:

1. **Start on Executive Overview.** "Here's our reseller footprint at a glance — 8 customers, 60+ buckets, $786K/mo aggregate revenue. Notice how every number tells you whether it came from the API live, the daily CSV, or our cost model."
2. **Move to Customers.** "Each row is a separate B2 sub-account under our partner Group. We scope keys per tenant, isolate billing per customer, and roll usage up via the daily CSV report."
3. **Open Storage & buckets.** "Bucket metadata — encryption mode, lifecycle, file lock, replication — comes back from `b2_list_buckets` in real time. The size and object count come from CSV because the API doesn't expose them."
4. **Show Usage & billing.** "Slide the resale multiplier and you can see margin in real time against Backblaze's list pricing. Class A is free, B and C transactions accrue after the free daily allotment, and B2's 3× free egress matters a lot for AI workloads."
5. **Hit AI / Neocloud.** "This is where the value crystallizes — at the same workload, B2 is roughly 75% cheaper than S3 Standard for storage and 90% cheaper for egress, and the Bandwidth Alliance partners (Cloudflare, Fastly, CoreWeave, etc.) make egress effectively free if your CDN is in the alliance."
6. **End on API console.** "Engineers — here's the API you'd integrate against. Native API for buckets and keys, Partner API for sub-accounts and reports, daily CSV for the usage and billing rollups."

Good selling.
