#!/bin/bash
# scripts/backfill-avatars.sh
#
# One-shot wrapper for the avatar backfill. Lives in scripts/ but invokes
# the COMPILED JS (under dist/) via plain `node` — no tsx/esbuild needed.
#
# Usage on the VPS (as ubuntu user with sudo):
#   sudo bash /opt/rpow/repo/apps/server/scripts/backfill-avatars.sh
#
# Prereqs:
#   - /etc/rpow/server.env contains DATABASE_URL + X_BEARER_TOKEN
#   - The TS sources have been compiled (npm run build -w @rpow/server)

set -e

ENV_FILE=/etc/rpow/server.env
REPO=/opt/rpow/repo
SCRIPT_JS="$REPO/apps/server/dist/scripts/backfill-avatars.js"

if [ ! -r "$ENV_FILE" ]; then
  echo "$ENV_FILE not readable. run with sudo." >&2
  exit 1
fi
if [ ! -f "$SCRIPT_JS" ]; then
  echo "compiled script not found at $SCRIPT_JS" >&2
  echo "build first: sudo -u rpow npm --prefix=$REPO run build -w @rpow/server" >&2
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

sudo -u rpow env DATABASE_URL="$URL" X_BEARER_TOKEN="$TOKEN" node "$SCRIPT_JS"
