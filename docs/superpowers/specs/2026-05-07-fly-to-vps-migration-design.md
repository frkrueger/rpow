# rpow: Fly.io → OVH VPS Migration

**Status:** design (pending review)
**Date:** 2026-05-07
**Author:** fred + Claude
**Target server:** `ubuntu@15.204.254.192` (OVH, ~4–8 GB RAM, 2–4 vCPU, Ubuntu)

## Goal

Move the rpow API (currently `api.rpow2.com` on Fly.io, iad) and its Postgres database (currently Neon Free) onto a single self-hosted Ubuntu VPS, with a near-zero-downtime cutover so the ~500 active users see at most a few seconds of read-only behavior. Address the perceived slowness on Fly (most likely Neon serverless cold-starts) by collocating Postgres with the app over a Unix socket.

**Out of scope:** the web SPA (`rpow2.com`) stays on Netlify; Resend stays as the email provider; GoDaddy stays as the registrar.

## Target architecture

```
                  Internet (HTTPS)
                        │
                        ▼
              [Netlify CDN]                    rpow2.com  (web SPA, unchanged)
                        │
                        ▼ XHR
              api.rpow2.com  ──►  [VPS @ 15.204.254.192]
                                       ├─ nginx (TLS via Let's Encrypt, reverse proxy :443→127.0.0.1:8080)
                                       ├─ rpow-server.service  (Node 22, Fastify, systemd)
                                       └─ postgresql-16  (local, listens on Unix socket only)

  off-box (nightly): pg_dump + WAL archiving via restic → Backblaze B2 (encrypted, 30-day retention)
```

**Why this shape:** the app is essentially stateless and small. The single biggest perf win is replacing Neon's network-attached serverless Postgres with a local Postgres reachable over a Unix socket — sub-millisecond instead of tens of ms per query, and no cold-start penalty.

## Decisions and tradeoffs

| Decision | Choice | Reason |
|---|---|---|
| Compute | Single OVH VPS | 500 users on a hashcash app is small; HA is not justified yet |
| DB | Self-hosted Postgres 16 on same box | Eliminates Neon cold-starts; Unix-socket latency; one bill |
| Web | Stays on Netlify | Already free + CDN-edged; moving it gains nothing |
| Reverse proxy | nginx | Handles TLS, gzip, static error pages; well-trodden |
| TLS | Let's Encrypt via certbot | Free, auto-renewing |
| Backups | restic → Backblaze B2 | Cheap (~$6/TB/mo), encrypted, S3-compatible |
| Cutover | Logical replication if Neon Free supports it; else dump/restore at low-traffic hour | Both feasible; logical-repl preferred for ~zero downtime |
| Process supervisor | systemd | Native, no extra dep |
| Secrets | `/etc/rpow/server.env`, mode 0640, root:rpow | Standard pattern, readable only by app user |
| Postgres bind | localhost / Unix socket only | No external port; eliminates an attack surface |
| Deploy | `git pull && npm ci && npm run build && systemctl restart rpow-server` | Matches existing repo build; no Docker needed |

## Hardening checklist (one-time, before user traffic)

- SSH: `PasswordAuthentication no`, `PermitRootLogin no`, key already installed
- UFW: default-deny inbound, allow `22/tcp`, `80/tcp`, `443/tcp`
- `fail2ban` watching sshd (default jail)
- `unattended-upgrades` enabled for security updates
- Time sync via systemd-timesyncd (default)
- Non-root system user `rpow` (`/opt/rpow` home, no shell login)
- Postgres `listen_addresses = ''` + `unix_socket_directories = '/var/run/postgresql'`
- `/etc/rpow/server.env` mode `0640`, owner `root:rpow`
- Hostname set to a memorable label; `/etc/hosts` updated

Hardening that is **not** in v1 (intentional): port-knocking, custom SSH port, IDS/HIDS, 2FA on SSH. Cost > value at this scale.

## Software install plan

| Software | Source | Version | Notes |
|---|---|---|---|
| Node.js | NodeSource apt repo | 22.x | Matches `engines.node` and Fly's runtime |
| PostgreSQL | PGDG apt repo | 16 | Matches local dev (`postgres:16` in README) |
| nginx | Ubuntu apt | distro default (≥1.24) | Sufficient |
| certbot | snap or apt | current | `--nginx` plugin |
| restic | apt | current | For B2 backups |
| ufw, fail2ban, unattended-upgrades | apt | current | Hardening |

## App layout on VPS

