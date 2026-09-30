#!/usr/bin/env bash
# Dump the latest 5 unwrap events for the pilot user so the operator can see
# what's in flight, what failed, and which signatures need recovery.
set -euo pipefail

EMAIL="${1:-frk314@gmail.com}"
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' /etc/rpow/server.env | cut -d= -f2-)"

psql "$DATABASE_URL" -c "SELECT id, status, amount::text AS amount, solana_signature, swap_signature, burn_signature, failure_reason, created_at FROM srpow_wrap_events WHERE user_email='$EMAIL' AND direction='UNWRAP' ORDER BY created_at DESC LIMIT 5;"
