# Daily Free Lottery — Design

**Status:** Draft for review
**Date:** 2026-05-12
**App slug:** `freelottery`
**Public URL (target):** `freelottery.rpow2.com`
**Server route prefix:** `/api/freelottery`

## 1. Feature summary

A 100-day daily free lottery awarding 1,000 RPOW per day to one verified entrant. Anyone with an RPOW account can earn a ticket by posting a public tweet on X each day and pasting the tweet URL back to the site for oEmbed-based verification (same dance as the existing gladiator X-handle flow, repeated daily). Holding ≥ 1 RPOW at entry time grants a second ticket. Each day's draw runs at 19:00 UTC and selects a winner using the hash of the first Solana block produced at-or-after that moment, weighted by ticket count. The prize is credited to the winner via the existing in-DB mint plumbing (sharded `minted_supply` counter + `tokens` row, same path as PoW mint) and comes out of the unmined 19M cap. The winner converts to on-chain sRPOW via the existing `/srpow/wrap` flow whenever they choose. A fully-public landing page shows today's entrants, countdown to draw, and the running list of past winners — the page is also the trust artifact that lets anyone re-verify the draw.

## 2. Scope and key decisions

| Decision | Choice |
|---|---|
| Daily X re-verification | Same paste-the-tweet-URL dance every day (matches gladiator pattern) |
| Daily reset boundary | Fixed 19:00 UTC, year-round (no DST math) |
| Tweet template | `I am entering the daily free lottery for 1000 RPOW. My code is ${code}. freelottery.rpow2.com` |
| Per-day code | 6-digit numeric, expires at 19:00 UTC |
| Tickets | 1 base ticket on verified entry; +1 if balance ≥ 1 RPOW at moment of verify |
| Eligibility | Any logged-in RPOW account |
| Prize delivery | In-DB mint (sharded `minted_supply` increment + `tokens` row insert), same path as PoW mint; deducts from unmined supply. On-chain conversion via `/srpow/wrap` (user-initiated). |
| Winner has no Solana wallet | Ledger credit is unaffected; the winner can later bind a wallet and use `/srpow/wrap` to mirror on-chain. The draw never blocks on wallet state. |
| Draw method | Hash of first Solana block at-or-after 19:00 UTC, weighted by ticket count |
| Empty-day behavior | No winner, no mint, day is skipped — prize stays in unmined supply |
| Calendar | 100 days, fixed window; start date in env (`FREELOTTERY_START_UTC_DATE`) |
| UI app | New `apps/web-freelottery/` |
| Public page visibility | Fully public, no auth |
| Launch announcement | News entry in `apps/web/src/pages/News.tsx`; banner system is general behavior, out of scope here |

**Out of scope (explicitly):**
- Multiple concurrent lottery seasons / generalized lottery framework (YAGNI)
- The general top-banner announcement system (handled separately)
- USDC or other-currency prizes
- Mobile-app integration

## 3. Architecture

```
apps/server
  src/routes/freelottery/
    entry.ts                 # POST /start, POST /verify (per-day code dance)
    public.ts                # GET /today, GET /winners (unauthenticated, cached)
    draw.ts                  # internal: run draw for a given day_utc
  src/freelottery/
    schedule.ts              # start date, day index, 19:00 UTC math
    selection.ts             # blockhash → winning ticket index
    solanaBlock.ts           # fetch first Solana block at-or-after a UTC moment
  migrations/
    NNN_freelottery.sql      # tables in §4

apps/web-freelottery/        # new Vite app, deployed to freelottery.rpow2.com
  src/
    App.tsx                  # routing: /, /enter
    pages/Public.tsx         # marketing-grade public landing
    pages/Enter.tsx          # auth-gated daily entry flow
    api.ts                   # API client

apps/web/src/pages/News.tsx  # add launch news entry (separate edit)
```

