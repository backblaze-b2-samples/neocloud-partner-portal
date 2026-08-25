# Backblaze for Neocloud · Partner Portal

A dark-mode partner portal for reselling **Backblaze B2** into **neocloud / AI cloud / SaaS** customers. It runs in two modes: a **demo mode** backed entirely by mock data, and a **live mode** that talks to the real Backblaze Native and Partner APIs.

The app focuses on **app storage, AI workloads, object storage, and partner use cases** — not backup. Every metric is labeled with its true data source (Native API, Partner API, Daily CSV, or derived) so the app never overstates what Backblaze actually exposes.

> ### ⚠️ Unsupported Sales Engineering project
>
> This is **not an official Backblaze product** and is **not supported by Backblaze**. It was built by Sales Engineering as a demonstration, not by a Backblaze product or engineering team.
>
> There is **no support of any kind** — please don't open Backblaze support tickets about it or escalate through Backblaze support channels. It is provided as-is, with no warranty, and may change or disappear without notice.
>
> If you deploy it, you own the deployment: its security, its data, and any charges it incurs against your Backblaze account. See [LICENSE](LICENSE).

It is a **full-stack** application, not a static front end:

- **React + Vite** front end
- **Express** API server with session auth, RBAC, CSRF protection, and an audit log
- **SQLite** for users, customer metadata, encrypted sub-account credentials, and background-job results

---

## Run it

Requires **Node 20+** (`engines: node >=20`).

```bash
git clone https://github.com/backblaze-b2-samples/neocloud-partner-portal.git
cd neocloud-partner-portal
npm install
npm run dev
```

This starts the Vite dev server and the API server together. Open <http://localhost:5173>.

No environment variables are required for demo mode — the database is created automatically and demo data is mocked.

### Signing in

Demo accounts are seeded on first boot. The password for all of them is `demo`:

| Email | Role | Sees |
|---|---|---|
| `demo@backblaze.com` | admin | The full partner portal |
| `support@demo.com` | support | Partner portal, support-scoped |
| `lumora-admin@demo.com` | customer_admin | The customer console for one sub-account |
| `lumora-viewer@demo.com` | customer_readonly | Same, read-only |

Sign in as `demo@backblaze.com` to see the whole product. The two `lumora-*` accounts are useful for showing what an end customer sees.

