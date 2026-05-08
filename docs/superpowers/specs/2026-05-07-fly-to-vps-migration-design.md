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
| Cutover | Single path: pg_dump/pg_restore at low-traffic hour | DB is only 294 MB → dump+restore is ~60–90s of write-paused time. Far simpler than logical replication; sequences carry over automatically; eliminates Neon-tier dependency |
| DNS / TLS | Cloudflare DNS (already migrated); LE cert via DNS-01 with Cloudflare API token | Auto-renewing certs forever; scriptable cutover; api.rpow2.com is **DNS-only** (proxy off), apex stays proxied |
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

## Database migration — pg_dump / pg_restore

Single-path cutover. DB size is 294 MB → dump+restore in ~60–90s. Logical-replication complexity (Neon-tier dependency, sequences gotcha, more moving parts) buys nothing meaningful at this size.

### Pre-cutover (T-24h to T-1h)

- VPS fully built: hardening done, Postgres + nginx + rpow-server installed, env vars in `/etc/rpow/server.env`.
- LE cert for `api.rpow2.com` already issued via DNS-01 + Cloudflare API token (works because the cert request only needs a TXT record, not actual A-record routing).
- Local Postgres has the schema applied (from `apps/server/migrations/`) and is empty.
- rpow-server running on VPS, smoke-tested via `curl --resolve api.rpow2.com:443:<vps-ip> ...` against an empty DB.
- Cloudflare A-record TTL for `api.rpow2.com` lowered to 60s (already DNS-only after this design).
- Pre-cutover **safety dump**: `pg_dump -Fc <neon> > /opt/rpow/safety-dump-<utc>.dump` archived to B2 immediately. This is the rollback artifact if anything goes sideways.

### Cutover sequence (target ~120s user-visible interruption)

```
T+0s    flyctl scale count 0 --app rpow2-server
        → Fly app fully stopped. No writes can reach Neon.

T+10s   Verify quiescence on Neon:
          SELECT pid, usename, state, query
          FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active';
        → expect zero rows other than our own session.

T+20s   pg_dump -Fc -d <neon-url> -f /tmp/rpow-cutover.dump
        → ~10s.

T+40s   pg_restore -d rpow --clean --if-exists /tmp/rpow-cutover.dump
        → ~30s. Sequences restored automatically.

T+90s   VERIFICATION GATE — row-count parity:
          run pre-prepared SQL on both Neon and VPS, comparing
          count(*) for every table. Any mismatch → ABORT (see rollback).

T+95s   systemctl start rpow-server  (VPS app now live, but no DNS yet)

T+100s  Smoke test via --resolve:
          /health
          full e2e: magic-link → mint → transfer → ledger
          token-verify against a pre-cutover token (proves signing key carried correctly)

T+120s  VERIFICATION GATE — all smoke tests pass?
        Any failure → ABORT (rollback below).

T+125s  Cloudflare API: PATCH api.rpow2.com A-record content → VPS IP,
        AND AAAA → VPS IPv6 (or DELETE AAAA if no IPv6 on VPS).
        Both records as a single batch. With 60s TTL + DNS-only,
        resolvers catch up in ~30–60s; browser DNS cache extends
        worst-case to ~120s.

T+200s  Monitor /health, journalctl, nginx logs, postgres logs for ~30 min.
```

### Rollback (each verification gate is a fork)

- **Before T+125s (DNS flip):** simply `flyctl scale count 1 --app rpow2-server`. Neon was untouched (our session was read-only). Site resumes on Fly. The dump is discarded, the cause investigated, retry later. **Zero data loss; ~2 min outage.**
- **After T+125s, within 5 min:** revert the Cloudflare A-record back to Fly's IP, then `flyctl scale count 1`. Any writes that hit the VPS in the gap are stranded; recover from VPS DB by `pg_dump`-ing the affected rows and replaying onto Neon. Document the recovery script in the runbook in advance.
- **After T+125s, beyond 5 min:** treat the VPS as authoritative; troubleshoot in place. Never roll back to Neon at this point (it has stale data).

### Defense in depth