**Reuse:**
- X-handle binding lives on `users.x_handle` (gladiator's existing schema). First-time lottery entrants without a bound handle are redirected through the existing gladiator bind UI; already-bound gladiator users skip straight to the daily code dance.
- oEmbed verification helper from `apps/server/src/gladiator/xVerify.ts` is reused for tweet validation.
- Mint pipeline: `minted_supply` shard counter increment plus `tokens` row insert (server-signed, `parent_token_id IS NULL`) — same path as the PoW mint flow. The winner converts to on-chain sRPOW themselves via `/srpow/wrap`; the draw runner does not auto-enqueue a bridge mint.

## 4. Data model

Three new Postgres tables, all keyed by `day_utc DATE` (the UTC date whose 19:00 boundary closes the entry window).

```sql
CREATE TABLE freelottery_codes (
  account_email TEXT NOT NULL,
  day_utc       DATE NOT NULL,
  code          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_email, day_utc)
);

CREATE TABLE freelottery_entries (
  account_email             TEXT NOT NULL,
  day_utc                   DATE NOT NULL,
  x_handle                  TEXT NOT NULL,
  tweet_url                 TEXT NOT NULL,
  ticket_count              SMALLINT NOT NULL CHECK (ticket_count IN (1, 2)),
  balance_base_units_at_entry  BIGINT NOT NULL,
  verified_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_email, day_utc)
);
CREATE INDEX freelottery_entries_day_idx ON freelottery_entries (day_utc, verified_at);

CREATE TABLE freelottery_draws (
  day_utc              DATE PRIMARY KEY,
  drawn_at             TIMESTAMPTZ NOT NULL,
  solana_slot          BIGINT,            -- NULL if pending or empty day
  solana_blockhash     TEXT,              -- NULL if pending or empty day
  total_tickets        INT NOT NULL,
  winner_email         TEXT,              -- NULL on empty days
  winner_x_handle      TEXT,
  prize_base_units     BIGINT NOT NULL,
  mint_credited_at     TIMESTAMPTZ,
  on_chain_signature   TEXT,
  status               TEXT NOT NULL DEFAULT 'ok'  -- 'ok' | 'empty' | 'pending_blockhash'
);
```

**No additional changes to existing tables.** `users.x_handle` (gladiator's column) is reused. Mint reuses `tokens` and `app_counters`.

## 5. Data flow

### 5.1 Daily entry

Example: May 13 lottery cycle = 19:00 UTC May 12 → 19:00 UTC May 13. The relevant `day_utc` is **May 13** (the date the cycle closes).

1. User visits `freelottery.rpow2.com/enter`, logs in if needed.
2. Frontend → `POST /api/freelottery/entry/start`:
   - 409 `already_entered` if a `freelottery_entries` row exists for `(account_email, day_utc=today)`.
   - 409 `bind_required` if `users.x_handle` is NULL. Frontend redirects to the existing X-handle bind UI; on success, user retries.
   - Otherwise: generate 6-digit code, upsert `freelottery_codes` row with `expires_at = today_19_utc()`, return `{ code, tweet_intent_url, expires_at, day_utc }`. Tweet text:
     ```
     I am entering the daily free lottery for 1000 RPOW. My code is ${code}. freelottery.rpow2.com
     ```
3. User clicks tweet-intent URL → posts on X → copies tweet URL.
4. Frontend → `POST /api/freelottery/entry/verify { tweet_url }`:
   - Fetch tweet via `publish.twitter.com/oembed?url=...` (existing helper).
   - Validate: text contains `My code is ${code}`; author handle matches `users.x_handle` (case-insensitive).
   - Read user's RPOW balance from the ledger view used by `/me`. `ticket_count = balance_base_units >= 1_000_000_000 ? 2 : 1` (1 RPOW = 10^9 base units).
   - Transactional insert into `freelottery_entries` (re-check no row exists for the day), delete the code row.
   - Return `{ ok: true, ticket_count, day_utc }`.

### 5.2 Draw, 19:00 UTC

A scheduled job (mechanism resolved in implementation plan based on existing scheduler conventions; tolerable to start as an in-process tick that runs every minute and checks for an unprocessed `day_utc`) executes the following for the just-closed day:

1. Compute `total_tickets = SUM(ticket_count) FROM freelottery_entries WHERE day_utc = D`.
2. If `total_tickets = 0`: insert `freelottery_draws` row with `status = 'empty'`, `winner_email = NULL`, no mint. Done.
3. Otherwise fetch the first Solana block at-or-after `D 19:00:00 UTC` (`solanaBlock.ts` calls Solana RPC). Record `slot` and `blockhash`.
4. Build the deterministic ticket list:
   - Select entries for `day_utc = D` ordered by `(verified_at ASC, account_email ASC)`.
   - For each entry, repeat its index `ticket_count` times.
5. Compute `winning_index = bigint_of_first_8_bytes(blockhash) mod total_tickets`. Pick the entry at that index.
6. Insert `freelottery_draws` row with winner info, `status = 'ok'`.
7. Credit the prize ledger-side, matching the existing PoW mint: increment `minted_supply` (sharded) by `prize_base_units` (1,000 RPOW = 10^12 base units) under the 19M cap, then insert a `tokens` row owned by the winner with `parent_token_id IS NULL` and a server-signed payload. Set `freelottery_draws.mint_credited_at = now()`.
8. The winner converts in-DB RPOW to on-chain sRPOW themselves via the existing `/srpow/wrap` flow whenever they choose — this matches how every other RPOW mint in the system reaches on-chain form. `freelottery_draws.on_chain_signature` stays NULL; the column is reserved for a future automation pass that could auto-wrap on the winner's behalf.

### 5.3 Public reads

- `GET /api/freelottery/today` → `{ day_utc, draws_at, prize_base_units, entries: [...], total_entries, total_tickets }`. In-process cache, 5s TTL.
- `GET /api/freelottery/winners` → array of all `freelottery_draws` rows from `start_date` to today, joined with the winner's `x_handle` / `x_avatar_url`. Each row exposes `total_tickets` for that day so the page can show the size of the pool. In-process cache, 60s TTL.
- `GET /api/freelottery/status` → `{ start_date, day_index, total_days: 100, prize_remaining_base_units, ended }`.

## 6. UI

### 6.1 Public landing page — quality bar

The landing page is the marketing surface for this campaign and the trust artifact for the draw. It must feel distinctive and high-quality.

**Required above-the-fold elements:**
- Hero callout: **1,000 RPOW · daily · 100 days**.
- Countdown clock to next 19:00 UTC draw, with day index ("Day 23 / 100").
- Primary CTA: "Enter today's free lottery →" (deep-links to `/enter`, prompts login if needed).
- Live count: today's entrants and total tickets.

**Required below-the-fold elements:**
- Today's entrants gallery: X avatars + handles, ordered by `verified_at`. New entries appear via polling every ~5s (no websocket needed). Visually highlight users with 2 tickets (RPOW-holder badge).
- Previous winners feed: avatar + handle + date + link to the verifying tweet + Solana slot/blockhash that drew them (cryptographic-receipt vibe — reinforces the public-fairness story). Each row also displays the total number of tickets issued that day (the size of the pool the winner won against).
- Empty-day rows shown explicitly ("Day 14 — no entries, prize skipped").
- "How it works" — 3 short steps; show the tweet template verbatim.

**Implementation requirement:** When `apps/web-freelottery/src/pages/Public.tsx` is built, the implementer **must use the `frontend-design` skill** to avoid the generic AI aesthetic. The auth-gated `Enter.tsx` flow can be utilitarian; the public page is a marketing surface and gets the design treatment — real type hierarchy, distinctive visual identity, motion in countdown and entry feed.

**Performance:** Public endpoints are unauthenticated and may be hit from social-media traffic spikes. Cache responses in-process (5s `/today`, 60s `/winners`, 60s `/status`). No DB hit per public request after the cache warms.

### 6.2 Enter flow — `/enter`

Sequential, single-column, utilitarian:
1. If not logged in → redirect through existing auth flow.
2. If `users.x_handle` not bound → embed/redirect to the gladiator bind UI; on success, return here.
3. If already entered today → show "You're in. Ticket count: N. Draw at 19:00 UTC (HH:MM remaining)." with a link back to the public page.
4. Otherwise show: "Click to tweet" (opens X intent), then a paste-URL input + verify button. On verify success → show step 3.
5. All error states use plain inline messages tied to the field that failed.

### 6.3 News announcement

A new entry in `apps/web/src/pages/News.tsx` for the launch date, mirroring the existing trivia entry pattern. Links to `freelottery.rpow2.com`. The general top-banner system (out of scope here) will surface it.

## 7. Error handling and edge cases

### 7.1 Entry time

- `users.x_handle` already bound to a different account — prevented by existing unique index; surfaced as a clear bind-failure in the existing UI.
- Double-entry attempt same day — 409 `already_entered`. Verify is idempotent for the *same* tweet URL: re-calling returns the existing row's `ticket_count`.
- oEmbed fetch fails (rate-limit, outage) — 503 with retry guidance. Code remains valid until 19:00 UTC; user retries.
- Code mismatch in tweet — 400 echoing the expected code (helps users who accidentally used yesterday's).
- Author handle ≠ bound handle — 403 `handle_mismatch`.
- Verification arrives < 5 minutes before 19:00 UTC — still accepted. Hard cutoff at 19:00 UTC: the draw uses `WHERE verified_at < 19:00 UTC` and the code itself expires.
- Balance fluctuates between attempts — `ticket_count` is snapshot at successful verify and frozen. No ongoing balance-maintenance check.

### 7.2 Draw time

- Solana RPC failure fetching the post-19:00 block — retry with backoff for up to 10 minutes; on continued failure, insert `freelottery_draws` row with `status = 'pending_blockhash'` and surface on the page ("Draw pending — Solana network issue"). Admin-triggered re-run completes it. Do **not** fall back to a different RNG.
- The draw runner does not enqueue a bridge mint, so there's no bridge-enqueue failure path to consider in slice 3. Winners convert via `/srpow/wrap` themselves.
- Server outage across one or more 19:00 UTC boundaries — on next startup, find each `day_utc` in `[start, today−1]` with no `freelottery_draws` row and run them in order. Block-hash logic still uses each day's original 19:00 UTC moment, so missed draws are still verifiable.
- Same user wins multiple days — allowed. No uniqueness constraint on `winner_email`.

### 7.3 Anti-cheat

- Per-day code is the core defense (matches gladiator's already-proven model).
- `users.x_handle` uniqueness blocks one X account voting for multiple RPOW accounts.
- Ticket cap = 2 limits whale dominance.
- Public participant list is itself the audit mechanism.
- Solana block hash from a future block (relative to entry close) means operator cannot rig the seed — they don't know it when entries close.

## 8. Configuration

New env vars on the server:

| Var | Type | Default | Purpose |
|---|---|---|---|
| `FREELOTTERY_START_UTC_DATE` | `YYYY-MM-DD` | unset (feature disabled) | First `day_utc` (the draw date). Day 1's draw runs at 19:00 UTC on this date; entries are accepted from feature-enable time until that moment. |
| `FREELOTTERY_TOTAL_DAYS` | int | `100` | Length of campaign. |
| `FREELOTTERY_PRIZE_BASE_UNITS` | int | `1_000_000_000_000` (1,000 RPOW) | Daily prize, in base units. Configurable so we can tune without redeploys. |
| `FREELOTTERY_DRAW_HOUR_UTC` | int | `19` | Hour of UTC day at which entries close and draw runs. |

If `FREELOTTERY_START_UTC_DATE` is unset, all routes return 404 and the scheduler is a no-op.

## 9. Testing

### 9.1 Unit tests (`apps/server/test/freelottery/`)
- Day-index / cycle-boundary math vs. 19:00 UTC.
- Code expiry math.
- Verify flow: happy path, wrong code, wrong handle, oEmbed mock failure, double-entry idempotency.
- Ticket tier math: balance just below 1 RPOW = 1; ≥ 1 RPOW = 2.
- `selection.ts` determinism: given fixed entry list + fixed blockhash, winner is deterministic; same inputs in a different process produce the same winner.

### 9.2 Integration tests
- End-to-end: register → bind X (mocked oEmbed via gladiator test harness) → enter → close window → run draw (mocked Solana block) → assert in-DB mint credited (sharded supply + token row).
- Missed-day recovery: simulate two 19:00 UTC boundaries while scheduler is paused; on resume, both daily draws execute in order and produce expected winners.
- Empty-day: zero entries → draw row inserted with `status = 'empty'`, no mint, `minted_supply` unchanged.
- Pending-blockhash path: Solana RPC failure → draw row inserted with `status = 'pending_blockhash'`; subsequent retry completes the draw.

### 9.3 Frontend tests
- `Public.tsx` snapshot tests against canned API fixtures: today with entries, today empty, post-day-100 final-results state.
- `Enter.tsx` flow tests: bind-required redirect, tweet-intent button, paste-and-verify, all error toasts.

### 9.4 Manual / staging
- One full live cycle in staging using a real X account, with a mock blockhash via env override; verify ledger credit lands and the winner can wrap to on-chain via `/srpow/wrap`.
- Load test public endpoints behind the in-process cache (e.g., `wrk -c 200 -d 30s`).

## 10. Open items deferred to the plan

These are intentionally not pinned down in this spec; the implementation plan resolves them by reading what's already in the codebase:

1. **Scheduler mechanism.** Whether to add a tick to the existing `schedule.ts`, run an external cron, or use a tiny in-process minute-tick that scans for unprocessed `day_utc`. Plan picks the lightest fit.
2. **Caching primitive.** Whether to add a tiny in-memory TTL cache utility or reuse an existing one.
3. **Solana RPC client.** Whether to use the same `/solana-rpc` proxy already wired up or hit a public endpoint. (Likely: the proxy.)
4. **Vite app scaffolding.** Mirror whichever of `web-gladiator` / `web-trivia` / `web-longshot` is the cleanest current template.

## 11. Rollout

1. Migration deployed.
2. Server changes deployed with `FREELOTTERY_START_UTC_DATE` **unset** (feature dark).
3. `apps/web-freelottery` deployed to its CDN, `freelottery.rpow2.com` DNS configured.
4. News entry merged but not yet linked from the banner.
5. Set `FREELOTTERY_START_UTC_DATE` (the draw date for day 1); flip the news/banner live. Day 1's draw runs at 19:00 UTC on that date.
6. On day 101, the public page enters its permanent final-results view; `FREELOTTERY_TOTAL_DAYS` keeps the system inert.
