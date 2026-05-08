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

## Service recovery

Three layers (every layer has been tested):

| Failure mode | Recovery |
|---|---|
| node process crashes / clean exit | systemd restarts in ~2s (`Restart=always`, `RestartSec=2`, up to 10 starts per 5min before pause) |
| node process hung but alive (deadlock, infinite loop) | `rpow-healthcheck.timer` probes `/health` every 90s; after 2 consecutive failures, runs `systemctl restart rpow-server`. Logs to `journalctl -t rpow-healthcheck` |
| nginx / Postgres crash | distro systemd units auto-restart |
| VPS reboot | all rpow services + nginx + postgresql + ufw + fail2ban + certbot.timer + rpow-backup.timer + rpow-healthcheck.timer are `enabled` — they come back on boot |
| TLS cert expiry | `certbot.timer` renews 30 days before expiry, fully unattended via Cloudflare DNS-01 |
| Backup repo corruption | restic does a 5% read-data integrity check on every nightly run; restore drill documented below |

**Recommended addition (not yet wired)**: an external uptime monitor (e.g. free UptimeRobot or healthchecks.io) hitting `https://api.rpow2.com/health` every minute, paging when 3+ consecutive failures. The VPS-internal watchdog can't help if the whole box is dead — only an off-box monitor can.

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
| `/etc/letsencrypt/cloudflare.ini` | 0600 | root:root | Cloudflare API token for DNS-01 |

After editing `server.env`: `sudo systemctl restart rpow-server`.

## Difficulty changes

```bash
ssh ubuntu@15.204.254.192 '
  sudo sed -i "s/^DIFFICULTY_BITS=.*/DIFFICULTY_BITS=30/" /etc/rpow/server.env && \
  sudo systemctl restart rpow-server'
```

## Backup operations

- **Nightly**: `rpow-backup.timer` at 03:00 UTC (with up to 5min jitter).
- **Manual**: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-backup'`
- **Restore drill**: `ssh ubuntu@15.204.254.192 'sudo /usr/local/bin/rpow-restore-test'` — restores latest snapshot into a scratch DB and prints row counts. Run weekly to keep restic + creds healthy.
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

## SRPOW + halving rollout (one-time)

This is the operator-facing sequence to launch the SRPOW SPL token on Solana mainnet, mint the 1.1M satoshi allocation, lower the cap to 19.9M, and cut over to the halving + wrap-enabled server. Follow the steps in order — most steps depend on outputs from earlier steps.

The canonical design lives in `docs/superpowers/specs/2026-05-08-srpow-wrap-design.md`. The section below is the operational checklist.

### 1. Pre-flight checklist

Before running any commands, gather:

- **Solana mainnet RPC URL** (Helius / QuickNode / Triton). Free tier is fine. Save it as `SOLANA_RPC_URL`.
- **~0.06 SOL on a personal Phantom**: 0.05 to fund the bridge keypair, ~0.01 for the Metaplex metadata tx, plus buffer.
- **Operator wallet pubkey** for the satoshi allocation: `DG2S4KC3GFFVYGipSZeHDYoWyU8dhkeUqW2bvZcy8DZo`.
- **Local checkout on the `srpow-wrap` branch** with `npm install` complete.
- **Local Postgres** running, optional — only needed if you want to dry-run migrations 008–010 before merging.

### 2. Generate the bridge keypair

```bash
npm run create-srpow-mint --workspace @rpow/server -- --init-keys
```

Output is two lines:

```
BRIDGE_PUBKEY=<base58>
BRIDGE_KEYPAIR_BASE58=<base58 secret>
```

**Save the keypair somewhere secure** (1Password / encrypted file / age-encrypted in a private repo). It is needed in steps 4, 5, 7, 8, 9, and 10. If you lose it, the SRPOW mint authority is unrecoverable.

### 3. Fund the bridge

Send **0.05 SOL** from your personal Phantom to `BRIDGE_PUBKEY` (from step 2). Wait for confirmation on Solscan.

