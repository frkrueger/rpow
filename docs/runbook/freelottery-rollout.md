# Free Lottery — Rollout Runbook

How to flip the daily free lottery from "dark" to "live."

The feature is currently fully deployed but dormant: the server compiles, the public page renders a "Coming soon" stub, the scheduler runs but short-circuits, and all `/api/freelottery/*` routes return `404 FEATURE_DISABLED`. Setting one env var (`FREELOTTERY_START_UTC_DATE`) flips everything on.

## Pre-flight (do before flipping the env var)

1. **Confirm `freelottery.rpow2.com` resolves.** Netlify site is configured against `apps/web-freelottery/netlify.toml`; CDN should already be serving the slice-4 marketing page. Visit it: expect the "Coming soon" stub.
2. **Confirm CORS:** `FREELOTTERY_WEB_ORIGIN` must be set to `https://freelottery.rpow2.com` on the server (defaults to that value; only override if hosting elsewhere).
3. **Confirm `SOLANA_RPC_URL` is set on the server.** Without it the draw runner cannot fetch entropy and will skip every non-empty day. Check with:
   ```bash
   sudo systemctl show rpow-server.service --property=Environment | grep SOLANA_RPC_URL
   ```
4. **Confirm enough unmined supply.** 100 days × 1,000 RPOW = 100,000 RPOW (10^14 base units). Check current minted supply:
   ```bash
   sudo -u postgres psql rpow -c "SELECT SUM(value) FROM app_counters WHERE name='minted_supply'"
   ```
   The 19M cap minus this total must be at least 100,000 RPOW (i.e., 10^14 base units).
5. **Pick a launch date.** This becomes `FREELOTTERY_START_UTC_DATE = YYYY-MM-DD`. Day 1's draw runs at 19:00 UTC on this date; entries open immediately when the env var is set. Choose a date at least a few hours in the future so users have time to enter day 1 before its draw.

## Flip live

1. **Author the news entry.** Edit `apps/web/src/pages/News.tsx`, prepend the following block to the top of the `ENTRIES` array (newest first):

   ```typescript
   {
     when: '<launch-date-formatted-like-existing-entries>',
     title: 'Daily Free Lottery launches',
     body: '1,000 RPOW awarded daily for 100 days. Tweet to enter, draw at 19:00 UTC. freelottery.rpow2.com',
   },
   ```

   The existing top-banner system surfaces this automatically; users who click the banner land on the news page.

2. **Commit and deploy the news entry.**
   ```bash
   git add apps/web/src/pages/News.tsx
   git commit -m "feat(web/news): add Daily Free Lottery launch"
   git push
   ```

3. **Set the env var on the server.** SSH into the VPS:
   ```bash
   sudo systemctl edit rpow-server.service
   ```
   Add:
   ```
   [Service]
   Environment=FREELOTTERY_START_UTC_DATE=2026-MM-DD
   ```
   Save and exit.

4. **Restart the server.**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart rpow-server.service
   ```

5. **Smoke test (within 60s):**
   ```bash
   curl -s https://api.rpow2.com/api/freelottery/status | jq
   ```
   Expect:
   ```json
   {
     "enabled": true,
     "startUtcDate": "2026-MM-DD",
     "totalDays": 100,
     "prizeBaseUnits": "1000000000000",
     "drawHourUtc": 19,
     "dayIndex": 1,
     "currentDayUtc": "2026-MM-DD",
     "nextDrawAt": "2026-MM-DDT19:00:00.000Z",
     "ended": false
   }
   ```

6. **Visit the public page.** `https://freelottery.rpow2.com/` should now render the full marketing layout (hero, countdown, empty-state "Be the first to enter today").

7. **Verify the draw runner is logging.** Watch the journal:
   ```bash
   sudo journalctl -u rpow-server.service -f | grep freelottery
   ```
   On a healthy startup you should NOT see any `freelottery: scheduled draw failed` warnings. Each 60s the runner walks past-due days; before day 1's 19:00 UTC there are no candidates and no log lines are emitted (silence is correct).

## Day 1 — first draw

About 60s after `FREELOTTERY_START_UTC_DATE` 19:00 UTC:

1. The scheduler tick walks candidates, finds `day_utc = FREELOTTERY_START_UTC_DATE` past its draw moment, runs `runOneDay`.
2. The runner fetches Solana entropy via `/solana-rpc`, picks a winner from `freelottery_entries` for that `day_utc`, mints 1,000 RPOW into the winner's in-DB balance via the same sharded supply increment + signed token row used by `/mint`, inserts the `freelottery_draws` row, and sets `mint_credited_at`.
3. `GET /api/freelottery/winners` now returns the day-1 row; the public page's past-winners ledger surfaces it within ~60s (cache TTL).