1. Pre-cutover safety dump uploaded to B2 before T+0.
2. Two human-in-the-loop verification gates with explicit pass/fail criteria.
3. Pre-prepared row-count parity SQL (committed to repo before cutover day).
4. Pre-prepared smoke-test script (committed to repo before cutover day).
5. Neon project kept alive for 7 days post-cutover as a frozen reference (don't delete the project until soak passes).

### In-flight mining: no RPOW lost

The challenge/mint design is already cutover-safe because the challenge state lives in the `challenges` table (5-min TTL), not in app memory:

1. `/challenge` writes a row with `id`, `nonce_prefix`, `difficulty_bits`, `expires_at`. Client gets the values back.
2. Client mines locally (~30s) — pure CPU, no server state changes.
3. `/mint` re-reads the row `FOR UPDATE`, validates `claimed_at IS NULL`, expiry, and hash; sets `claimed_at`; inserts the token.

A challenge issued pre-cutover is captured in the `pg_dump`, restored on the VPS, and queryable by its UUID. When the miner's `/mint` lands on the new server (after DNS flip + retry), the same row is there waiting — validates, mints, returns the token. **No mined work is wasted as long as the user retries.**

Concrete protections already in code that span servers:
- `pg_advisory_xact_lock` on the supply check → no race even across server changeover.
- `FOR UPDATE` on the challenge row → at most one `/mint` succeeds per challenge.
- `transfers.idempotency_key UNIQUE` and `pending_transfers.claim_token_hash UNIQUE` → no double-spend or double-claim possible.

**Optional mitigation for extra-slow miners on cutover day:** the day of cutover, deploy a one-line change to Fly extending the challenge TTL from 5 min to 15 min:

```ts
const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
```

Revert post-migration. Costs nothing, prevents the rare case where a challenge issued >4.5 min pre-cutover would expire during the dump/restore window. Decide at impl time whether to bother (~5 lines of plan time).

### Pre-cutover token-verify check

To prove the signing key carried correctly: take one existing token from Neon (any `token_id` from the `tokens` table), keep its hex/JSON aside. After T+95s on the VPS, hit `POST /verify` (or whatever the verification endpoint is — confirm during impl) with that token. If it verifies, the Ed25519 private key was carried correctly. If it doesn't, **do not flip DNS** — the signing key is wrong and all post-flip user activity will produce tokens incompatible with pre-flip ones.

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
| Lost signing key on Fly secrets | Low | Catastrophic (all tokens void) | Capture from Fly secrets BEFORE touching Fly; verify on VPS via pre-cutover token-verify check; explicit gate before DNS flip |
| Row-count mismatch after restore | Low | High (silent data loss) | Pre-prepared parity SQL run as gate at T+90s; abort if any mismatch |
| VPS disk fills (Postgres + WAL + logs) | Med | High | Disk monitor in `rpow-status`; logrotate; restic prune; alert at 80% |
| Single-host failure | Low | Total outage | Backups + documented restore drill; HA out of scope for v1 |
| Let's Encrypt rate limit during testing | Low | Stuck without TLS | Use `--staging` for first cert; switch to prod once issuance flow works |
| Forgot to carry an env var | Low | Various breakage | Explicit env-var checklist; `rpow-server` fails fast on missing required vars (already in `env.ts`) |
| DNS resolver caches old A-record beyond TTL | Med | Some users see 503 for 5-10 min | TTL = 60s well in advance; Fly's old IP returns connection refused (not stale data); affected users retry |
| Neon read at `pg_dump` time fails | Low | Cutover aborts at T+20s | Safety dump from T-1h is still a fallback; restart Fly and retry |

## Success criteria

- `https://api.rpow2.com/health` returns 200 from VPS, with valid Let's Encrypt cert.
- A magic-link login → mint → transfer flow works end-to-end against the VPS.
- Existing tokens minted before cutover still verify (proves signing key was carried correctly).
- p50 `/health` round-trip < 50 ms from a US client (down from whatever Fly+Neon was doing).
- Nightly backup runs and restic verifies. Test restore succeeds into a scratch DB.
- Fly app destroyed, no surprise charges next month.

## Resolved (post-design)

- **Data size on Neon:** ~294 MB (project `rpow2`, AWS us-east-1). Small enough that `pg_dump` over the wire is ~10s.
- **Fly cron / extra machines:** none. Single app machine; cutover doesn't coordinate with anything else.
- **Cutover path:** committed to **dump/restore** (single path). Logical replication dropped from the plan — the complexity isn't justified at 294 MB.
- **Staging hostname:** none. Smoke-test via `curl --resolve api.rpow2.com:443:<vps-ip> https://api.rpow2.com/...`.
- **DNS:** already on Cloudflare. Registrar (GoDaddy) NS = mira/trey.ns.cloudflare.com; zone status active; propagation in progress (Google's resolver already updated). All email records (DMARC, DKIM, SPF, MX) imported correctly.
- **Cloudflare proxy mode:** `api.rpow2.com` is **DNS-only** (proxy off, both A and AAAA — flipped via API on 2026-05-07). Apex `rpow2.com` and `www.rpow2.com` stay proxied — they're for the Netlify-hosted SPA which benefits from edge caching.
- **Cloudflare API token:** scoped to `rpow2.com` zone, perms `Zone:Read + Zone:DNS:Edit`, never expires. Stored locally in `rpow/.env` as `CLOUDFLARE_API_TOKEN`. Will live on the VPS at `/etc/letsencrypt/cloudflare.ini` (mode 0600) for cert renewals.
- **TLS issuance:** DNS-01 challenge via certbot-dns-cloudflare. Cert provisioned **before** any DNS flip (DNS-01 only needs a TXT record, not the A-record we're cutting over). Auto-renewal via cron/systemd-timer thereafter.
- **Cloudflare zone ID:** `685720286628e21c9b43f260ac6b63bf` (cached for cutover script). DNS record IDs: A=`34daa777f0dbbdbd1e3c97d6c12e9837`, AAAA=`1cfb2458cc028a8f95bea16a439bff6c`.
- **TTL:** set to 60s on `api.rpow2.com` A and AAAA records on 2026-05-07 (Cloudflare Free's minimum). Bounds the propagation tail at cutover to ≤2 minutes for ~all clients.
- **Cutover style:** **Style A — single-hostname DNS flip.** PATCH `api.rpow2.com` A-record content from Fly IP to VPS IP via Cloudflare API at T+125s. One hostname, simplest, ~2-min bounded propagation. Style B (Netlify-led with `api2.rpow2.com`) considered and rejected — added complexity for marginal gain on this site's user behavior.
- **IPv6:** OVH typically assigns a /128 to each VPS. During VPS setup, capture the assigned IPv6 with `ip -6 addr show`. At cutover, PATCH the AAAA record alongside the A record. (If the VPS turns out to have no IPv6 — unlikely — DELETE the AAAA record at cutover instead. This avoids split-brain where IPv6-preferring clients hit dead Fly.)
- **Netlify:** no changes. SPA's `VITE_API_BASE_URL=https://api.rpow2.com` is hostname-only; the IP it resolves to changes but the URL doesn't. No rebuild required.
