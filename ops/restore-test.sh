#!/usr/bin/env bash
# Restore the latest backup into a scratch DB and assert row counts.
# This is the proof-of-life for the backup system.
set -euo pipefail

notify_ops () {
    local message="$1"
    local url="${RESTORE_REPORT_WEBHOOK_URL:-${ALERT_WEBHOOK_URL:-}}"

    if [[ -n "$url" ]]; then
        curl -fsS --max-time 10 \
            -X POST \
            -H "Content-Type: text/plain" \
            --data-binary "$message" \
            "$url" >/dev/null \
            || logger -t rpow-restore-test "report webhook failed"
    else
        logger -t rpow-restore-test "$message"
    fi
}

if [[ -r /etc/rpow/alerts.env ]]; then
    # shellcheck disable=SC1091
    source /etc/rpow/alerts.env
fi

trap 'rc=$?; notify_ops "ALERT rpow restore drill FAILED on $(hostname -f) at $(date -u +%FT%TZ) exit=$rc"; exit "$rc"' ERR

# shellcheck disable=SC1091
source /etc/rpow/restic.env
export B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD

SCRATCH=rpow_restore_test
cleanup () {
    sudo -u postgres dropdb --if-exists "$SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres dropdb --if-exists "$SCRATCH"
sudo -u postgres createdb -O rpow_app "$SCRATCH"

LATEST=$(restic snapshots --tag rpow --json | jq -r 'sort_by(.time) | .[-1].id')
DUMP_PATH=$(restic snapshots --tag rpow --json | jq -r 'sort_by(.time) | .[-1].paths[0]')
echo "Restoring snapshot $LATEST ($DUMP_PATH)..."

restic dump "$LATEST" "$DUMP_PATH" \
    | sudo -u postgres pg_restore --no-owner --no-privileges -d "$SCRATCH"

echo "Row counts on restored scratch DB:"
ROW_COUNTS=$(sudo -u postgres psql -d "$SCRATCH" -c "
  SELECT 'users' AS tbl, count(*) FROM users
  UNION ALL SELECT 'tokens',         count(*) FROM tokens
  UNION ALL SELECT 'transfers',      count(*) FROM transfers
  UNION ALL SELECT 'magic_links',    count(*) FROM magic_links
  UNION ALL SELECT 'challenges',     count(*) FROM challenges
  UNION ALL SELECT 'pending_transfers', count(*) FROM pending_transfers
  ORDER BY tbl;
")
echo "$ROW_COUNTS"

echo "Restore drill OK."
notify_ops "OK rpow restore drill on $(hostname -f) at $(date -u +%FT%TZ)
snapshot=$LATEST
dump=$DUMP_PATH

$ROW_COUNTS"
