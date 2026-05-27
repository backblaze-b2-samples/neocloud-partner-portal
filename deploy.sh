#!/bin/bash
# Sync only built front-end assets (dist/) and server-side code (server/) to
# the deployment host. Never touches runtime state — DB, CSV report archive,
# logs, secrets, and node_modules all stay on the server.
#
# Defaults match the upstream sample deployment. Override any of these for
# your own environment by exporting them before invoking, or by creating
# a `.deploy.env` next to this script (gitignored):
#
#   cat > .deploy.env <<'EOF'
#   DEPLOY_KEY=$HOME/.ssh/my-prod.pem
#   DEPLOY_HOST=ec2-user@my-host.amazonaws.com
#   DEPLOY_REMOTE_DIR=/var/www/my-app
#   EOF

set -e

# Resolve this script's own directory so the rsync sources are always correct
# regardless of where the script is invoked from.
HERE="$(cd "$(dirname "$0")" && pwd)"

# Optional per-developer overrides.
[ -f "$HERE/.deploy.env" ] && . "$HERE/.deploy.env"

DEPLOY_KEY="${DEPLOY_KEY:-$HERE/Kevin-west.pem.local}"
DEPLOY_HOST="${DEPLOY_HOST:-ec2-user@ec2-54-245-237-84.us-west-2.compute.amazonaws.com}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/var/www/backblaze-neocloud-demo}"
DEPLOY_PM2_APP="${DEPLOY_PM2_APP:-neocloud-api}"
DEPLOY_PORT="${DEPLOY_PORT:-3001}"

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
rsync -avz --delete "${RSYNC_EXCLUDES[@]}" -e "ssh -i $DEPLOY_KEY" \
  "$HERE/dist/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/dist/"

echo "Transfer starting: server/"
rsync -avz --delete "${RSYNC_EXCLUDES[@]}" -e "ssh -i $DEPLOY_KEY" \
  "$HERE/server/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/server/"

ssh -i "$DEPLOY_KEY" "$DEPLOY_HOST" \
  "fuser -k ${DEPLOY_PORT}/tcp 2>/dev/null || true; pm2 restart $DEPLOY_PM2_APP && sleep 2 && pm2 status $DEPLOY_PM2_APP --no-color"