### 4. Create the SRPOW SPL mint

```bash
SOLANA_RPC_URL=https://... \
BRIDGE_KEYPAIR_BASE58=<from step 2> \
npm run create-srpow-mint --workspace @rpow/server
```

Output: one line starting with `SRPOW_MINT_ADDRESS=`. Save it.

**Verify on `https://solscan.io/token/<SRPOW_MINT_ADDRESS>`**:

- `decimals = 9`
- `freeze authority = null`
- `mint authority = <BRIDGE_PUBKEY from step 2>`
- `supply = 0`

If any of these are wrong, stop and investigate before continuing.

### 5. Mint the satoshi allocation

```bash
SOLANA_RPC_URL=https://... \
BRIDGE_KEYPAIR_BASE58=<from step 2> \
SRPOW_MINT_ADDRESS=<from step 4> \
SATOSHI_RECIPIENT_PUBKEY=DG2S4KC3GFFVYGipSZeHDYoWyU8dhkeUqW2bvZcy8DZo \
npm run mint-satoshi-allocation --workspace @rpow/server
```

Output: tx signature + Solscan link. Refresh `https://solscan.io/token/<SRPOW_MINT_ADDRESS>` and confirm `supply = 1,100,000.000000000`.

### 6. Set up the Streamflow vesting stream

Operator action — not scripted.

1. Open `https://streamflow.finance` and connect the recipient wallet (`DG2S4KC3GFFVYGipSZeHDYoWyU8dhkeUqW2bvZcy8DZo`).
2. Create a new stream with:
   - **Token**: SRPOW (paste the mint address from step 4).
   - **Amount**: `1,100,000`.
   - **Recipient**: your destination wallet for the vested tokens (can be the same wallet, or a separate cold wallet).
   - **Duration**: 1 year linear, **no cliff**.
3. Approve the Streamflow stream-creation transaction. Streamflow's escrow account now custodies the 1.1M; the recipient claims linearly over the year.

### 7. Upload the logo to Arweave

The PNG is at `apps/web/public/srpow-logo.png` in the worktree.

Easiest tool: the Irys CLI (pays in SOL from the bridge keypair).

```bash
npm i -g @irys/cli
irys upload apps/web/public/srpow-logo.png \
  -t solana -w <bridge keypair file> \
  -n mainnet --provider-url $SOLANA_RPC_URL
```

(`<bridge keypair file>` = a JSON file containing the 64-byte secret-key array, decoded from `BRIDGE_KEYPAIR_BASE58`. The Solana CLI / `solana-keygen recover` can produce this format.)

Output: a URL like `https://gateway.irys.xyz/<txid>`. **Save this URL.**

### 8. Upload the metadata JSON to Arweave

1. Edit `apps/web/public/srpow-token-metadata.template.json`. Replace `REPLACE_WITH_ARWEAVE_IMAGE_URL` with the URL from step 7. Save as a different filename, e.g. `srpow-token-metadata.json`. **Do not commit this file** — it has the one-off Arweave image URL embedded.
2. Upload it the same way:
   ```bash
   irys upload apps/web/public/srpow-token-metadata.json \
     -t solana -w <bridge keypair file> \
     -n mainnet --provider-url $SOLANA_RPC_URL
   ```
3. **Save the resulting URL** — this is `SRPOW_METADATA_URI` for the next step.

### 9. Set the on-chain Metaplex metadata

```bash
SOLANA_RPC_URL=https://... \
BRIDGE_KEYPAIR_BASE58=<from step 2> \
SRPOW_MINT_ADDRESS=<from step 4> \
SRPOW_METADATA_URI=<from step 8> \
npm run set-srpow-metadata --workspace @rpow/server
```

Output: tx signature. Refresh `https://solscan.io/token/<SRPOW_MINT_ADDRESS>` after a minute — name, symbol, and logo should now render. Confirm the same in Phantom (search for the mint address; the token should display with logo).

### 10. Update VPS environment