```
/opt/rpow/                       (owned by rpow:rpow)
  repo/                          git clone of github.com/<user>/rpow
    apps/server/dist/...         build output
    apps/server/migrations/      migration SQL
    node_modules/
  bin/
    rpow-deploy                  pull → build → migrate → restart
    rpow-status                  one-page health: service, disk, last backup
/etc/rpow/
  server.env                     systemd EnvironmentFile (mode 0640, root:rpow)
/etc/systemd/system/
  rpow-server.service
/etc/nginx/sites-enabled/
  api.rpow2.com.conf
```

### systemd unit (sketch)

```ini
[Unit]
Description=rpow API server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=rpow
Group=rpow
WorkingDirectory=/opt/rpow/repo
EnvironmentFile=/etc/rpow/server.env
ExecStart=/usr/bin/node apps/server/dist/server.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/rpow/repo
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### nginx config (sketch)

```nginx
server {
    listen 443 ssl http2;
    server_name api.rpow2.com;

    ssl_certificate     /etc/letsencrypt/live/api.rpow2.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.rpow2.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 1m;          # rpow request bodies are tiny

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name api.rpow2.com;
    return 301 https://$host$request_uri;
}
```

(certbot's `--nginx` will own most of the TLS lines; sketch above is post-bootstrap state.)

### Env vars to carry over from Fly secrets

Required (per `apps/server/src/env.ts`):
- `DATABASE_URL` — **changes** to `postgres:///rpow?host=/var/run/postgresql`
- `SESSION_SECRET` — **carry exactly** (changing logs everyone out)
- `RPOW_SIGNING_PRIVATE_KEY_HEX` — **carry exactly** (changing invalidates all minted tokens)
- `RPOW_SIGNING_PUBLIC_KEY_HEX` — carry exactly
- `RESEND_API_KEY`, `EMAIL_FROM`
- `DIFFICULTY_BITS`, `DIFFICULTY_FLOOR`
- `MINT_EPOCH_SIZE`, `MINT_MAX_SUPPLY`
- `MAGIC_LINK_BASE_URL=https://api.rpow2.com`, `WEB_ORIGIN=https://rpow2.com`
- `NODE_ENV=production`, `PORT=8080`

Capture via `flyctl ssh console --app rpow2-server` then `env | grep ...`, or `flyctl secrets list` + the original generation site for any opaque ones. **Never commit these to git.**

## Database migration

### Path A — logical replication (preferred)

Pre-flight: against Neon, run `SHOW wal_level;`. If `logical`, proceed.

1. On VPS, `pg_dump --schema-only --no-owner --no-privileges` from Neon, restore into local `rpow` DB.
2. On Neon: `CREATE PUBLICATION rpow_pub FOR ALL TABLES;`
3. On VPS: `CREATE SUBSCRIPTION rpow_sub CONNECTION '<neon-url>' PUBLICATION rpow_pub;`
4. Wait for `pg_stat_subscription` to show `received_lsn ≈ pg_current_wal_lsn` on Neon (lag < 1s).
5. Pre-cutover (T-24h): drop `api.rpow2.com` DNS TTL to 60s.
6. Cutover (~30s):
   1. Stop the Fly app: `flyctl scale count 0 --app rpow2-server`. With no app, no writes can hit Neon.
   2. Verify replication caught up to last LSN.
   3. **Bump sequences on VPS** to match Neon — logical replication does NOT replicate sequence values. Iterate every sequence with `SELECT setval('seq_name', (SELECT MAX(id) FROM table_name));`.
   4. `DROP SUBSCRIPTION rpow_sub;` (disables replication; VPS DB is now authoritative).
   5. Start the rpow service on the VPS: `systemctl start rpow-server`.
   6. Smoke test: `curl https://<vps-ip>/health` (with Host header), then with DNS still pointing at Fly's last IP, hit the VPS by IP via `--resolve`.
   7. Flip DNS A record `api.rpow2.com` → `15.204.254.192`. With 60s TTL, traffic transitions over ~1–2 min.
7. Verification: hit `/health`, manually mint + transfer + check `/ledger`. Watch `journalctl -u rpow-server -f` and Postgres logs for ~30 min.
8. After 48h soak, decommission Fly: `flyctl apps destroy rpow2-server`.

**Gotcha — sequences:** the most common silent failure mode for logical replication. The mitigation is step 6.iii above, run as a one-shot SQL script generated from `pg_class` lookup. Spec the script before cutover; do not improvise.