If day 1 had zero entries, you'll see a `status='empty'` row with `winner_email=NULL` instead, and no mint occurs.

Verify the result:
```bash
sudo -u postgres psql rpow -c "SELECT day_utc, status, winner_email, total_tickets, solana_slot FROM freelottery_draws ORDER BY day_utc DESC LIMIT 5"
```

## Mid-campaign — common operational checks

- **A draw didn't run as expected** (no row in `freelottery_draws` for a past day):
  - Check Solana RPC reachability — the runner defers when entropy fetch fails. `curl -s https://api.rpow2.com/solana-rpc -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' -H content-type:application/json`
  - Check the server logs for the 60s tick: `journalctl -u rpow-server.service --since "10 min ago" | grep freelottery`
  - The next tick will retry automatically — no manual action needed unless Solana is down for hours.

- **A winner couldn't be reached:**
  - All winners receive an in-DB ledger credit. To get on-chain sRPOW they use the existing `/srpow/wrap` flow themselves. No automatic wallet-binding work is needed.
  - If a winner has no `users.solana_wallet` bound, the prize sits in their RPOW balance until they bind one and wrap.

- **The campaign needs to be paused:**
  - Set `FREELOTTERY_START_UTC_DATE=` (empty value, or comment out) and restart. The scheduler will short-circuit; the public page reverts to the "Coming soon" stub. Already-drawn days remain in `freelottery_draws` and are visible again as soon as the var is restored.

- **The campaign needs to be reset for re-launch on a new date:**
  - Don't re-use the old `FREELOTTERY_START_UTC_DATE`. Set a new one and the day-1 cycle restarts. Old rows in `freelottery_draws` and `freelottery_entries` persist — if you want to wipe them, run `DELETE FROM freelottery_draws; DELETE FROM freelottery_entries; DELETE FROM freelottery_codes;` (in that order, because of foreign keys; actually all three are independent of each other and only reference `users(email)`, so order doesn't matter).

## End of campaign (day 101)

When `now >= start + 100 days at 19:00 UTC`, `hasEnded` returns true:
- `/status` returns `ended: true`
- `/today` returns `404 CAMPAIGN_ENDED`
- The public page renders the "Final results" header, suppresses the countdown and CTA, hides the entrants section, and shows the full 100-day ledger
- The scheduler still walks candidates each tick but never finds new work; `runOneDay` is idempotent on the existing rows
- You can leave the env var set forever — the system is inert once ended

## Soft launch / allowlist

The current code treats `FREELOTTERY_ALLOWED_EMAILS` as advisory only — the value is wired into `AppConfig` but `/entry/start` does not enforce it. If a private soft-launch is needed before the public launch, that requires a one-line guard in `apps/server/src/routes/freelottery/entry.ts` after the `BIND_REQUIRED` check, modeled on `apps/server/src/routes/amm` allowlist patterns. Not in scope of the slice-1-through-4 implementation.

## Rollback (worst case)

If the feature is causing problems:

1. Unset `FREELOTTERY_START_UTC_DATE` and restart the server. The feature goes dark immediately; in-flight requests complete with their previous result.
2. If the prize mint pipeline misbehaved (e.g., a draw credited the wrong winner due to a code bug we missed), the prize token row in `tokens` and the `minted_supply` increment can be reversed manually. There is no API for this — write a one-off SQL transaction:
   ```sql
   BEGIN;
   -- Decrement the supply counter on the same shard the prize was credited to.
   -- Find it by joining tokens → minted_supply increment.
   UPDATE app_counters
     SET value = value - 1000000000000
     WHERE name='minted_supply'
       AND shard = (... lookup the right shard ...);
   -- Invalidate the prize token row.
   UPDATE tokens SET state = 'INVALIDATED', invalidated_at = now()
     WHERE id = '<token-id-from-the-draw>';
   -- Mark the draws row so it shows up in audits.
   UPDATE freelottery_draws SET status = 'reversed-manual'
     WHERE day_utc = '<the-day>';
   COMMIT;
   ```
   Note: the `freelottery_draws.status` CHECK constraint only allows `('ok','empty','pending_blockhash')`. You'd need to either add `'reversed-manual'` to the CHECK first (migration), or use one of the existing values and document the reversal elsewhere.

## Open items deferred to future slices

- The `pending_blockhash` user-visible status (the schema column exists but is never written by slice 3's runner)
- Automatic on-chain wrap of the prize to sRPOW on the winner's bound wallet
- Frontend snapshot tests for `Public.tsx`
- Allowlist enforcement on `/entry/start` (see "Soft launch" above)