SSH to the VPS and edit `/etc/rpow/server.env` to add the SRPOW vars and lower the cap from 21M to 19.9M (since 1.1M is now allocated to the operator):

```bash
ssh ubuntu@15.204.254.192 'sudo bash -c "
  sed -i.bak \"/^MINT_MAX_SUPPLY=/d\" /etc/rpow/server.env
  echo MINT_MAX_SUPPLY=19900000 >> /etc/rpow/server.env
  echo SOLANA_RPC_URL=https://... >> /etc/rpow/server.env
  echo SRPOW_MINT_ADDRESS=<from step 4> >> /etc/rpow/server.env
  echo BRIDGE_KEYPAIR_BASE58=<from step 2> >> /etc/rpow/server.env
  echo WRAP_ALLOWED_EMAILS=frk314@gmail.com >> /etc/rpow/server.env
  echo SRPOW_COMMITMENT=confirmed >> /etc/rpow/server.env
"'
```

Verify:

```bash
ssh ubuntu@15.204.254.192 'sudo grep -E "^(MINT_MAX_SUPPLY|SOLANA_RPC_URL|SRPOW_|BRIDGE_KEYPAIR_BASE58|WRAP_ALLOWED_EMAILS)=" /etc/rpow/server.env'
```

**Do not restart the server yet** — restart happens after the code merge in the next step, so the new env vars are read once the new code is in place.

### 11. Merge `srpow-wrap` → `main` and deploy

```bash
# in your local checkout
cd /Users/fredkrueger/rpow
git checkout main
git pull origin main
git merge srpow-wrap                  # or rebase, your call
git push origin main

# on the VPS
ssh ubuntu@15.204.254.192 '
  sudo -u rpow bash -c "cd /opt/rpow/repo && \
    git pull origin main && \
    npm ci --workspaces --include-workspace-root --ignore-scripts && \
    npm run build --workspace @rpow/shared && \
    npm run build --workspace @rpow/server" && \
  sudo systemctl restart rpow-server'
```

Migrations 008–010 run automatically on startup. The reconcile worker runs once on boot. Tail logs:

```bash
ssh ubuntu@15.204.254.192 'sudo journalctl -u rpow-server -f'
```

Expect to see: `mail throttle: ...`, `rpow2 server listening on :8080`, no migration errors. If you see migration errors, do **not** proceed — check `docs/superpowers/specs/2026-05-08-srpow-wrap-design.md` for the migration definitions and resolve before re-running.

### 12. Smoke test

Sign in to `rpow2.com` as `frk314@gmail.com` (the allowlisted account). Then:

1. Navigate to `/wrap`. Page loads (no 403).
2. Click **Connect Phantom** — Phantom opens. Approve the connect, then sign the bind challenge.
3. Confirm the wallet pubkey shows in the Wrap panel.
4. Wrap a small amount (e.g. **1 RPOW**). Wait ≤ 60s.
5. Verify in Phantom that SRPOW appears with the correct name + logo, balance updated.
6. Click the `tx` link in **WRAP HISTORY** — opens the mint transaction on Solscan.
7. Open `https://api.rpow2.com/ledger` and verify `current_reward_base_units`, `halving_index`, etc. look sane.

**Pass criteria**: all 7 sub-steps succeed. If any step fails:

```bash
ssh ubuntu@15.204.254.192 'sudo journalctl -u rpow-server -n 200'
```

…and triage from there.

### 13. After-launch hardening (out of scope, document for reference)

- **Solscan verified-token badge**: apply at `https://solscan.io/leaderboard#tokens` (manual review).
- **Jupiter strict list**: submit at `https://station.jup.ag/docs/get-started/welcome`.
- **Bridge SOL low-balance alarm**: cron job + email when bridge balance < 0.01 SOL (so wrap mints don't start failing for lack of fees).
- **Periodic supply reconciliation alarm**: SRPOW Solana supply should equal `1,100,000 + count(rpow rows in WRAPPED state)`. Anything else means something has drifted; investigate.

