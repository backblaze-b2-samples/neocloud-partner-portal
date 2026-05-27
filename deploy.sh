#!/bin/bash
# Sync only built front-end assets (dist/) and server-side code (server/) to
# EC2. Never touches runtime state — DB, CSV report archive, logs, secrets,
# and node_modules all stay on the server.
set -e
KEY="/Users/klott/Documents/Claude/Projects/b2-partner-portal/Kevin-west.pem.local"
HOST="ec2-user@ec2-54-245-237-84.us-west-2.compute.amazonaws.com"

# Patterns excluded from BOTH dist/ and server/ pushes. Anything below
# represents runtime state, secrets, or build output that should not be
# overwritten or deleted by a deploy. `data/` covers both `server/data/app.db*`
# (SQLite) and `server/data/reports/` (cached daily Usage CSVs).
RSYNC_EXCLUDES=(
  --exclude='data/'
  --exclude='node_modules/'
  --exclude='.env'
  --exclude='.env.*'
  --exclude='*.log'
  --exclude='*.local'
  --exclude='*.local.*'
  --exclude='.DS_Store'
  --exclude='.fuse_hidden*'
  --exclude='*.pem'
  --exclude='*.key'
)

echo "Transfer starting: dist/"
rsync -avz --delete "${RSYNC_EXCLUDES[@]}" -e "ssh -i $KEY" \
  /Users/klott/Documents/Claude/Projects/b2-partner-portal/dist/ \
  "$HOST:/var/www/backblaze-neocloud-demo/dist/"

echo "Transfer starting: server/"
rsync -avz --delete "${RSYNC_EXCLUDES[@]}" -e "ssh -i $KEY" \
  /Users/klott/Documents/Claude/Projects/b2-partner-portal/server/ \
  "$HOST:/var/www/backblaze-neocloud-demo/server/"

ssh -i "$KEY" "$HOST" "fuser -k 3001/tcp 2>/dev/null || true; pm2 restart neocloud-api && sleep 2 && pm2 status neocloud-api --no-color"
