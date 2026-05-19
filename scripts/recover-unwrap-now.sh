#!/usr/bin/env bash
# One-off recovery for the SRPOW unwrap signed during the pilot where the
# client errored / server raced ahead of Helius. Hardcodes the recovery
# params so the operator only needs to run a single short command on the
# VPS. Delete after use.
set -euo pipefail

# Current target: the row-1 not_found attempt (10 SRPOW landed at bridge,
# but server marked FAILED before Helius indexed it).
SIGNATURE='4GwiVkuYxNqvr8sBJSQt5VUYgNoFvr35LraqPwXN2cvicCDZ7NH8hynzToHERHaJcHpujuftdCqKpMsSouf33bJw'
EMAIL='frk314@gmail.com'
AMOUNT='10000000000'

SESSION_SECRET="$(grep -m1 '^SESSION_SECRET=' /etc/rpow/server.env | cut -d= -f2-)"
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' /etc/rpow/server.env | cut -d= -f2-)"
if [ -z "$SESSION_SECRET" ] || [ -z "$DATABASE_URL" ]; then
  echo 'SESSION_SECRET or DATABASE_URL missing in /etc/rpow/server.env' >&2
  exit 1
fi

echo '[1/2] removing prior failed row for this signature (if any)...'
psql "$DATABASE_URL" -c \
  "DELETE FROM srpow_wrap_events WHERE direction='UNWRAP' AND solana_signature='$SIGNATURE' RETURNING id, status;"

echo '[2/2] submitting unwrap...'
SESSION_SECRET="$SESSION_SECRET" node /opt/rpow/repo/scripts/submit-unwrap.mjs \
  "$EMAIL" "$SIGNATURE" "$AMOUNT"
