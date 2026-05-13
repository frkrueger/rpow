#!/bin/bash
# scripts/backfill-avatars.sh
#
# One-shot wrapper: extract DATABASE_URL + X_BEARER_TOKEN from
# /etc/rpow/server.env (without sourcing the whole file, which has
# shell-unsafe lines), then run the TS backfill script as the rpow user.
#
# Usage (on the VPS, as ubuntu user with sudo):
#   sudo bash /opt/rpow/repo/apps/server/scripts/backfill-avatars.sh

set -e

ENV_FILE=/etc/rpow/server.env
REPO=/opt/rpow/repo

if [ ! -r "$ENV_FILE" ]; then
  echo "$ENV_FILE not readable. run with sudo." >&2
  exit 1
fi

URL=$(grep ^DATABASE_URL= "$ENV_FILE" | cut -d= -f2-)
TOKEN=$(grep ^X_BEARER_TOKEN= "$ENV_FILE" | cut -d= -f2-)

if [ -z "$URL" ]; then
  echo "DATABASE_URL not found in $ENV_FILE" >&2
  exit 1
fi
if [ -z "$TOKEN" ]; then
  echo "X_BEARER_TOKEN not found in $ENV_FILE" >&2
  exit 1
fi

sudo -u rpow env DATABASE_URL="$URL" X_BEARER_TOKEN="$TOKEN" \
  "$REPO/node_modules/.bin/tsx" \
  "$REPO/apps/server/scripts/backfill-avatars.ts"