**Gotcha — `pg_publication_tables` schema drift:** if Neon and VPS Postgres versions diverge, a column mismatch can surface during initial copy. Mitigation: pin VPS to PG 16 (Neon's current default).

### Path B — dump/restore at low-traffic hour (fallback)

If Neon Free tier blocks logical replication (or it misbehaves):

1. All hardening + app setup done as in Path A.
2. Schedule cutover for low-traffic window (pick from server logs).
3. Sequence:
   1. `flyctl scale count 0 --app rpow2-server` — site goes 503.
   2. `pg_dump -Fc <neon-url> > rpow.dump` (expect <1 min for current data size).
   3. `pg_restore -d rpow rpow.dump` on VPS (sequences come along automatically here).
   4. Start `rpow-server` on VPS.
   5. Smoke test by IP.
   6. Flip DNS A record.
4. Expected user-visible outage: ~5–10 min.

Prepare both paths; decide which to run after the pre-flight `SHOW wal_level` check.

## Backups (B2)

- B2 bucket: `rpow2-ovhbackup` (bucket ID `26655ddc93da075a9fe70216`), application key restricted to write+list on this bucket.
- Application key + key ID are stored locally in `rpow/.env` (gitignored) as `B2_KEY_ID` / `B2_APP_KEY`. These will be transferred to the VPS at `/etc/rpow/restic.env` (mode `0600`, owned `root:root`) over the existing SSH session — never via git, paste-buffer, or unencrypted transport.
- Restic repo at `b2:rpow2-ovhbackup:restic`, init password generated on the VPS and stored in the same `restic.env`.
- Cron / systemd timer: nightly 03:00 UTC.
- Snapshot script:
  ```bash
  pg_dump -Fc rpow | restic backup --stdin --stdin-filename rpow-$(date -u +%F).dump
  restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
  ```
- WAL archiving: `archive_mode=on`, `archive_command` ships WAL segments via restic. (Optional in v1 — adds PITR but more moving parts. Decide during impl.)
- **Restore drill** documented in RUNBOOK; perform once before cutover and again 1 week after. A backup that hasn't been restored is not a backup.

## Operations

### Deploy

```bash
sudo /usr/local/bin/rpow-deploy
# pulls origin/main, runs npm ci, builds shared+server, runs migrations, restarts service
```

Migrations: the existing `apps/server/migrations/` directory holds the SQL. The deploy script applies any new files (idempotent — name files `NNN_description.sql`, track `applied_migrations` table).

### Logs

- App: `journalctl -u rpow-server -f`
- nginx: `/var/log/nginx/{access,error}.log`
- Postgres: `/var/log/postgresql/postgresql-16-main.log`

### Health

- Fastify already exposes `/health`. nginx proxies it. External monitoring (UptimeRobot or similar) can be added later — not in v1.
- `rpow-status` script prints: service status, last deploy, free disk, last backup timestamp.

### Rollback

- **During cutover**: flip DNS back to Fly. Because Fly was scaled to 0 (no writes), the Neon DB is unchanged — clean revert. The VPS DB diverges only by whatever traffic hit the VPS in the gap; if that gap is <1 min, accept it as data loss in the rollback path or replay nginx access logs.
- **Post-cutover (>48h)**: rolling back means restoring a backup onto a fresh Fly+Neon stack. Cost is real; this is why the 48h soak matters.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sequences out-of-sync after logical-repl cutover | Med | High (PK collisions) | Explicit `setval` script in cutover step |
| Neon Free blocks logical replication | Med | Low | Path B fallback ready; cutover at low-traffic hour |
| Lost signing key on Fly secrets | Low | Catastrophic (all tokens void) | Capture key BEFORE touching Fly; verify on VPS before flip |
| VPS disk fills (Postgres + WAL + logs) | Med | High | Disk monitor in `rpow-status`; logrotate; restic prune |
| Single-host failure | Low | Total outage | Backups + documented restore; HA out of scope for v1 |
| Let's Encrypt rate limit during testing | Low | Stuck without TLS | Use `--staging` for first cert; switch to prod once nginx is happy |
| Forgot to update `MAGIC_LINK_BASE_URL` | Low | Magic-link emails point at wrong host | Already in env carry-over checklist |

## Success criteria

- `https://api.rpow2.com/health` returns 200 from VPS, with valid Let's Encrypt cert.
- A magic-link login → mint → transfer flow works end-to-end against the VPS.
- Existing tokens minted before cutover still verify (proves signing key was carried correctly).
- p50 `/health` round-trip < 50 ms from a US client (down from whatever Fly+Neon was doing).
- Nightly backup runs and restic verifies. Test restore succeeds into a scratch DB.
- Fly app destroyed, no surprise charges next month.

## Open questions for impl plan

- Exact data size on Neon (informs whether Path A is overkill).
- Are there scheduled Fly cron jobs / machines beyond the one app? (Spec assumes single app machine.)
- Do we want a staging hostname (`api-staging.rpow2.com`) on the VPS for the smoke-test step, or is `--resolve` to the IP sufficient?
