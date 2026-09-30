# RPOW Trivia — design spec

**Date:** 2026-05-11
**Status:** approved
**Authors:** fred + claude

## 1. Summary

RPOW Trivia is a PVP feature parallel to RPOW Gladiator: rpow account holders verify an X handle (shared with gladiator), enter a *trivia arena* with an RPOW bankroll, and accept head-to-head matches from other verified users. Each match is one multiple-choice trivia question with 4 choices and a 10-second deadline. Faster-correct answer wins. Pure 50/50 in expectation when both players answer well; the bet is symmetric (winner takes `2 × bet`, zero rake). Matches are server-resolved and ed25519-signed (same fairness story as gladiator). Lives at `trivia.rpow2.com` as its own SPA with a shared API backend.

## 2. Goals / non-goals

**In scope (V1):**

- Trivia-arena sessions (bankroll, bet) parallel to gladiator
- Both-online active matches: both players must answer within a 10s window
- Question fetched from Open Trivia DB; cached server-side
- Match resolution rules (see §4)
- Real-time coordination via 2-second HTTP polling — no WebSockets
- Public lobby + recent-matches feed (no login to spectate)
- Global trivia chat (USER messages only — same model as gladiator post-cleanup)
- Per-match share-on-X intent for wins
- Auto-close of inactive sessions (parallel to gladiator)

**Out of scope (V1):**

- Multi-question matches (best of N)
- Category / difficulty selectable by player
- Cross-game lobby (trivia and gladiator are independent SPAs and DB tables)
- WebSockets / SSE (2-second polling is adequate for a 10-second match window)
- Leaderboards (phase 2)
- LLM-generated questions (phase 2)
- Question reporting / moderation UI

## 3. Identity

Trivia reuses the X-handle verification from gladiator slice 2. No new verification flow. A user verified for gladiator is automatically eligible for trivia. The same `users.x_handle`, `users.x_handle_verified_at`, `users.x_avatar_url` columns gate participation.

## 4. Game mechanics

**Roles.** Asymmetric, same shape as gladiator.

- **Offerer (Alice):** clicks *Enter the Arena*, commits a bankroll, declares a per-match bet. Becomes a visible offerer in the trivia lobby. Multiple challengers can fight her in sequence until her bankroll drains or she leaves.
- **Challenger (Bob):** browses the lobby, clicks *Challenge @alice*. Server creates an `ACTIVE` match with a 10s deadline, burns Bob's bet from his VALID tokens, picks a fresh trivia question. Alice's UI polls and joins the same match. Both see the same question. Each picks one of four choices. Server resolves.

**Both sides must be X-verified.** Spectators can view the lobby and chat without signing in.

**Per-match stake.** Fixed and equal to the offerer's declared `bet_base_units` for that session.

**Resolution rules** (server-authoritative timestamps; no client clock trust):

| Offerer answer | Challenger answer | Winner |
|---|---|---|
| correct | correct, slower | offerer |
| correct, slower | correct | challenger |
| correct | wrong / timeout | offerer |
| wrong / timeout | correct | challenger |
| wrong / timeout | wrong / timeout | **offerer** (challenger loses bet) |
| correct, same instant (tie) | correct, same instant | **offerer** (ties resolve to defender) |

Server timestamps use millisecond precision. Ties at ms granularity are vanishingly rare but resolve to the defender (offerer) by convention. Players who never answer are treated as "wrong / timeout" — the server records `choice_idx = NULL, answered_at = NULL`.

**Bankroll constraint.** Same as gladiator: `bankroll % bet == 0` (CHECK constraint in migration). UI presents bankroll as "N matches × bet".

**Rake.** Zero. Winner gets the full `2 × bet`.

**Auto-close.** Sessions with `last_match_at < now() - TRIVIA_SESSION_TTL_HOURS` (default 48h, declared as its own env var — see §10) are closed by a periodic sweeper. Remaining bankroll is minted back to the owner.

**Mid-match drain.** Same logic as gladiator: if `bankroll_remaining` falls below `bet` after a match settles, the session auto-closes inside the same transaction, remainder minted back.

