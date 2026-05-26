#!/bin/bash
set -e
KEY="/Users/klott/Documents/Claude/Projects/b2-partner-portal/Kevin-west.pem.local"
HOST="ec2-user@ec2-54-245-237-84.us-west-2.compute.amazonaws.com"
DIST="/Users/klott/Documents/Claude/Projects/b2-partner-portal/dist/"
REMOTE="/var/www/backblaze-neocloud-demo/dist/"

echo "Transfer starting: dist/"
rsync -avz --delete -e "ssh -i $KEY" "$DIST" "$HOST:$REMOTE"
echo "Transfer starting: server/"
rsync -avz --delete \
  --exclude='data/app.db' --exclude='data/app.db-wal' --exclude='data/app.db-shm' \
  --exclude='data/.fuse_hidden*' \
  -e "ssh -i $KEY" \
  /Users/klott/Documents/Claude/Projects/b2-partner-portal/server/ \
  "$HOST:/var/www/backblaze-neocloud-demo/server/"
ssh -i "$KEY" "$HOST" "fuser -k 3001/tcp 2>/dev/null || true; pm2 restart neocloud-api && sleep 2 && pm2 status neocloud-api --no-color"
