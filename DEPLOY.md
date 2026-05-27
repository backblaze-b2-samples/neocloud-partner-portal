# Deployment notes

Operational checklist for running this portal in production. Pairs with
`README.md` (app overview) and `.env.example` (required configuration).

---

## First-run setup

1. Copy `.env.example` to `.env` and fill in:
   - `B2_MASTER_KEY_ID`, `B2_MASTER_APP_KEY` — partner master key
   - `CREDENTIAL_ENCRYPTION_KEY` — 32+ char random; **back this up separately**
   - `DEFAULT_ADMIN_EMAIL`, `DEFAULT_ADMIN_PASSWORD` — seeds the first admin
   - Optionally `PROTECTED_ACCOUNT_EMAIL=…` to lock specific admin accounts
2. `npm install`
3. `node server/index.js` — first boot creates the SQLite schema and seeds the admin
4. Optional: `npm run build && rsync dist/ /var/www/...` for the SPA

## Process management (PM2)

The reference deployment uses PM2 with five processes:

| Process | Purpose | Schedule |
|---|---|---|
| `neocloud-api` | Express server | autorestart |
| `neocloud-monitor` | Polls `/api/auth/me`; restarts api on 3 consecutive failures | autorestart |
| `neocloud-archive` | Mirrors `b2-reports-*` CSVs into `server/data/reports/` | nightly cron |
| `neocloud-daily-seed` | Demo activity simulator (optional) | nightly cron |
| `neocloud-transactions` | Generates Class A/B/C demo transactions (optional) | every 4h |

After registering processes the first time, save the dump so they survive
reboots:

```
pm2 save
pm2 startup    # follow the printed instructions once
```

## Deploys

`deploy.sh` rsyncs `dist/` and `server/` from your workstation to the host.
It excludes `data/`, `.env*`, `node_modules/`, logs, `.pem`/`.key`. Defaults
target the upstream sample EC2. Override per-developer by creating
`.deploy.env` next to `deploy.sh` (gitignored):

```
DEPLOY_KEY=$HOME/.ssh/my-prod.pem
DEPLOY_HOST=ec2-user@my-host.example.com
DEPLOY_REMOTE_DIR=/var/www/my-app
DEPLOY_PM2_APP=my-api
```

Then `bash deploy.sh` is a drop-in for any host.

## Backup

SQLite at `server/data/app.db` is the only durable state. It contains users,
sessions, audit log, customer metadata, encrypted credentials, object-count
cache, and reseller plans.

**Recommended backup**: nightly snapshot, two channels.

```
# 1. DB → S3/B2 (or any object store)
sqlite3 /var/www/backblaze-neocloud-demo/server/data/app.db ".backup '/tmp/app.db.bak'"
gzip /tmp/app.db.bak
# upload /tmp/app.db.bak.gz to your backup destination

# 2. EBS / disk snapshot of the volume hosting server/data/
```

Run via cron at, e.g. 04:00 local. Test restore quarterly.

## Encryption key — back up separately

`CREDENTIAL_ENCRYPTION_KEY` is the only thing that can decrypt the B2
sub-account application keys in `account_credentials`. If you lose it:

- All stored sub-account keys become permanently unreadable.
- The DB backup is useless for credential recovery.
- You'd have to re-issue B2 keys for every sub-account.

Store the key in a secret manager (AWS Secrets Manager, 1Password vault,
sealed envelope, etc.) **separately from the database backups**. Rotating
the key is a planned-migration operation: decrypt with the old key, re-encrypt
with the new one, atomically swap.

## Log rotation

PM2 writes per-process logs under `~/.pm2/logs/`. Without rotation these will
eventually fill the disk. Install `pm2-logrotate` once:

```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

That keeps 14 compressed log files per process, rotating at 50 MB each.

## Health checks

The `neocloud-monitor` PM2 process polls `/api/auth/me` every 60s and emits
a greppable `ALERT` line plus runs `pm2 restart neocloud-api` after 3
consecutive failures. To see when the watchdog has intervened:

```
grep ALERT ~/.pm2/logs/neocloud-monitor-out.log
```

Tune via env vars on the process (see `.env.example` → "health monitor"
section). Set `HEALTH_INTERVAL_MS` lower if you need faster recovery.

## Reverse-proxy / TLS

Run nginx (or any TLS terminator) in front. The portal expects:

- `Content-Type: application/json` on all `POST`/`PUT`
- `Cookie` forwarded as-is (sessions + CSRF use cookies)
- `X-Forwarded-For` forwarded for accurate rate limiting (`TRUST_PROXY=1`
  in `.env` if there's exactly one proxy hop)

Cookies are emitted with `Secure` only in production (`NODE_ENV=production`).
Always terminate TLS at the proxy.
