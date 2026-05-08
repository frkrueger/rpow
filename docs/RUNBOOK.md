# Operator Runbook

## Where things live

- **Server**: OVH VPS at `15.204.254.192` (Ubuntu 25.04, kernel 6.14). SSH: `ssh ubuntu@15.204.254.192`
- **Web SPA**: Netlify, deployed automatically from `main`.
- **DB**: PostgreSQL 17 on the same VPS, Unix-socket-only at `/var/run/postgresql`.
- **DNS**: Cloudflare, zone `rpow2.com`. `api.rpow2.com` is DNS-only (proxy off, TTL 60); apex and `www` stay proxied.
- **Email**: Resend.
- **Backups**: restic → Backblaze B2 bucket `rpow2-ovhbackup`, nightly at 03:00 UTC.

## One-page health check

```bash
ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-status'
```

## Health endpoints

- `GET /health`: lightweight liveness. It should answer when the node process is up.
- `GET /ready`: readiness. It should answer only when the API can serve traffic, including required dependencies such as Postgres.

Use `/ready` for restart watchdogs, smoke tests, load balancer checks, and external uptime monitors. Keep `/health` for quick process liveness checks and human debugging.

## Service recovery

Three layers (every layer has been tested):

| Failure mode | Recovery |
|---|---|
| node process crashes / clean exit | systemd restarts in ~2s (`Restart=always`, `RestartSec=2`, up to 10 starts per 5min before pause) |
| node process hung or dependencies unavailable | `rpow-healthcheck.timer` probes `/ready` every 90s; after 2 consecutive failures, runs `systemctl restart rpow-server`. Logs to `journalctl -t rpow-healthcheck` |
| nginx / Postgres crash | distro systemd units auto-restart |
| VPS reboot | all rpow services + nginx + postgresql + ufw + fail2ban + certbot.timer + rpow-backup.timer + rpow-healthcheck.timer are `enabled` — they come back on boot |
| TLS cert expiry | `certbot.timer` renews 30 days before expiry, fully unattended via Cloudflare DNS-01 |
| Backup repo corruption | restic does a 5% read-data integrity check on every nightly run; restore drill documented below |

## External uptime monitoring

The VPS-internal watchdog cannot report a dead VPS, broken DNS, or an upstream networking problem. Keep at least two off-box monitors:

| Monitor | URL | Expected | Cadence | Alert after |
|---|---|---|---|---|
| API readiness | `https://api.rpow2.com/ready` | HTTP 200 | 60s | 3 consecutive failures |
| Web entrypoint | `https://rpow2.com` | HTTP 200 | 60s | 3 consecutive failures |

`ops/uptime-monitors.example.yml` is a repo-native template for UptimeRobot, Better Stack, healthchecks.io, or an equivalent monitor. Put real destinations only in the monitor provider or in server-local files; do not commit webhook URLs, phone numbers, or API tokens.

Suggested alert destinations:

- Primary: `ALERT_WEBHOOK_URL` in the monitoring provider or `/etc/rpow/alerts.env` on the VPS.
- Secondary: `ops@example.com` placeholder until a real operator mailbox is chosen.

To inspect the watchdog's recent activity:
```bash
ssh ubuntu@15.204.254.192 'sudo journalctl -t rpow-healthcheck --since "1 hour ago"'
```

## Logs

```bash
ssh ubuntu@15.204.254.192 'sudo journalctl -u rpow-server -f'
ssh ubuntu@15.204.254.192 'sudo tail -f /var/log/nginx/api.rpow2.com.access.log'
ssh ubuntu@15.204.254.192 'sudo tail -f /var/log/nginx/api.rpow2.com.error.log'
ssh ubuntu@15.204.254.192 'sudo tail -f /var/log/postgresql/postgresql-17-main.log'
```

## Deploys

```bash
ssh ubuntu@15.204.254.192 '
  sudo -u rpow bash -c "cd /opt/rpow/repo && \
    git pull origin main && \
    npm ci --workspaces --include-workspace-root --ignore-scripts && \
    npm run build --workspace @rpow/shared && \
    npm run build --workspace @rpow/server" && \
  sudo systemctl restart rpow-server'
```

## Secrets / config files

| File | Mode | Owner | Purpose |
|---|---|---|---|
| `/etc/rpow/server.env` | 0640 | root:rpow | App env (DATABASE_URL, signing keys, Resend, etc.) |
| `/etc/rpow/restic.env` | 0600 | root:root | B2 creds + restic password |
| `/etc/rpow/alerts.env` | 0600 | root:root | Optional alert/report webhook URLs; no app secrets |
| `/etc/letsencrypt/cloudflare.ini` | 0600 | root:root | Cloudflare API token for DNS-01 |

After editing `server.env`: `sudo systemctl restart rpow-server`.

Example `/etc/rpow/alerts.env`:

