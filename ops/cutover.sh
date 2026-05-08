#!/usr/bin/env bash
# rpow Fly→VPS cutover orchestrator.
# Run from the local laptop. Halts at every gate and waits for ENTER.
#
# Required env (sourced from .env.vps + .env):
#   DATABASE_URL            (Neon, for dump source)
#   RPOW_DB_PASSWORD        (VPS Postgres password for rpow_app)
#   CLOUDFLARE_API_TOKEN    (for DNS flip)
#   VPS_IP, VPS_IPV6        (target of flip)
set -euo pipefail

VPS_HOST="ubuntu@15.204.254.192"
DUMP_LOCAL="/tmp/rpow-cutover-$(date -u +%FT%H%MZ).dump"
HERE=$(dirname "$0")

gate () {
    echo
    echo "==== GATE: $1 ===="
    echo "Press ENTER to proceed, Ctrl-C to ABORT."
    read -r
}

step () { echo; echo "[$(date -u +%H:%M:%SZ)] $*"; }

echo "rpow cutover starting. Verify pre-flight:"
echo "  - VPS_IP=$VPS_IP, VPS_IPV6=$VPS_IPV6"
echo "  - safety dump already archived to B2 (Task 8.7)"
echo "  - TTL=60 already set on api.rpow2.com (done 2026-05-07)"
gate "ALL PRE-FLIGHT VERIFIED"

step "T+0s: stopping Fly app"
flyctl scale count 0 --app rpow2-server
sleep 5

step "T+10s: verifying Neon quiescence"
psql "$DATABASE_URL" -c "SELECT pid, usename, state, query FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid();"
gate "Confirm only our session is active (or no rows)"

step "T+20s: pg_dump from Neon (running on VPS so client/server versions match)"
ssh "$VPS_HOST" "pg_dump -Fc '$DATABASE_URL' > /tmp/rpow-cutover.dump && ls -la /tmp/rpow-cutover.dump"

step "T+40s: pg_restore on VPS"
ssh "$VPS_HOST" "PGPASSWORD='$RPOW_DB_PASSWORD' pg_restore --clean --if-exists --no-owner --no-privileges -h /var/run/postgresql -U rpow_app -d rpow /tmp/rpow-cutover.dump 2>&1 | tail -10"

step "T+90s: GATE 1 — row-count parity"
echo "--- Neon ---"
psql "$DATABASE_URL" -f "$HERE/parity-check.sql"
echo "--- VPS ---"
ssh "$VPS_HOST" "PGPASSWORD='$RPOW_DB_PASSWORD' psql -h /var/run/postgresql -U rpow_app -d rpow -f -" < "$HERE/parity-check.sql"
gate "Confirm Neon rows EXACTLY MATCH VPS rows"

step "T+95s: restarting rpow-server on VPS"
ssh "$VPS_HOST" "sudo systemctl restart rpow-server && sleep 3 && systemctl is-active rpow-server"

step "T+100s: GATE 2 — smoke test via --resolve"
VPS_IP="$VPS_IP" "$HERE/smoke-test.sh"
gate "Confirm /health, /ready, /ledger, TLS all OK"

step "T+125s: DNS FLIP — point api.rpow2.com at VPS"
"$HERE/dns-flip.sh"

step "T+130s: watching propagation (~60s)"
for i in 1 2 3 4 5; do
    sleep 12
    echo "$(date -u +%H:%M:%SZ)"
    dig +short A api.rpow2.com @1.1.1.1
    dig +short A api.rpow2.com @8.8.8.8
done

step "T+200s: live curl through real DNS"
curl -sS -o /dev/null -w "HTTP %{http_code} cert=%{ssl_verify_result} via %{remote_ip}\n" https://api.rpow2.com/ready || true

step "Cutover complete. Monitor for 30 min:"
echo "  ssh $VPS_HOST 'journalctl -u rpow-server -f'"
echo "  ssh $VPS_HOST 'sudo tail -f /var/log/nginx/api.rpow2.com.access.log'"
