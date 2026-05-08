#!/usr/bin/env bash
# One-page health summary for the rpow VPS.
set -uo pipefail

bar () { echo "─────────────── $1 ───────────────"; }

bar "services"
for svc in rpow-server nginx postgresql rpow-backup.timer fail2ban ufw certbot.timer; do
    printf "  %-25s %s\n" "$svc" "$(systemctl is-active "$svc" 2>&1)"
done

bar "rpow-server liveness"
curl -sS -o /tmp/h -w "  HTTP %{http_code}, %{time_total}s\n" http://127.0.0.1:8080/health || true
cat /tmp/h; echo
rm -f /tmp/h

bar "rpow-server readiness"
curl -sS -o /tmp/rpow-ready -w "  HTTP %{http_code}, %{time_total}s\n" http://127.0.0.1:8080/ready || true
cat /tmp/rpow-ready; echo
rm -f /tmp/rpow-ready

bar "request rate (last 5 min)"
sudo journalctl -u rpow-server --since "5 minutes ago" --no-pager 2>/dev/null \
  | grep -c "request completed" \
  | awk '{printf "  %d requests / 5min (%.1f/sec)\n", $1, $1/300}'

bar "disk"
df -h / /var 2>/dev/null | awk 'NR<=3 {print "  "$0}'

bar "memory"
free -h | awk '{print "  "$0}' | head -2

bar "postgres"
sudo -u postgres psql -At -d rpow -c "SELECT pg_size_pretty(pg_database_size('rpow'));" 2>/dev/null \
    | sed 's/^/  rpow db size: /'
sudo -u postgres psql -At -d rpow -c "
  SELECT 'users='     || count(*) FROM users
  UNION ALL SELECT 'tokens_valid=' || count(*) FROM tokens WHERE state='VALID'
  UNION ALL SELECT 'transfers=' || count(*) FROM transfers
  UNION ALL SELECT 'pg_active='  || count(*) FROM pg_stat_activity WHERE state='active' AND datname='rpow';
" 2>/dev/null | sed 's/^/  /'

bar "TLS cert"
echo | openssl s_client -servername api.rpow2.com -connect 127.0.0.1:443 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | sed 's/^/  /'

bar "last backup"
sudo bash -c "set -a; source /etc/rpow/restic.env; set +a; restic snapshots --json --tag rpow 2>/dev/null" \
    | jq -r 'sort_by(.time) | .[-1] | "  \(.time)  id=\(.short_id)  \(.paths[0])"' \
    || echo "  (could not query)"

bar "fail2ban (sshd)"
sudo fail2ban-client status sshd 2>/dev/null \
    | grep -E "Currently|Total" \
    | sed 's/^/  /' \
    || true
