#!/usr/bin/env bash
# External watchdog for rpow-server.
# Pings /ready every time it runs (driven by rpow-healthcheck.timer).
# On 2 consecutive failures, restarts rpow-server. Logs to journald.
set -uo pipefail

STATE=/run/rpow-healthcheck.fails
URL=http://127.0.0.1:8080/ready
THRESHOLD=2

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
    echo "0" > "$STATE"
    exit 0
fi

# Failed. Increment counter.
fails=$(cat "$STATE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE"

logger -t rpow-healthcheck "FAIL $URL (consecutive=$fails)"

if [ "$fails" -ge "$THRESHOLD" ]; then
    logger -t rpow-healthcheck "RESTART rpow-server (consecutive=$fails reached threshold $THRESHOLD)"
    systemctl restart rpow-server || logger -t rpow-healthcheck "restart command failed"
    echo "0" > "$STATE"
fi