```bash
ALERT_WEBHOOK_URL=https://example.invalid/rpow-alert-webhook
RESTORE_REPORT_WEBHOOK_URL=https://example.invalid/rpow-restore-report-webhook
```

## Difficulty changes

```bash
ssh ubuntu@15.204.254.192 '
  sudo sed -i "s/^DIFFICULTY_BITS=.*/DIFFICULTY_BITS=30/" /etc/rpow/server.env && \
  sudo systemctl restart rpow-server'
```

## Backup operations

- **Nightly**: `rpow-backup.timer` at 03:00 UTC (with up to 5min jitter).
- **Manual**: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-backup'`
- **Failure alerting**: `rpow-backup` sources optional `/etc/rpow/alerts.env`. If `ALERT_WEBHOOK_URL` is set, failures post a plain-text alert there; otherwise failures are logged to journald under `rpow-backup`.
- **Restore drill**: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-restore-test'` — restores latest snapshot into a scratch DB, prints row counts, and reports the result. Run weekly to keep restic + creds healthy.
- **Restore reporting**: `rpow-restore-test` posts success and failure reports to `RESTORE_REPORT_WEBHOOK_URL` if set, then falls back to `ALERT_WEBHOOK_URL`, then journald under `rpow-restore-test`.
- **List snapshots**: `ssh ubuntu@15.204.254.192 'sudo bash -c "set -a; . /etc/rpow/restic.env; set +a; restic snapshots"'`
- **Retention**: 7 daily, 4 weekly, 6 monthly. 5% read-data integrity check on each backup.

## TLS renewals

Auto-renewing via certbot's systemd timer. No human action needed.

```bash
ssh ubuntu@15.204.254.192 'systemctl list-timers certbot.timer'
ssh ubuntu@15.204.254.192 'sudo certbot renew --dry-run'   # exercise the flow
```

## Rotating the signing key

Edit `RPOW_SIGNING_PRIVATE_KEY_HEX` and `RPOW_SIGNING_PUBLIC_KEY_HEX` in `/etc/rpow/server.env`, then `sudo systemctl restart rpow-server`. Existing minted tokens become unverifiable if the private key changes — coordinate carefully.

## Database access

```bash
# Read-only inspection as ubuntu
ssh ubuntu@15.204.254.192 'sudo -u postgres psql rpow'

# As the rpow_app role over Unix socket (password from .env.vps locally)
DBPW=$(grep '^RPOW_DB_PASSWORD=' .env.vps | cut -d= -f2-)
ssh ubuntu@15.204.254.192 "PGPASSWORD='$DBPW' psql -h /var/run/postgresql -U rpow_app -d rpow"
```

## Common tasks

- **Reset a user's account (testing)**:
  ```sql
  DELETE FROM tokens WHERE owner_email='X';
  DELETE FROM transfers WHERE sender_email='X' OR recipient_email='X';
  DELETE FROM pending_transfers WHERE sender_email='X' OR recipient_email='X';
  DELETE FROM users WHERE email='X';
  ```

## Cloudflare DNS records

- Zone `rpow2.com` ID: `685720286628e21c9b43f260ac6b63bf`
- `api.rpow2.com` A record ID: `34daa777f0dbbdbd1e3c97d6c12e9837` (TTL 60, DNS-only)
- `api.rpow2.com` AAAA record ID: `1cfb2458cc028a8f95bea16a439bff6c` (TTL 60, DNS-only)

To re-flip A record (e.g. failover to a hot-standby VPS):
```bash
CF=$(grep '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2-)
curl -X PATCH \
  -H "Authorization: Bearer $CF" -H "Content-Type: application/json" \
  --data '{"content": "<new-ip>"}' \
  https://api.cloudflare.com/client/v4/zones/685720286628e21c9b43f260ac6b63bf/dns_records/34daa777f0dbbdbd1e3c97d6c12e9837
```

## Incident: VPS down or compromised

- Cloudflare DNS will not auto-failover. Existing backups are in B2.
- Recovery sequence: provision new VPS, replay Tasks 1–7 of `docs/superpowers/plans/2026-05-07-fly-to-vps-migration.md`, then `restic restore` the latest snapshot into a fresh `rpow` DB, then flip DNS A/AAAA via the Cloudflare API.
- Cert can be re-issued in minutes via DNS-01 (token already in CF; just put it back at `/etc/letsencrypt/cloudflare.ini`).

## Migration history

- 2026-05-07: spec + plan written.
- 2026-05-08 04:50–04:54 UTC: cutover from Fly.io+Neon to OVH VPS+self-hosted PG17. ~120s user-visible interruption, zero committed-data loss verified by row-count parity gate. Perf: `/mint` p50 went from 84,000ms (Fly+Neon) to 57ms (VPS+local PG).

See `docs/superpowers/specs/2026-05-07-fly-to-vps-migration-design.md` for the full design and `docs/superpowers/plans/2026-05-07-fly-to-vps-migration.md` for the implementation plan.
