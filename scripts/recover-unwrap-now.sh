#!/usr/bin/env bash
# One-off recovery for the 20-SRPOW unwrap signed during the first pilot
# attempt where the client errored after the on-chain transfer landed.
# Hardcodes the specific recovery params so the operator only needs to run
# a single short command on the VPS. Delete after use.
set -euo pipefail

SIGNATURE='2RCXb7U8RYVek8LdpXdKNCPP9pT9J3apPqFuN9Qv6JZN8BPtgK8T4vjgF7hm9mnzmxhdEGCTPNrCFH3M8WWGz6or'
EMAIL='frk314@gmail.com'
AMOUNT='20000000000'

# Pull SESSION_SECRET from the service env (sudo is required to read it).
SESSION_SECRET="$(sudo grep -m1 '^SESSION_SECRET=' /etc/rpow/server.env | cut -d= -f2-)"
if [ -z "$SESSION_SECRET" ]; then
  echo 'SESSION_SECRET not found in /etc/rpow/server.env' >&2
  exit 1
fi

SESSION_SECRET="$SESSION_SECRET" node /opt/rpow/repo/scripts/submit-unwrap.mjs \
  "$EMAIL" "$SIGNATURE" "$AMOUNT"