## 5. Data model

New migration `apps/server/migrations/016_trivia.sql`. **No changes to existing schema.** (Migration `015` is reserved for any in-flight gladiator follow-ups; trivia gets `016` to leave headroom.)

```sql
-- 1. Trivia question cache. Populated by a background fetcher from
-- https://opentdb.com/api.php?amount=50&type=multiple . Each question gets
-- a server-generated UUID so we don't depend on opentdb's identifiers.
CREATE TABLE trivia_questions (
  id            UUID PRIMARY KEY,
  category      TEXT NOT NULL,
  difficulty    TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question      TEXT NOT NULL,
  -- 4 choices: choices[correct_idx] is the right answer. Indices 0..3.
  -- Choices are pre-shuffled at fetch time so the correct one isn't always
  -- at the same position.
  correct_idx   INT NOT NULL CHECK (correct_idx >= 0 AND correct_idx < 4),
  choices       TEXT[] NOT NULL CHECK (array_length(choices, 1) = 4),
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trivia_questions_fetched_idx ON trivia_questions(fetched_at);

-- 2. Trivia arena sessions (mirrors gladiator_sessions)
CREATE TABLE trivia_sessions (
  id                              UUID PRIMARY KEY,
  account_email                   TEXT NOT NULL REFERENCES users(email),
  bet_base_units                  BIGINT NOT NULL CHECK (bet_base_units > 0),
  bankroll_initial_base_units     BIGINT NOT NULL CHECK (bankroll_initial_base_units > 0),
  bankroll_remaining_base_units   BIGINT NOT NULL CHECK (bankroll_remaining_base_units >= 0),
  matches_won                     INT NOT NULL DEFAULT 0,
  matches_lost                    INT NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_match_at                   TIMESTAMPTZ,
  closed_at                       TIMESTAMPTZ,
  CHECK (bankroll_initial_base_units % bet_base_units = 0)
);
CREATE UNIQUE INDEX trivia_sessions_one_open_per_user
  ON trivia_sessions (account_email) WHERE status = 'OPEN';
CREATE INDEX trivia_sessions_open_lobby_idx
  ON trivia_sessions (opened_at DESC) WHERE status = 'OPEN';
CREATE INDEX trivia_sessions_sweeper_idx
  ON trivia_sessions (COALESCE(last_match_at, opened_at)) WHERE status = 'OPEN';

-- 3. Per-match record (signed once resolved)
CREATE TABLE trivia_matches (
  id                       UUID PRIMARY KEY,
  offerer_session_id       UUID NOT NULL REFERENCES trivia_sessions(id),
  offerer_email            TEXT NOT NULL,
  challenger_email         TEXT NOT NULL,
  bet_base_units           BIGINT NOT NULL CHECK (bet_base_units > 0),
  question_id              UUID NOT NULL REFERENCES trivia_questions(id),
  state                    TEXT NOT NULL CHECK (state IN ('ACTIVE','RESOLVED')),
  deadline_at              TIMESTAMPTZ NOT NULL,
  offerer_choice_idx       INT CHECK (offerer_choice_idx IS NULL OR (offerer_choice_idx >= 0 AND offerer_choice_idx < 4)),
  offerer_answered_at      TIMESTAMPTZ,
  challenger_choice_idx    INT CHECK (challenger_choice_idx IS NULL OR (challenger_choice_idx >= 0 AND challenger_choice_idx < 4)),
  challenger_answered_at   TIMESTAMPTZ,
  winner_email             TEXT,
  signature                BYTEA,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  CHECK ((state = 'RESOLVED') = (winner_email IS NOT NULL AND signature IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX trivia_matches_session_active_idx
  ON trivia_matches(offerer_session_id) WHERE state = 'ACTIVE';
CREATE INDEX trivia_matches_recent_idx
  ON trivia_matches(created_at DESC) WHERE state = 'RESOLVED';
CREATE INDEX trivia_matches_offerer_idx
  ON trivia_matches(offerer_email, created_at DESC);
CREATE INDEX trivia_matches_challenger_idx
  ON trivia_matches(challenger_email, created_at DESC);

-- One active match per session — challenger sees OFFER_UNAVAILABLE if there
-- is already an in-flight match. Defender can only handle one at a time.
CREATE UNIQUE INDEX trivia_matches_one_active_per_session
  ON trivia_matches (offerer_session_id) WHERE state = 'ACTIVE';

-- 4. Global trivia chat (parallel to gladiator_chat_messages)
CREATE TABLE trivia_chat_messages (
  id            UUID PRIMARY KEY,
  account_email TEXT REFERENCES users(email),
  x_handle      TEXT,
  kind          TEXT NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER','SYSTEM')),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'USER') = (account_email IS NOT NULL))
);
CREATE INDEX trivia_chat_recent_idx ON trivia_chat_messages(created_at DESC);
```