> On first boot you will see `ERROR: no admin user in DB and DEFAULT_ADMIN_* env vars unset`. In demo mode this is harmless — the demo seed creates the admin immediately afterwards. It matters only when you are standing up a real deployment (see [Going live](#going-live)).

### Other commands

```bash
npm test           # vitest — front-end and server suites
npm run build      # production front-end build into dist/
npm run preview    # serve the built front end
npm run server     # API server only, with --watch
```

---

## What's in it

### Insights

| View | What it shows | Primary data source |
|---|---|---|
| **Executive overview** | Total storage, egress, transactions, customers, buckets, regions, MRR, gross margin, growth trends | CSV + Partner + derived |
| **Business cockpit** | P&L lens — profit leaders, margin by customer, revenue concentration | Derived |
| **Groups** | Partner group rollups and their member sub-accounts | Partner API |
| **Customers & sub-accounts** | Per-customer storage, **object count**, egress, revenue, margin, health; drill-down to buckets, keys, activity, billing, and logins | Partner API + CSV + index |

### Operations

| View | What it shows | Primary data source |
|---|---|---|
| **Storage & buckets** | Per-bucket lifecycle (hide/delete only — no tiering), encryption, file lock, versioning, CORS, replication, object counts | B2 Native API + CSV + index |
| **Regions & placement** | Per-region storage, growth, bucket placement, p99 (demo), availability (demo) | CSV + static |
| **Usage & billing** | Daily / weekly / monthly trends, Class A/B/C/D transactions, cost model with adjustable resale multiplier, raw CSV preview | CSV + derived |

### Security

| View | What it shows | Primary data source |
|---|---|---|
| **Application keys & security** | Key inventory, scopes, bucket restrictions, expiration, posture cards, least-privilege examples | B2 Native API + derived |
| **Ransomware protection** | Object Lock / immutability posture per bucket | B2 Native API |
| **Trust Center** | Encryption, retention, and compliance posture summary | Derived |

### Administration & developer

| View | What it shows |
|---|---|
| **User management** | Portal users, roles, activation, password resets |
| **Audit log** | Every privileged action, with actor and target |
| **View as customer** | Read-only impersonation of a customer account |
| **API console** | Request/response viewer for auth, list buckets, create key, list files, partner groups, usage CSV |
| **MCP console** | Backblaze MCP tools, plus a conversational mode that turns intent into scoped tool calls (needs `ANTHROPIC_API_KEY`) |
| **Reseller plans** | Pricing tiers and per-customer overrides that drive the revenue/COGS model |

Customer-role users get a separate, reduced console scoped to their own account.

---

## Object counts

`b2_list_buckets` does **not** return object counts or storage bytes — no Backblaze API does. The portal computes them with a background job (`server/jobs/objectCountJob.js`) that paginates `b2_list_file_names` for every sub-account bucket every 24 hours, storing per-bucket counts and a file index in SQLite.

That means counts can be **up to a day old**. The UI says so wherever they appear, and there is a **Sync** button to force a recount for one customer or for everything. A customer whose account has never been walked shows `—` rather than `0`, so "unknown" is never mistaken for "empty".

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

## Going live

> **Never put B2 credentials in a `VITE_`-prefixed variable.** Vite inlines those into the client bundle, which would publish your keys to every visitor. This project has no `VITE_B2_*` variables and does not need any.

Live mode is a runtime toggle in the top bar, not a build-time flag. Turning it on requires two things:

**1. A non-demo admin account.** Live mode is deliberately blocked for `@demo.com` addresses. Create a real admin by setting these in `.env` before first boot (they are used only when the users table has no admin):

```bash
DEFAULT_ADMIN_EMAIL=you@yourcompany.com
DEFAULT_ADMIN_PASSWORD=<a strong password>
```

**2. Your B2 master key.** Sign in as that admin, open **Settings**, and enter the **Master Key ID** and **Master Application Key**. Then flip **Demo → Live** in the top bar. The toggle stays disabled until both are present.

B2 calls are proxied through the Express server rather than made from the browser, so bucket listings, the daily usage CSV, and Partner API calls all originate server-side.

### Server environment

Copy `.env.example` to `.env`. The variables that matter:

| Variable | Purpose |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | **Required for live mode.** AES-256-GCM key used to encrypt per-sub-account application keys at rest in SQLite. |
| `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` | First-boot admin seed. Ignored once an admin exists. |
| `ANTHROPIC_API_KEY` | Enables the MCP console's chat mode. Without it, the console falls back to the manual tool picker. |
| `DB_PATH` | SQLite location. Defaults to `server/data/app.db`. |
| `PORT`, `TRUST_PROXY`, `NODE_ENV` | Standard server runtime settings. |

`B2_MASTER_KEY_ID` and `B2_MASTER_APP_KEY` in `.env.example` are read **only** by the one-off `server/seed-master-buckets.mjs` utility. The running server does not use them — the master key comes from Settings, and per-customer operations use the encrypted sub-account keys in the database.

### Removing demo mode

When you are ready to run this as a real customer-facing portal, [`STRIP-DEMO.md`](STRIP-DEMO.md) walks through removing the demo path. Budget about half a day. The first phase is configuration only — no code changes — so you can disable demo accounts and seed data before committing to edits.

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
neocloud-partner-portal/
├─ index.html
├─ package.json
├─ deploy.sh                    # rsync dist/ + server/ to a host, then pm2 restart
├─ STRIP-DEMO.md                # how to remove demo mode for a real deployment
├─ server/
│  ├─ index.js                  # Express app — middleware chain, route mounting
│  ├─ db.js                     # SQLite schema + additive migrations
│  ├─ auth.js, users.js         # sessions, argon2 password hashing, roles
│  ├─ secretbox.js              # AES-256-GCM for stored sub-account keys
│  ├─ credentials.js            # per-sub-account B2 key storage
│  ├─ audit.js                  # privileged-action audit log
│  ├─ reportsArchive.js         # daily usage CSV parsing + on-disk archive
│  ├─ middleware/requireAuth.js # auth, RBAC, CSRF, read-only impersonation
│  ├─ routes/                   # b2partner, customerB2, masterB2, admin, mcp, ...
│  ├─ jobs/objectCountJob.js    # 24h bucket walk → object_counts + file_index
│  └─ mcp/                      # MCP client, chat agent, usage-insight tools
├─ src/
│  ├─ App.jsx                   # view registry + partner/customer shells
│  ├─ api/                      # b2Adapter, partnerApi, csvParser
│  ├─ data/                     # demo fixtures (customers, buckets, keys, CSV)
│  ├─ components/               # ui.jsx, charts.jsx, dialogs, Layout
│  ├─ lib/                      # AppContext, apiClient, nav, format helpers
│  └─ views/                    # 24 screens (see "What's in it")
└─ tests/
   ├─ frontend/                 # formatters, CSV parsing, billing, object counts
   └─ server/                   # auth, RBAC, scoping, CSRF, MCP tools
```

---

## Tech stack

**Front end** — React 18, Vite 8, Tailwind CSS, Recharts (the heatmap is hand-rolled), lucide-react. No state library; `useState` plus context. Views are lazy-loaded via `React.lazy`.

**Server** — Express 4, better-sqlite3, argon2 for password hashing, session cookies with double-submit CSRF tokens, and the Anthropic + MCP SDKs for the conversational console.

**Tests** — Vitest, with supertest for the server routes.

---

## Roles and permissions

Access is granted by **permissions**, not by role name. A role is a named set of
permissions that an administrator can edit, and you can define your own under
**Administration → Roles & permissions**.

Six roles ship built in — `admin`, `manager`, `user`, `support`, `customer_admin`,
`customer_readonly` — seeded with the access they had before permissions existed,
so upgrading changes nothing until you choose to change it. Built-in roles can be
edited but not deleted.

Permissions and tenancy are separate axes, and it matters:

- **Permissions** answer *what may you do* — `users:write`, `audit:read`, `credentials:read`, and so on.
- **Tenancy** answers *whose data is it* — a role has a `scope` of `partner` or `customer`, and customer users are confined to their own `accountId` by `canAccessAccount`.

A `customer_admin` holds `users:write` so they can manage their own team, but
that permission cannot reach the portal-wide `/api/admin/users`: partner-wide
routes additionally require partner scope. Widening a permission can never widen
tenancy.

## Single sign-on (OIDC)

Optional. The portal supports SSO through any standards-compliant OIDC provider —
Microsoft Entra ID, Okta, Google Workspace, Keycloak, AWS Cognito, Auth0.
Password sign-in always remains available alongside it.

**Setting it up**

1. Register an application in your identity provider.
2. Set its redirect URI to `https://your-portal.example.com/api/auth/sso/callback`.
3. In the portal, go to **Settings → Single sign-on** and fill in:
   - **Issuer URL** — the base URL of your provider's discovery document
   - **Client ID** and **Client secret** (the secret is encrypted before storage and never shown again)
   - **Groups claim** — usually `groups`
   - **Button label** — what appears on the sign-in page
4. Add **group → role mappings**. They are checked in order and the first match wins.
5. Tick *Show the SSO button on the sign-in page* and save.

| Provider | Issuer URL |
|---|---|
| Microsoft Entra ID | `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| Google Workspace | `https://accounts.google.com` |
| Okta | `https://{org}.okta.com` |
| Keycloak | `https://{host}/realms/{realm}` |

**Things worth knowing**

- **Partner staff only.** SSO grants partner roles. Customer-portal users stay on passwords — nothing in an OIDC token says which tenant a user belongs to.
- **Roles are re-evaluated on every sign-in**, so removing someone from a group in your IdP takes effect the next time they sign in. A user's role therefore cannot be edited in the portal while they are SSO-managed.
- **Group identifiers differ by provider.** Entra sends group object IDs (GUIDs); Okta and Keycloak usually send names. Use whatever your provider puts in the claim.
- **Granting `admin` from SSO is off by default.** A group mapped to Administrator is refused until an operator explicitly enables it, because that role can read stored credentials and impersonate customers.
- **Unmapped users are refused** unless you set a default role.
- **Email verification** — ID tokens with `email_verified` explicitly `false` are rejected. Providers that omit the claim (Entra, Google) are accepted; they verify at the directory level.
- **SSO cannot take over an existing password account.** If a password account already exists for that address, sign-in is refused with `account_conflict`. Convert the account deliberately instead: **User management → Convert to SSO**, which keeps the user, their id, and their audit history.
- **Break-glass.** The portal refuses to convert the last administrator who can sign in without SSO, so an identity-provider outage cannot lock you out of administration.
- **Demo accounts are password-only** and can never be provisioned or claimed through SSO.
- **Entra group overage.** Entra ID stops embedding group memberships in the token past roughly 150 groups and substitutes a Graph pointer. The portal detects this and reports it explicitly rather than appearing to have no mapping — but the affected user cannot sign in until they are in fewer groups, or you use a claim that is not subject to the limit (for example an app role).
- `SSO_ALLOWED_ISSUER_HOSTS` restricts which issuer hosts may be configured at all — recommended in production, since the issuer URL is fetched by the server.

---

## Importing from the older b2-partner-portal

`import-legacy-portal.mjs` moves portal users, roles, permissions, the audit
trail, and OIDC group mappings across from
[b2-partner-portal](https://github.com/backblaze-b2-samples/b2-partner-portal).

```bash
# dry run first — prints the plan, writes nothing
node import-legacy-portal.mjs --from /path/to/old-portal.db

# then apply
node import-legacy-portal.mjs --from /path/to/old-portal.db --execute
```

Back up first, and include the WAL file — copying `app.db` on its own loses
anything still in `app.db-wal`:

```bash
sqlite3 server/data/app.db ".backup backup.db"
```

**What it does**

- Roles become operator-defined roles here, keeping their **exact** permission
  set. Their ids are UUIDs and ours are slugs, so `Administrator` becomes
  `administrator` and the original id is kept in `roles.legacy_id`.
- A role whose name matches a built-in is **not** merged into it by default.
  Our built-ins are broader than theirs, so merging would quietly widen access;
  pass `--merge-builtins` if that is what you want.
- Users import as partner staff (`account_id` is NULL — that portal has no
  tenant concept), keeping their original `created_at`, active flag, and last
  login. An account that already exists here is reported and left untouched.
- Group mappings carry over, so SSO works against the same groups.
- Audit entries keep their original actor where the user came across; targets
  that are not portal users are preserved inside the details.

**Passwords are not migrated.** That portal uses bcrypt and this one uses
argon2id; a hash cannot be converted. Users import as SSO accounts by default
(`--auth-source sso`) and sign in through your identity provider. With
`--auth-source local` they are flagged for a password reset instead.

**Not imported:** the credential vault (Fernet-encrypted with that portal's own
key — re-provision through the Partner API, or decrypt and re-encrypt
separately), the OIDC client secret, per-group pricing (that portal prices per
partner group in $/TB; this one uses plan tiers with per-account overrides), and
anything ephemeral such as sessions and cached reports.

The script refuses to run if it would leave no active admin able to sign in
without the identity provider. It is safe to re-run: already-imported rows are
matched on `legacy_id` and skipped.

---

## Security notes

Worth understanding before you deploy this anywhere real:

- **Sub-account application keys are encrypted at rest** (AES-256-GCM) via `CREDENTIAL_ENCRYPTION_KEY`. Lose that key and the stored credentials are unrecoverable.
- **CSRF** uses a double-submit cookie. That same check is the single chokepoint enforcing read-only impersonation, so any new state-changing route must sit behind `requireCsrf`.
- **Account scoping** — customer-role users are confined to their own `accountId` by `canAccessAccount`. Routes that read tenant data scope their queries by it.
- **`deploy.sh` defaults to the sample deployment's own host.** Override `DEPLOY_HOST`, `DEPLOY_KEY`, and `DEPLOY_REMOTE_DIR` — via `.deploy.env` or the environment — before running it, or point it somewhere of your own.
- Demo accounts (`@demo.com`, `demo@backblaze.com`) are blocked from live mode by design, and `STRIP-DEMO.md` covers removing them entirely.
- **SSO is optional and fails closed.** An unmapped user, a mapping pointing at a deleted role, a customer-scope role, or the admin role while `allow_admin_role` is off all refuse the sign-in rather than falling back to something arbitrary.
- **A sign-in can only be completed in the browser that started it.** `/api/auth/sso/login` issues a random nonce in a short-lived httpOnly cookie (`SameSite=Lax`, scoped to `/api/auth/sso`) and records it with the OAuth `state`; both the callback and the code exchange require it to match. Without this, the one-time code in the callback URL would be a bearer token — an attacker could start a flow and send a victim a link that silently signed them into the *attacker's* account. The session cookie itself remains `SameSite=Strict`.
- **The OIDC issuer URL is a server-side fetch**, so it is validated before use: HTTPS only, no credentials or query string, no localhost or private/loopback addresses, and every endpoint discovered from it must share the issuer's host. Set `SSO_ALLOWED_ISSUER_HOSTS` to pin it further.

---

## License and support

MIT — see [LICENSE](LICENSE).

**This is an unsupported Sales Engineering project.** It is not an official Backblaze product, not maintained by a Backblaze product or engineering team, and not covered by any Backblaze support agreement, SLA, or product warranty. Backblaze Support will not assist with it — use the GitHub issue tracker, which is handled on a best-effort basis with no guaranteed response.

Provided as-is and as-available. You are responsible for reviewing, securing, and operating anything you deploy from it.

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
