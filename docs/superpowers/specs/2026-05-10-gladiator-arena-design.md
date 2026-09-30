# RPOW Gladiator Arena — Design

**Date:** 2026-05-10
**Status:** Design, not yet implemented
**Subdomain:** `gladiator.rpow2.com`

## 1. Summary

RPOW Gladiator is a PvP feature where rpow account holders verify an X (Twitter) handle, enter an "arena" with an RPOW bankroll, and accept coin-flip challenges from other verified users. Pure 50/50, zero rake, winner takes both bets. Flips are server-RNG-driven and ed25519-signed (same fairness model as Long Shot). A public lobby lists every gladiator currently in the arena along with a global chat room, and every win comes with a one-click "tweet this" button. The X-handle verification and share-on-X mechanics are the deliberate viral spine of the product.

## 2. Goals / non-goals

**In scope (V1):**
- Tweet-based X handle verification, globally unique
- Bankroll-based "enter the arena" flow (one open session per user)
- Asymmetric matching: offerers post in the lobby; drop-in challengers (also X-verified) take individual flips
- Public lobby and recent-flips feed (no login required to spectate)
- Global arena chat with system event messages
- Tweet-on-win intent
- Auto-close of inactive sessions

**Out of scope (V1):**
- Provably-fair commit-reveal (longshot's "Phase 2 provably-fair" applies here too; for now we ship signed-audit, same fairness story as longshot)
- WebSockets / SSE (5s polling is good enough)
- Per-flip heads/tails picking (a coin is a coin)
- Multi-game framework (file gladiator.rpow2.com as "gladiator arena" without prematurely abstracting for a second game)
- Reporting / moderation UI (server-side denylist + admin DB ops only)
- House rake (zero-sum by design)
- Twitter API integration (oEmbed is sufficient; API is fallback)

## 3. Identity: X handle verification

Verification uses Twitter's public oEmbed endpoint (`https://publish.twitter.com/oembed`), which requires no API key.

**Flow:**

1. `POST /api/gladiator/x-handle/start { handle }` — server normalizes (strip leading `@`, lowercase for comparison), enforces uniqueness against `users.x_handle` and any other pending verification. Returns a 6-digit code and a prefilled `twitter.com/intent/tweet` URL with the canonical verification template.

2. User clicks the intent URL, posts the tweet from their X account, copies the tweet URL.

3. `POST /api/gladiator/x-handle/verify { tweet_url }` — server fetches `publish.twitter.com/oembed?url=<tweet_url>&omit_script=1`, parses the response, confirms (a) `author_url` ends with the pending handle (case-insensitive) and (b) the `html` body contains the code. On success: writes `users.x_handle`, `users.x_handle_verified_at`, `users.x_avatar_url`; deletes the row from `x_verification_codes`.

**Canonical verification tweet template:**

> *I am entering the gladiator arena on X. My code is {CODE}. Go to gladiator.rpow2.com to go head to head with me in 100% fair gladiator games. May the best man win.*

**Uniqueness:** `LOWER(x_handle)` is enforced unique at the DB level via a partial UNIQUE index, so a race condition between two users verifying the same handle gracefully resolves to one success and one 409.

**Avatar:** rendered client-side via `https://unavatar.io/twitter/<handle>` (free, no auth, always current).

**Fallback:** if oEmbed flakes (X has occasionally rate-limited non-authenticated scrapers), a tiny admin route `POST /api/gladiator/admin/verify-handle` gated by a service-token env var lets ops manually mark verified.

## 4. Game mechanics

**Roles.** Asymmetric.

- **Offerer (Alice):** clicks "Enter the Arena", commits a bankroll, declares a per-flip bet. Becomes a visible gladiator in the lobby. Multiple challengers can flip her in sequence until her bankroll drains or she leaves.
- **Challenger (Bob):** browses the lobby, clicks "Flip @alice", server burns the bet from his VALID tokens, settles the flip atomically, mints `2×bet` to the winner. No session required.

**Both sides must be X-verified** to participate. Spectators can view the lobby and chat without signing in.

**Per-flip stake.** Fixed and equal to the offerer's declared `bet_base_units` for that session. The challenger pays whatever the offerer is offering.

**Bankroll constraint.** Bankroll must be a clean multiple of the per-flip bet (`bankroll % bet == 0`), so the session can drain cleanly. UI presents bankroll as "N flips × bet" rather than a free slider.

**Rake.** Zero. Winner gets the full `2 × bet`.

**RNG.** Server `crypto.randomBytes(1)`. First bit decides outcome. Each flip's outcome + canonical fields are ed25519-signed and stored on `gladiator_flips`. This is the same fairness story as Long Shot.

**Auto-close.** A session with `last_flip_at < now() - GLADIATOR_SESSION_TTL_HOURS` (default 48h) is closed by a periodic sweeper; remaining bankroll is minted back to the owner.

**Mid-flip drain.** If the offerer's `bankroll_remaining` falls below `bet` after a settlement, the session auto-closes inside the same transaction.

**No "decline".** Once an offerer is in the arena, any X-verified user can flip them. To stop being challenged, leave the arena.

## 5. Data model

New migration `apps/server/migrations/014_gladiator.sql`. **No changes to `tokens` or any existing schema.**

```sql
-- 1. Extend users with X identity
ALTER TABLE users
  ADD COLUMN x_handle TEXT,
  ADD COLUMN x_handle_verified_at TIMESTAMPTZ,
  ADD COLUMN x_avatar_url TEXT;

CREATE UNIQUE INDEX users_x_handle_lower_uniq
  ON users (LOWER(x_handle)) WHERE x_handle IS NOT NULL;

-- 2. Pending X verification (ephemeral; one row per user at most)
CREATE TABLE x_verification_codes (
  account_email   TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  pending_handle  TEXT NOT NULL,
  code            TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Active and closed arena sessions
CREATE TABLE gladiator_sessions (
  id                              UUID PRIMARY KEY,
  account_email                   TEXT NOT NULL REFERENCES users(email),
  bet_base_units                  BIGINT NOT NULL CHECK (bet_base_units > 0),
  bankroll_initial_base_units     BIGINT NOT NULL CHECK (bankroll_initial_base_units > 0),
  bankroll_remaining_base_units   BIGINT NOT NULL CHECK (bankroll_remaining_base_units >= 0),
  flips_won                       INT NOT NULL DEFAULT 0,
  flips_lost                      INT NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flip_at                    TIMESTAMPTZ,                       -- updated on each flip; null until first flip
  closed_at                       TIMESTAMPTZ,
  CHECK (bankroll_initial_base_units % bet_base_units = 0)
);

CREATE UNIQUE INDEX gladiator_sessions_one_open_per_user
  ON gladiator_sessions (account_email) WHERE status = 'OPEN';

CREATE INDEX gladiator_sessions_open_lobby_idx
  ON gladiator_sessions (opened_at DESC) WHERE status = 'OPEN';

CREATE INDEX gladiator_sessions_sweeper_idx
  ON gladiator_sessions (COALESCE(last_flip_at, opened_at)) WHERE status = 'OPEN';

-- 4. Per-flip audit (signed)
CREATE TABLE gladiator_flips (
  id                      UUID PRIMARY KEY,
  offerer_session_id      UUID NOT NULL REFERENCES gladiator_sessions(id),
  challenger_session_id   UUID REFERENCES gladiator_sessions(id),    -- NULL = drop-in challenger
  offerer_email           TEXT NOT NULL,
  challenger_email        TEXT NOT NULL,
  bet_base_units          BIGINT NOT NULL CHECK (bet_base_units > 0),
  winner_email            TEXT NOT NULL,                              -- offerer_email OR challenger_email
  random_value_hex        TEXT NOT NULL,
  signature               BYTEA NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gladiator_flips_offerer_idx    ON gladiator_flips(offerer_email, created_at DESC);
CREATE INDEX gladiator_flips_challenger_idx ON gladiator_flips(challenger_email, created_at DESC);
CREATE INDEX gladiator_flips_created_at_idx ON gladiator_flips(created_at DESC);

-- 5. Global arena chat
CREATE TABLE gladiator_chat_messages (
  id            UUID PRIMARY KEY,
  account_email TEXT REFERENCES users(email),                         -- NULL for SYSTEM rows
  x_handle      TEXT,                                                 -- snapshot at post time
  kind          TEXT NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER','SYSTEM')),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'USER') = (account_email IS NOT NULL))
);
CREATE INDEX gladiator_chat_recent_idx ON gladiator_chat_messages(created_at DESC);
```

**Key design notes:**
- W/L on `gladiator_sessions` is per-session and updated inline. Career W/L is computed from `gladiator_flips` aggregates with a server-side cache.
- `gladiator_flips.challenger_session_id` is nullable because drop-in challengers don't have a session.
- The unique partial index on `(account_email) WHERE status='OPEN'` makes "one open session per user" a hard DB invariant.
- Chat `x_handle` is snapshotted at post time so renames don't rewrite history.

## 6. API surface

All endpoints under `/api/gladiator/`. Cookie auth via the existing `rpow_session` cookie. Rate limits per the table in §10.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/x-handle/start` | session | Begin handle verification; returns `{ code, tweet_intent_url, expires_at }` |
| `POST` | `/x-handle/verify` | session | Finalize verification given a tweet URL |
| `GET` | `/me` | session | Returns the caller's gladiator-relevant profile (handle, verified, open session if any, career W/L) |
| `POST` | `/sessions` | session + verified | Enter the arena; body `{ bankroll_base_units, bet_base_units }` |
| `POST` | `/sessions/:id/close` | session, must own | Leave the arena; mints remainder back |
| `GET` | `/lobby` | public | List all OPEN sessions with owner profile fields (15s cache) |
| `POST` | `/flip` | session + verified | Challenge body `{ session_id }`; settles atomically |
| `GET` | `/flips/recent` | public | Recent flip results for the lobby tail (15s cache) |
| `GET` | `/flips/history` | session | The caller's own flip history (offerer + challenger sides) |
| `GET` | `/chat` | public | List recent messages; query `since` or `before` for pagination |
| `POST` | `/chat` | session + verified | Post `{ body }` (1..280 chars) |
| `POST` | `/admin/verify-handle` | service token | Ops fallback if oEmbed is unavailable |

**Error codes** (uniform shape `{ error: <CODE>, message: string }`): `BAD_REQUEST`, `UNAUTHORIZED`, `X_HANDLE_REQUIRED`, `HANDLE_TAKEN`, `HANDLE_MISMATCH`, `CODE_NOT_FOUND`, `CODE_EXPIRED`, `SESSION_ALREADY_OPEN`, `SESSION_NOT_FOUND`, `OFFER_UNAVAILABLE`, `SELF_CHALLENGE`, `INSUFFICIENT_BALANCE`, `BANKROLL_NOT_MULTIPLE`, `STAKE_OUT_OF_RANGE`, `BANKROLL_OUT_OF_RANGE`, `RATE_LIMITED`.

## 7. Lifecycle flows

**A. Claim X handle.** Detailed in §3.

**B. Enter arena.**
```
POST /api/gladiator/sessions { bankroll_base_units, bet_base_units }
  → require x_handle_verified_at IS NOT NULL                              → else 403 X_HANDLE_REQUIRED
  → validate bet ∈ [GLADIATOR_MIN_BET, GLADIATOR_MAX_BET]                 → else 400 STAKE_OUT_OF_RANGE
  → validate bankroll ∈ [bet, GLADIATOR_MAX_BANKROLL]                     → else 400 BANKROLL_OUT_OF_RANGE
  → validate bankroll % bet == 0                                          → else 400 BANKROLL_NOT_MULTIPLE
  → withTx:
       burnFromUser(c, email, bankroll, signingKey)                       → throws INSUFFICIENT_BALANCE
       INSERT INTO gladiator_sessions(..., status='OPEN', bankroll_remaining = initial)
         (UNIQUE partial index → 409 SESSION_ALREADY_OPEN on conflict)
       INSERT INTO gladiator_chat_messages(kind='SYSTEM', body='@<handle> entered with <N> RPOW')
  → 200 { session_id, ...session }
```

**C. Flip (the hot path).**
```
POST /api/gladiator/flip { session_id }
  → require challenger session + verified                                 → else 401/403
  → withTx:
       SELECT FOR UPDATE gladiator_sessions WHERE id=$1
         require exists AND status='OPEN' AND bankroll_remaining >= bet   → else 409 OFFER_UNAVAILABLE
         require account_email != challenger_email                        → else 400 SELF_CHALLENGE
       outcome = crypto.randomBytes(1)[0] & 1   // 0 = offerer wins, 1 = challenger wins
       if challenger wins:
         burnFromUser(c, challenger_email, bet, signingKey)               → INSUFFICIENT_BALANCE possible
         UPDATE bankroll_remaining -= bet, flips_lost += 1, last_flip_at = now()
         mint VALID token (value = 2*bet) to challenger_email
       else (offerer wins):
         burnFromUser(c, challenger_email, bet, signingKey)               → INSUFFICIENT_BALANCE possible
         UPDATE bankroll_remaining += bet, flips_won += 1, last_flip_at = now()
       if bankroll_remaining < bet: status='CLOSED', closed_at=now(), mint remainder back, emit SYSTEM chat
       sign canonical flip payload (id, offerer_email_hash, challenger_email_hash, bet, winner_email_hash, rv_hex, ts)
       INSERT INTO gladiator_flips (...)
       INSERT INTO gladiator_chat_messages(kind='SYSTEM', body='@<winner> beat @<loser> for <N> RPOW')
  → 200 { winner_email, bet, signature, server_time, random_value_hex, share_text }
```

**D. Leave arena.**
```
POST /api/gladiator/sessions/:id/close
  → withTx + SELECT FOR UPDATE
  → require caller owns session AND status='OPEN'
  → if bankroll_remaining > 0: mint VALID token back
  → UPDATE status='CLOSED', closed_at=now()
  → INSERT INTO gladiator_chat_messages(kind='SYSTEM', body='@<handle> left the arena')
```

**E. Chat post.** Insert a USER row after rate-limit check. Read API returns 50 most recent rows, ordered newest-first; client renders chronologically.

**F. Share-on-win.** Client-side only: after a winning flip response, the result modal includes a button whose `href` is `https://twitter.com/intent/tweet?text=<encoded share_text>` where `share_text` comes from the server response (so it stays consistent with audit). Example text:

> *I just won {N} RPOW in the gladiator arena against @{opp}. Come fight me at gladiator.rpow2.com*

**Concurrency.** Every state-changing path takes `SELECT … FOR UPDATE` on the relevant `gladiator_sessions` row inside `withTx`. The UNIQUE partial index on open sessions makes the "one open per user" invariant DB-enforced.

## 8. Frontend

New SPA `apps/web-gladiator/`, cloned from `apps/web-longshot/` shape and deployed to `gladiator.rpow2.com` via Netlify.

**Three top-level states:**
1. Not signed in / spectator — read-only lobby + chat with a "Sign in at rpow2.com to fight" banner.
2. Signed in but not X-verified — XHandleClaimModal blocks the rest of the UI until verified.
3. Signed in + verified — full arena access.

**Layout — desktop (≥ 960 px):**

Two-column. Main column holds (top to bottom) the "Enter the Arena" CTA / "Your Session" panel, the OPEN gladiators list with `[FLIP!]` buttons, and a Recent Flips tail. A fixed right sidebar (~320 px) holds the global chat panel.

**Layout — mobile (< 960 px):**

Single column with the chat behind a top-of-page tab (`[ARENA] [CHAT (3)]` with an unread badge). Sticky bottom bar for the primary CTA.

**Components:**

| Component | Responsibility |
|---|---|
| `App.tsx` | Routing, session state, balance polling |
| `XHandleClaimModal.tsx` | Three-step verification UX (handle → tweet → URL paste → verified) |
| `EnterArenaModal.tsx` | Bankroll + bet picker; slider in flip-units |
| `LobbyList.tsx` | Polls `/lobby` every 5 s; renders open gladiators |
| `YourSession.tsx` | Visible only while caller has an OPEN session |
| `FlipConfirmModal.tsx` | Confirmation step before the flip |
| `FlipResultModal.tsx` | Coin animation; WIN state shows the 🐦 tweet button |
| `RecentFlipsList.tsx` | Public flip tail |
| `ChatPanel.tsx` | Right sidebar on desktop; tab on mobile; 5 s polling; post box |

## 9. Operational details

**New env vars (extend `apps/server/src/env.ts`):**

| Var | Default | Notes |
|---|---|---|
| `GLADIATOR_MIN_BET_BASE_UNITS` | `10_000_000` (0.01 RPOW) | Lower bound on bet |
| `GLADIATOR_MAX_BET_BASE_UNITS` | `10_000_000_000` (10 RPOW) | Matches the new longshot cap |
| `GLADIATOR_MAX_BANKROLL_BASE_UNITS` | `100_000_000_000` (100 RPOW) | Caps how dominant any single gladiator can be |
| `GLADIATOR_SESSION_TTL_HOURS` | `48` | Auto-close idle sessions |
| `GLADIATOR_CHAT_RETENTION_DAYS` | `30` | Sweep chat older than this |
| `GLADIATOR_ALLOWED_EMAILS` | `*` | CSV allowlist; `*` = open. Ship open from day one. |
| `GLADIATOR_WEB_ORIGIN` | `https://gladiator.rpow2.com` | CORS entry |
| `GLADIATOR_ADMIN_TOKEN` | (unset → admin route 403) | Bearer token for the admin verify route |

Range validator parallels longshot's: assert `max >= min`, all positive.

**Cross-subdomain auth.** Verify before launch that the `rpow_session` cookie is scoped to `.rpow2.com` (longshot already works on `longshot.rpow2.com`, so this should already be in place — but call it out as a deploy-checklist item).

**Background sweeper.** Extend `apps/server/src/schedule.ts` with a single periodic job running every 10 min:

1. Auto-close any OPEN session where `COALESCE(last_flip_at, opened_at) < now() - GLADIATOR_SESSION_TTL_HOURS`; mint remainder back; emit SYSTEM chat row.
2. `DELETE FROM gladiator_chat_messages WHERE created_at < now() - GLADIATOR_CHAT_RETENTION_DAYS`.

**Rate limits (Fastify rate-limit plugin):**

| Route | Limit | Key |
|---|---|---|
| `POST /api/gladiator/flip` | 30 / min | `x-forwarded-for` |
| `POST /api/gladiator/sessions` | 5 / min | session email |
| `POST /api/gladiator/sessions/:id/close` | 10 / min | session email |
| `POST /api/gladiator/chat` | 6 / min | session email |
| `POST /api/gladiator/x-handle/start` | 5 / 10 min | session email |
| `POST /api/gladiator/x-handle/verify` | 10 / 10 min | session email |

**X verification module** `apps/server/src/gladiator/xVerify.ts`:

- `verifyTweet(tweetUrl: string): Promise<{ authorHandle: string; text: string } | null>` — calls `publish.twitter.com/oembed?url=<url>&omit_script=1` with a 5 s timeout and one retry. Extracts the handle from `author_url` and the tweet body from the `html` field (HTML tags stripped). Returns null on any failure; caller surfaces the appropriate error code.

**Deploy checklist** (will go into `ops/server/GLADIATOR_DEPLOY.md`, mirrors `LONGSHOT_DEPLOY.md`):

1. New Netlify site for `gladiator.rpow2.com` pointing at `apps/web-gladiator/dist`.
2. DNS: `gladiator.rpow2.com` CNAME.
3. Append new env vars to `/etc/rpow/server.env` on the VPS.
4. Apply migration `014_gladiator.sql`.
5. Restart `rpow-server`.
6. Smoke test end-to-end: spectator view loads anonymous → claim-handle flow against a real X account → enter arena → flip → leave arena → balance restored.

**Observability.** Reuse the existing pino logger; structured fields `{ feature: 'gladiator', event: 'flip' | 'enter' | 'close' | 'chat' | 'verify' }` for grep-ability.

## 10. Testing strategy

Mirror Long Shot's test footprint (Vitest + Fastify `app.inject` + real Postgres via `makeTestApp`).

**Server unit tests** (`apps/server/src/gladiator/`):
- `xVerify.test.ts` — oEmbed response parser (mock `global.fetch`); handle extraction, body extraction, malformed/timeout cases.
- `flip.test.ts` — deterministic outcome derivation from a mocked `crypto.randomBytes`; signature canonicalization.
- `xHandle.test.ts` — handle normalization edge cases (strip `@`, lowercase, reject non-ASCII, case-insensitive uniqueness).

**Server route tests** (`apps/server/tests/gladiator*.test.ts`):
- `gladiatorXHandle.test.ts` — claim flow happy path, `HANDLE_TAKEN` race, `HANDLE_MISMATCH`, `CODE_NOT_FOUND`, `CODE_EXPIRED`, concurrent verification race.
- `gladiatorSessions.test.ts` — enter requires verified, `BANKROLL_NOT_MULTIPLE`, `INSUFFICIENT_BALANCE`, `SESSION_ALREADY_OPEN`, leave mints remainder, non-owner cannot close.
- `gladiatorFlip.test.ts` — `SELF_CHALLENGE`, unverified challenger 403, offerer-wins path, challenger-wins path, drained bankroll auto-close, `OFFER_UNAVAILABLE` race (two concurrent flips), career W/L aggregation correctness.
- `gladiatorLobby.test.ts` — public access, OPEN-only filter, joined `x_handle`/`x_avatar_url`, 15 s cache behavior.
- `gladiatorChat.test.ts` — verified-only POST, length bounds, pagination, SYSTEM rows interleave, rate limit 429, retention sweep.
- `gladiatorSweeper.test.ts` — TTL closes idle sessions and mints remainder; recent-flip sessions untouched; chat retention sweep.
- `gladiatorInvariants.test.ts` — randomized N-flip/M-user run asserting (a) VALID-token-supply invariant, (b) every flip signature verifies against server pubkey, (c) W/L aggregates match.

**Frontend tests** (`apps/web-gladiator/src/__tests__/`):
Light — XHandleClaimModal state machine, EnterArenaModal multiple-of-bet validation, FlipConfirmModal balance forecast. Skip layout tests.

## 11. Implementation order

Suggested vertical-slice order for the implementation plan:

1. Migration 014 + env vars + route module skeleton (compiles, no behavior).
2. X handle verification end-to-end (server + claim modal in a temporary test page).
3. Enter arena + leave arena (no flipping yet); confirm token math via tests.
4. Flip route + audit row + tests for both outcomes and concurrency invariant.
5. Public lobby + recent flips endpoints + their 15 s cache.
6. Frontend layout: lobby, EnterArenaModal, FlipConfirmModal/ResultModal, share-on-X intent.
7. Global chat (server + sidebar/tab UI).
8. Background sweeper + deploy doc + Netlify subdomain.
9. End-to-end smoke + first allowlist users.