**Key design notes:**

- W/L on `trivia_sessions` is per-session and updated inline. Career W/L is computed from `trivia_matches` aggregates.
- `trivia_matches.offerer_session_id` is non-null and references the session; challenger doesn't have a session.
- The `trivia_matches_one_active_per_session` partial UNIQUE index enforces "one in-flight match per offerer" — a challenger trying to challenge a session that already has an active match gets `OFFER_UNAVAILABLE` from a DB-level conflict.
- Chat read filters to `kind = 'USER'` (lesson learned from gladiator's chat-flood incident).

## 6. API surface

All endpoints under `/api/trivia/`. Cookie auth via the existing `rpow_session` cookie. Rate limits per the table in §10.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/me` | session | Caller's profile + open trivia session if any + career W/L |
| `POST` | `/sessions` | session + verified | Enter the arena; body `{ bankroll_base_units, bet_base_units }` |
| `POST` | `/sessions/:id/close` | session, must own | Leave the arena; mints remainder back |
| `GET` | `/lobby` | public | List all OPEN trivia sessions with owner profile fields |
| `POST` | `/matches/start` | session + verified | Challenge a session; body `{ session_id }`; creates ACTIVE match, returns question + choices + deadline |
| `GET` | `/matches/active` | session, must be the offerer of `?session_id=` | Offerer's poll: returns the in-flight match for their session, or `null` |
| `POST` | `/matches/:id/answer` | session, must be either offerer or challenger of this match | Body `{ choice_idx }`; records answer with server timestamp |
| `GET` | `/matches/:id` | session, must be a player | Poll match state for resolution |
| `GET` | `/matches/recent` | public | Recent resolved matches for the recent-matches tail |
| `GET` | `/matches/history` | session | The caller's own match history (offerer + challenger sides) |
| `GET` | `/chat` | public | List recent USER messages; query `before` for pagination |
| `POST` | `/chat` | session + verified | Post `{ body }` (1..280 chars) |
| `GET` | `/stats` | public | Total matches + volume + verified players + in-arena count |

**Error codes** (uniform shape `{ error: <CODE>, message: string }`): `BAD_REQUEST`, `UNAUTHORIZED`, `X_HANDLE_REQUIRED`, `SESSION_ALREADY_OPEN`, `SESSION_NOT_FOUND`, `OFFER_UNAVAILABLE`, `SELF_CHALLENGE`, `INSUFFICIENT_BALANCE`, `BANKROLL_NOT_MULTIPLE`, `STAKE_OUT_OF_RANGE`, `BANKROLL_OUT_OF_RANGE`, `MATCH_NOT_FOUND`, `NOT_A_PLAYER`, `ALREADY_ANSWERED`, `MATCH_EXPIRED`, `RATE_LIMITED`, `NO_QUESTIONS_AVAILABLE`.

## 7. Lifecycle flows

**A. Enter arena.** Parallel to gladiator's enter; uses `burnFromUser` + `minted_supply -= bankroll` (same convention as the slice-3 cleanup fix).

```
POST /api/trivia/sessions { bankroll_base_units, bet_base_units }
  → require x_handle_verified_at IS NOT NULL                              → else 403 X_HANDLE_REQUIRED
  → require triviaAllowedEmails ⊇ s.email                                 → else 403 NOT_ALLOWED
  → validate ranges and multiples (same as gladiator)
  → withTx:
       burnFromUser(c, email, bankroll, signingKey)
       UPDATE app_counters SET minted_supply -= bankroll
       INSERT INTO trivia_sessions(..., status='OPEN', bankroll_remaining = initial)
  → 200 { session_id, ...session }
```

**B. Challenge (the hot path).**

```
POST /api/trivia/matches/start { session_id }
  → require challenger session + verified                                 → else 401/403
  → withTx:
       SELECT FOR UPDATE trivia_sessions WHERE id=$1
         require exists AND status='OPEN' AND bankroll_remaining >= bet   → else 409 OFFER_UNAVAILABLE
         require account_email != challenger_email                        → else 400 SELF_CHALLENGE
       burnFromUser(c, challenger_email, bet, signingKey)                 → INSUFFICIENT_BALANCE possible
       UPDATE app_counters SET minted_supply -= bet
       pick a random trivia_questions row (ORDER BY random() LIMIT 1)
         require pool not empty                                           → else 503 NO_QUESTIONS_AVAILABLE
       deadline = now() + INTERVAL '10 seconds'
       INSERT INTO trivia_matches(state='ACTIVE', deadline_at, ...)
         (UNIQUE partial index → 409 OFFER_UNAVAILABLE on conflict)
  → 200 { match_id, question, choices, deadline_at }
```

**C. Submit answer.**

```
POST /api/trivia/matches/:id/answer { choice_idx }
  → require session + valid choice_idx
  → withTx:
       SELECT FOR UPDATE trivia_matches WHERE id=$1
         require state='ACTIVE' AND now() < deadline_at                    → else 410 MATCH_EXPIRED
         determine which side caller is (offerer/challenger) by email      → else 403 NOT_A_PLAYER
         require this side has not already answered                        → else 409 ALREADY_ANSWERED
       UPDATE trivia_matches SET <side>_choice_idx, <side>_answered_at = now()
       if both sides have now answered: call resolveMatch() (see D)
  → 200 { answered_at, both_answered: boolean }
```

**D. Match resolution.** Called either when both players have answered, OR by the offerer poll when `now() > deadline_at` (lazy resolution — no background worker needed).

```
resolveMatch(c, matchId):
  SELECT FOR UPDATE the row
  if state='RESOLVED': return                                              -- idempotent
  determine winner per §4 resolution table (server-side comparison)
  winner_email = ...
  if challenger wins:
    mint VALID token (value = 2*bet) to challenger_email (cap-checked, throws SUPPLY_CAP_REACHED)
    UPDATE trivia_sessions SET bankroll_remaining -= bet, matches_lost += 1, last_match_at = now()
  else (offerer wins):
    UPDATE trivia_sessions SET bankroll_remaining += bet, matches_won += 1, last_match_at = now()
  if bankroll_remaining < bet:
    auto-close session, mint remainder back (cap-checked, throws SUPPLY_CAP_REACHED)
    INSERT SYSTEM chat 'drained out of the arena'
  sign canonical match payload {id, offerer_email_hash, challenger_email_hash, bet,
    question_id, offerer_choice_idx, challenger_choice_idx, winner_email_hash,
    offerer_answered_at, challenger_answered_at, created_at}
  UPDATE trivia_matches SET state='RESOLVED', winner_email, signature, resolved_at
```

**E. Active-match poll (offerer side).**

```
GET /api/trivia/matches/active?session_id=X
  → require caller owns the session                                       → else 403
  → SELECT * FROM trivia_matches WHERE offerer_session_id=$1 AND state='ACTIVE'
  → if found AND now() > deadline_at: resolveMatch() then refetch
  → if state='RESOLVED' AND resolved_at within last 5s: return final state so client sees the result
  → if state='ACTIVE' AND offerer_choice_idx IS NULL: return active match for offerer to answer
  → else: return { match: null }
```

**F. Match state poll (both sides).**

```
GET /api/trivia/matches/:id
  → require caller is offerer or challenger of this match                 → else 403
  → if state='ACTIVE' AND now() > deadline_at: resolveMatch()
  → return full match row (question, choices, both answers if visible, winner if resolved)
```

**G. Chat post / read.** Same as gladiator post-cleanup: read filters `kind='USER'`, returns 100 most recent; post is rate-limited 5/min per IP.

**H. Share-on-win.** Client-side only. The match resolution response includes `share_text`:

> *I just won {N} RPOW in the RPOW Trivia arena against @{opp} by answering "{question}" correctly. Come fight me at trivia.rpow2.com*

Truncated to ~250 chars to leave room for the URL.

## 8. Frontend

New SPA `apps/web-trivia/`, cloned from `apps/web-gladiator/`, deployed to `trivia.rpow2.com` via Netlify.

**Three top-level states** (same as gladiator):

1. Not signed in / spectator — read-only lobby + chat + recent matches + "Sign in at rpow2.com to fight" banner.
2. Signed in but not X-verified — XHandleClaimModal blocks the rest of the UI until verified (same component as gladiator can be ported / shared).
3. Signed in + verified — full arena access.

**Layout** mirrors gladiator: header + KPI strip + 2-column main (lobby + your-session panel on left, chat + recent matches on right). Mobile collapses to single column.

**Components:**

- `EnterArenaForm` — parallel to gladiator. Bet + bankroll picker.
- `YourSessionPanel` — parallel to gladiator. Bankroll remaining, W/L, leave-arena button. **NEW:** auto-watches for an incoming active match; opens `TriviaMatchModal` automatically.
- `TriviaMatchModal` — the heart of the UX. States:
  - `loading` — POST /matches/start in flight (challenger only) OR auto-opened on offerer-side from a poll
  - `active` — shows question + 4 choice buttons + countdown timer (driven by `deadline_at` from server, not local clock). Once player picks: choices disable, "waiting for opponent" indicator.
  - `result` — same shape as gladiator's FlipModal result step. Winner, both answers shown, correct answer highlighted, signature footer, share-on-X intent button if challenger won.
- `KPIStrip` — total matches, RPOW wagered, in-arena, verified players (re-uses the gladiator `kpi-strip` styling).
- `ArenaChat` — same shape as gladiator chat panel (input + 100-message scroll).
- `RecentMatchesPanel` — winner-beat-loser rows like gladiator's RECENT FLIPS.

**Polling cadence:**

- 5s for lobby / chat / recent matches (same as gladiator)
- 2s for `/matches/active` while offerer has an OPEN session
- 1s while a player is in an ACTIVE match (the match poll), so the countdown and result feel responsive

**Forwarded-session adoption:** main.tsx handshake from rpow2.com's /apps tile click — same code as web-gladiator's `maybeAdoptForwardedSession`.

## 9. Question fetcher (background task)

New module `apps/server/src/trivia/questions.ts`:

```ts
// Refill the trivia_questions cache when its size drops below LOW_WATER,
// up to HIGH_WATER. Fetches from opentdb.com one batch of 50 at a time.
// Called on app boot AND lazily inside /matches/start when the pool is
// empty (rare, but covers the cold-start case).
export async function refillTriviaQuestions(pool, opts: { low: number; high: number })
```

Boot sequence in `server.ts`:

```ts
await refillTriviaQuestions(pool, { low: 50, high: 200 });
setInterval(() => refillTriviaQuestions(pool, { low: 50, high: 200 }), 10 * 60 * 1000);
```

Open Trivia DB API:

```
GET https://opentdb.com/api.php?amount=50&type=multiple
→ { response_code: 0, results: [ { category, type, difficulty, question, correct_answer, incorrect_answers: [a,b,c] } ] }
```

We HTML-entity-decode every text field (opentdb returns "&quot;Hello&quot;"), shuffle the 4 choices to pick a random `correct_idx`, then INSERT.

Cache invalidation: never delete rows automatically (cheap to keep, useful for audit replay). The `trivia_matches.question_id → trivia_questions.id` FK is preserved indefinitely.

## 10. Rate limits + config

Re-use the existing nginx `rpow_user` upstream — gladiator and trivia compete for the same pool. New nginx block: `/api/trivia/` → `rpow_user`. Per-route fastify rate-limits mirror gladiator (POST /sessions: 5/min, POST /chat: 5/min, POST /matches/start: 10/min, POST /matches/:id/answer: 30/min).

New env vars (defaults in `apps/server/src/env.ts`):

| Var | Default | Purpose |
|---|---|---|
| `TRIVIA_MIN_BET_BASE_UNITS` | `10_000_000` (0.01 RPOW) | Min bet per match |
| `TRIVIA_MAX_BET_BASE_UNITS` | `10_000_000_000` (10 RPOW) | Max bet per match |
| `TRIVIA_MAX_BANKROLL_BASE_UNITS` | `100_000_000_000` (100 RPOW) | Max bankroll |
| `TRIVIA_MATCH_DEADLINE_SECONDS` | `10` | Per-match answer window |
| `TRIVIA_SESSION_TTL_HOURS` | `48` | Auto-close idle sessions |
| `TRIVIA_ALLOWED_EMAILS` | `*` | CSV allowlist (mirrors gladiator) |
| `TRIVIA_WEB_ORIGIN` | `https://trivia.rpow2.com` | CORS allow + tweet URL host |

## 11. Tests

**Server:**

- `triviaMigration.test.ts` — schema sanity, indexes, CHECK constraints
- `triviaQuestions.test.ts` — refill logic, HTML decoding, shuffle correctness
- `triviaSessions.test.ts` — enter/leave parallel to gladiator's
- `triviaMatchStart.test.ts` — challenge happy path, OFFER_UNAVAILABLE, SELF_CHALLENGE, INSUFFICIENT_BALANCE, NO_QUESTIONS_AVAILABLE, UNIQUE-active-per-session
- `triviaMatchAnswer.test.ts` — answer ordering, MATCH_EXPIRED, ALREADY_ANSWERED, NOT_A_PLAYER, idempotency, both-answered triggers resolve
- `triviaMatchResolve.test.ts` — every cell of the §4 resolution table, signature verifies, bankroll updated, supply accounting, auto-close on drain
- `triviaChat.test.ts` — same shape as gladiator chat tests (USER-only read, 100 limit)

**Frontend:**

- Light: TriviaMatchModal state-machine snapshot, EnterArenaForm validation. Skip layout tests.

## 12. Slicing

1. **Migration + env + route stubs + question fetcher** — migration `016`, env vars, `apps/server/src/trivia/{questions.ts, randomness.ts}`, route skeleton with 501 stubs, boot-time refill.
2. **Sessions + lobby + chat + stats** — enter/leave (mirror gladiator slice 3), GET /lobby, GET/POST /chat, GET /stats, GET /me, GET /matches/recent + /history.
3. **Match start + answer + resolve** — the playable core. POST /matches/start, POST /matches/:id/answer, GET /matches/active, GET /matches/:id, atomic `withTx` resolution with FlipPayload-style signing.
4. **Frontend scaffold** — `apps/web-trivia/`, auth gate, header, KPI strip, lobby UI, chat panel, recent-matches panel.
5. **Match modal + auto-open for offerer + polling cadence** — TriviaMatchModal (loading / active / result states), countdown, share-on-X, offerer-side incoming-match watcher.
6. **Deploy** — Netlify site + DNS + nginx rule for /api/trivia/ → rpow_user.

Each slice ships independently with its own tests + PR.

## 13. Migration notes

- New tables only; no existing schema touched
- Question cache starts empty; the boot-time fetch populates it before the first match
- If Open Trivia DB is unreachable at boot, `/matches/start` returns 503 NO_QUESTIONS_AVAILABLE until the next refill succeeds
