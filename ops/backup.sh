#!/usr/bin/env bash
# nightly rpow Postgres to B2 backup. Pipes pg_dump straight into restic.
set -euo pipefail

notify_ops () {
    local message="$1"

    if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
        curl -fsS --max-time 10 \
            -X POST \
            -H "Content-Type: text/plain" \
            --data-binary "$message" \
            "$ALERT_WEBHOOK_URL" >/dev/null \
            || logger -t rpow-backup "alert webhook failed"
    else
        logger -t rpow-backup "$message"
    fi
}

if [[ -r /etc/rpow/alerts.env ]]; then
    # shellcheck disable=SC1091
    source /etc/rpow/alerts.env
fi

trap 'rc=$?; notify_ops "ALERT rpow backup FAILED on $(hostname -f) at $(date -u +%FT%TZ) exit=$rc"; exit "$rc"' ERR

# shellcheck disable=SC1091
source /etc/rpow/restic.env
export B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD

LABEL="rpow-$(date -u +%FT%H%MZ).dump"

sudo -u postgres pg_dump -Fc rpow \
    | restic backup --stdin --stdin-filename "$LABEL" \
        --tag rpow --tag postgres

# retention: 7 daily, 4 weekly, 6 monthly
restic forget --tag rpow --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# integrity check: read 5% of data on each run
restic check --read-data-subset=5%
