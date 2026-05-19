#!/usr/bin/env bash
# One-off recovery for the SRPOW unwrap signed during the first pilot
# attempt where the client errored after the on-chain transfer landed.
# Hardcodes the recovery params so the operator only needs to run a single
# short command on the VPS. Delete after use.
#
# Fixes the previous botched attempt (recorded for 20 SRPOW) by deleting
# its FAILED row, then re-submitting for the actual on-chain amount (10).
set -euo pipefail

SIGNATURE='2RCXb7U8RYVek8LdpXdKNCPP9pT9J3apPqFuN9Qv6JZN8BPtgK8T4vjgF7hm9mnzmxhdEGCTPNrCFH3M8WWGz6or'
EMAIL='frk314@gmail.com'
AMOUNT='10000000000'  # 10 SRPOW (actual on-chain amount; previous attempt mis-recorded as 20)

# Pull what we need from the service env (sudo to read it).
SESSION_SECRET="$(grep -m1 '^SESSION_SECRET=' /etc/rpow/server.env | cut -d= -f2-)"
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' /etc/rpow/server.env | cut -d= -f2-)"
if [ -z "$SESSION_SECRET" ] || [ -z "$DATABASE_URL" ]; then
  echo 'SESSION_SECRET or DATABASE_URL missing in /etc/rpow/server.env' >&2
  exit 1
fi

echo '[1/2] removing prior failed row for this signature...'
PGPASSWORD="" psql "$DATABASE_URL" -c \
  "DELETE FROM srpow_wrap_events WHERE direction='UNWRAP' AND solana_signature='$SIGNATURE' RETURNING id, status;"

echo '[2/2] submitting unwrap with corrected amount...'
SESSION_SECRET="$SESSION_SECRET" node /opt/rpow/repo/scripts/submit-unwrap.mjs \
  "$EMAIL" "$SIGNATURE" "$AMOUNT"
