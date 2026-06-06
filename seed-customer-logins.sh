#!/bin/bash
# Wrapper to seed customer-portal logins for one or more accounts.
#
# Workaround for the user's local-shell `\r` injection issue: invoking
# `bash <this-script>` (two words, no positional args) avoids the
# corruption that happens when typing inline SSH commands with arguments.
#
# Edit the ACCOUNTS array below to target different accountIds. List
# available accounts with:
#   bash seed-customer-logins.sh --list

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${DEPLOY_KEY:-$HERE/Kevin-west.pem.local}"
HOST="${DEPLOY_HOST:-ec2-user@ec2-54-245-237-84.us-west-2.compute.amazonaws.com}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/var/www/backblaze-neocloud-demo}"

# Accounts to seed customer-portal logins for. Edit this list.
ACCOUNTS=(
  cfa813cc01a4
  d5212bf86bb5
)

if [ "$1" = "--list" ]; then
  ssh -i "$KEY" "$HOST" "cd $REMOTE_DIR && node server/seed-customer-logins.mjs --list"
  exit $?
fi

for ACCT in "${ACCOUNTS[@]}"; do
  echo "================================================================"
  echo "  Seeding logins for: $ACCT"
  echo "================================================================"
  ssh -i "$KEY" "$HOST" "cd $REMOTE_DIR && node server/seed-customer-logins.mjs $ACCT"
done
