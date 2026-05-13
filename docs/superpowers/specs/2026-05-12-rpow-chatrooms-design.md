# RPOW ChatRooms — Design

Date: 2026-05-12
Status: Draft (brainstorm complete, awaiting user spec review)

## Summary

A public chat sub-app at `chat.rpow2.com`. Anyone can read; X-verified rpow users can post in a small set of topic rooms and DM each other. AOL-style ephemeral rooms (rolling window) plus persistent DMs. Listed alongside Free Lottery, Long Shot, Gladiator, and Trivia in the PROTOCOL APPS directory.

## Goals

- Give X-verified rpow users a real-time place to talk to each other on rpow2.com itself.
- Reuse every piece of existing infrastructure where possible (session, X-handle verification, retro 8-bit terminal aesthetic, Netlify sub-app pattern).
- Ship the MVP without new external dependencies (no Redis, no Pusher/Ably, no websocket gateway).
- Design the data model so v2 capabilities (flagging, user-created rooms, search) drop in without re-architecting.

## Non-goals (out-of-scope for MVP)

- Message flagging / user-reporting workflow (designed-for, not built)
- User-created rooms
- Images, links unfurls, file uploads (text only)
- Message editing
- DM read receipts
- Push notifications, email notifications for offline DMs
- Slash commands
- Threads / replies
- Search

## Decisions locked during brainstorm

| Decision               | Value                                                                   |
|------------------------|-------------------------------------------------------------------------|
| MVP scope              | Topic rooms + DMs + presence + typing + minimal moderation              |
| Room messages          | Ephemeral — last 200 OR last 24h, whichever shorter                     |
| DM messages            | Persistent (until author self-delete or admin nuke)                     |
| Room read access       | Public — no signin required                                             |
| Room post access       | rpow_session + X-handle verified                                        |
| DM access              | Both parties X-verified                                                 |
| Start a DM             | Click @handle in a room → handle popover → "Send DM"                    |
| Presence + typing      | Both, live, in-memory only                                              |
| Moderation MVP         | Own-delete + block + admin killswitch + admin ban                       |
| Layout                 | 3-panel: rooms+DMs sidebar / chat / user-list                           |
| Transport              | SSE for receive + POST for send                                         |
| Domain · sub-app       | `chat.rpow2.com` · `apps/web-chat`                                      |
| Initial rooms          | `#general`, `#rpow`, `#technology`, `#ai`, `#bitcoin`, `#solana`        |
| Aesthetic              | Retro 8-bit terminal — shared palette/tokens with `apps/web`            |

## Architecture

```
chat.rpow2.com (Netlify) — apps/web-chat
   │
   │  GET /api/chat/stream  (long-lived SSE)
   │  POST/DELETE chat APIs (normal HTTP)
   │  CORS allowlisted via CHAT_WEB_ORIGIN
   ▼
api.rpow2.com (existing Fastify, apps/server)
   apps/server/src/chat/
     routes/         ← Fastify handlers
     hub.ts          ← in-process EventEmitter for SSE fan-out
     store.ts        ← Postgres reads/writes (via app.pool: pg.Pool)
     sweeper.ts      ← 5-min rolling-window prune (boot-tick pattern)
     rateLimit.ts    ← per-user token buckets
     blockFilter.ts  ← per-recipient block check before fan-out
   ▼
Postgres (single existing DB, new migration 030_chat.sql)
```

- Single Node process (existing `cluster-entry.ts`).
- `hub.ts` holds active SSE subscriptions in memory keyed by `room:<slug>` and `dm:<thread_id>`.
- Write path: validate → DB insert → emit on hub → per-subscriber block filter → write SSE bytes.
- No new external services.

## Data Model

Migration: `apps/server/migrations/030_chat.sql`. Postgres syntax matching the existing freelottery/gladiator migrations.

```sql
CREATE TABLE chat_rooms (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  disabled     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling window. Sweeper trims to last 200 per room OR 24h.
CREATE TABLE chat_room_messages (
  id           BIGSERIAL PRIMARY KEY,
  room_slug    TEXT NOT NULL REFERENCES chat_rooms(slug),
  user_email   TEXT NOT NULL REFERENCES users(email),
  x_handle     TEXT NOT NULL,
  x_avatar_url TEXT,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_chat_room_messages_room_time ON chat_room_messages(room_slug, created_at DESC);

CREATE TABLE chat_dm_threads (
  id            BIGSERIAL PRIMARY KEY,
  user_a_email  TEXT NOT NULL REFERENCES users(email),  -- lexicographically smaller of the pair
  user_b_email  TEXT NOT NULL REFERENCES users(email),  -- lexicographically larger
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_a_email, user_b_email)
);

CREATE TABLE chat_dm_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES chat_dm_threads(id),
  sender_email  TEXT NOT NULL REFERENCES users(email),
  x_handle      TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_chat_dm_messages_thread_time ON chat_dm_messages(thread_id, created_at DESC);

CREATE TABLE chat_user_blocks (
  blocker_email  TEXT NOT NULL REFERENCES users(email),
  blocked_email  TEXT NOT NULL REFERENCES users(email),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_email, blocked_email)
);

CREATE TABLE chat_bans (
  user_email   TEXT PRIMARY KEY REFERENCES users(email),
  reason       TEXT,
  banned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_by    TEXT NOT NULL
);

-- Initial 6 rooms
INSERT INTO chat_rooms (slug, title, description) VALUES
  ('general',    '#general',    'Catch-all lounge.'),
  ('rpow',       '#rpow',       'rpow2 announcements + meta.'),
  ('technology', '#technology', 'Broad tech talk.'),
  ('ai',         '#ai',         'AI, LLMs, agents.'),
  ('bitcoin',    '#bitcoin',    'Bitcoin + Lightning.'),
  ('solana',     '#solana',     'Solana ecosystem.');
```

Presence and typing are **in-memory only** — kept in `hub.ts` as `Map<roomSlug, Map<userEmail, lastSeenMs>>`. SSE disconnect drops the user; typing entries decay after 10s.

v2 hook: a future `chat_message_reports` table can be added without touching the existing message tables. The handle popover and message-row components already leave room for a "Report" action.

## Access Matrix

| Action                  | Required                                          |
|-------------------------|---------------------------------------------------|
| Read room messages      | None — fully public                               |
| Read user list/presence | None                                              |
| Subscribe to SSE        | None (anonymous tail allowed)                     |
| Post to a room          | rpow_session **+** X-handle verified              |
| Send a DM               | rpow_session + X-handle verified (sender + recipient must both be verified) |
| Read a DM thread        | Authenticated as one of the two parties           |
| Delete own message      | Authenticated as author                           |
| Block a user            | rpow_session + X-handle verified                  |
| Disable a room          | Admin (existing admin-API-key pattern)            |
| Ban a user              | Admin                                             |

Auth reuses:
- `apps/server/src/session.ts` (`rpow_session` cookie, shared with web, freelottery, gladiator, trivia).
- The existing X-handle verification flow (`apps/server/src/gladiator/xVerify.ts`).
- `XHandleClaimModal` copied verbatim into `apps/web-chat` (same pattern Free Lottery used).

CORS: new env var `CHAT_WEB_ORIGIN` (default `https://chat.rpow2.com`), wired into `apps/server/src/env.ts` → `AppConfig.chatWebOrigin` → appended to `allowedOrigins` in `buildApp.ts`.

## Realtime Protocol

### SSE endpoint

`GET /api/chat/stream?rooms=general,ai&dms=1`

- Anonymous client: rooms only; `dms=1` ignored if no session.
- Authenticated client: rooms + auto-subscribed to every DM thread the user is part of.
- Session read from the `rpow_session` cookie, never from the query string.

### Wire format

Standard SSE. Each event:
- `id:` — DB row id for resumable events (`room_message`, `dm_message`, deletes), or synthetic `p:N` / `t:N` for non-resumable events.
- `event:` — event type (see table).
- `data:` — JSON payload.
- `: heartbeat` comment line emitted every 25s to prevent idle-close at Cloudflare/Netlify edges.

### Event types

| Event                  | Resumable | Payload                                                                |
|------------------------|-----------|------------------------------------------------------------------------|
| `room_message`         | yes       | `{room, id, x_handle, avatar, body, at}`                               |
| `room_message_deleted` | yes       | `{room, id}`                                                           |
| `room_presence`        | no        | `{room, kind: 'join'\|'leave', x_handle, avatar, count}`               |
| `room_presence_snapshot` | no      | `{room, members: [{x_handle, avatar}], count}` — sent once on join     |
| `room_typing`          | no        | `{room, x_handle, until: tsMs}`                                        |
| `dm_message`           | yes       | `{thread_id, id, sender_x_handle, body, at}`                           |
| `dm_message_deleted`   | yes       | `{thread_id, id}`                                                      |
| `dm_typing`            | no        | `{thread_id, x_handle, until: tsMs}`                                   |
| `system`               | no        | `{kind: 'room_disabled'\|'kicked'\|'backpressure', room?, message?}`. `room_disabled` fires to every subscriber of a room an admin just turned off; `kicked` fires to a user's active SSE streams when an admin bans them mid-session (client should clear local state and re-route to `/`); `backpressure` precedes a server-initiated stream close (client should reconnect with `Last-Event-Id`). |

### Send endpoints

| Method | Path                                  | Auth                | Body / params               |
|--------|---------------------------------------|---------------------|-----------------------------|
| POST   | `/api/chat/messages`                  | session + x_handle  | `{room, body}`              |
| DELETE | `/api/chat/messages/:id`              | author only         | —                           |
| POST   | `/api/chat/typing`                    | session + x_handle  | `{room}` or `{thread_id}`   |
| POST   | `/api/chat/dms`                       | session + x_handle  | `{to_x_handle, body}`       |
| DELETE | `/api/chat/dms/:id`                   | author only         | —                           |
| POST   | `/api/chat/blocks`                    | session + x_handle  | `{x_handle}`                |
| DELETE | `/api/chat/blocks/:x_handle`          | session             | —                           |
| GET    | `/api/chat/rooms`                     | none                | —                           |
| GET    | `/api/chat/rooms/:slug/messages`      | none                | `?limit=50&before=<id>`     |
| GET    | `/api/chat/dms`                       | session + x_handle  | —                           |
| GET    | `/api/chat/dms/:id/messages`          | session + thread    | `?limit=50&before=<id>`     |

POST handlers: validate → rate-limit → DB insert → emit on hub → return id+timestamp synchronously. The hub fans out asynchronously; subscribers receive the event over their SSE stream.

### Reconnect / catch-up

`EventSource` automatically sets `Last-Event-Id` on reconnect. On stream open the server:
1. Reads `Last-Event-Id` (if present).
2. For each subscribed room/DM thread, replays any resumable events with `id > Last-Event-Id` from DB, in order.
3. Sends fresh `room_presence_snapshot` for each subscribed room.
4. Switches to live.

A single SSE stream is server-closed after 1h to force a clean reconnect (this evicts zombie subscribers without leaking memory).

### Rate limits (in-process token buckets)

| Scope                              | Rate                            | Response on overflow                |
|------------------------------------|---------------------------------|-------------------------------------|
| Post to a room (per user)          | 1/sec, 5-burst, 50/min          | 429 + `Retry-After`                 |
| Send a DM (per user)               | 1/sec, 3-burst, 30/min          | 429                                 |
| Typing event (per user per scope)  | 1/sec hard cap                  | Silently dropped                    |
| SSE connections (per session)      | 3 concurrent                    | 429 on the 4th                      |

### Backpressure

Each SSE handler maintains a small outbound queue (cap 200 events). On overflow: drop `room_typing` / `dm_typing` / `room_presence` first; if still over, emit a `system: backpressure` and close the stream. Client reconnects with `Last-Event-Id`.

## UI / UX

### Routing (SPA, client-side)

| Path           | View                                              |
|----------------|---------------------------------------------------|
| `/`            | Redirects to `/r/general`                         |
| `/r/:slug`     | Room view (chat + right user list)                |
| `/d/:handle`   | DM thread with `@handle`                          |
| `/settings`    | Block list + sign-out                             |
| `/login`       | Magic-link sign-in (reused)                       |

### Layout

Three-panel desktop layout:

```
┌───────────────────────────────────────────────────────────────┐
│ ← RPOW · CHAT                      [your @handle] [signin]    │
├───────────┬─────────────────────────────────────┬─────────────┤
│ ROOMS     │ #ai · 7 here                         │ IN ROOM (7) │
│ #general  │ @frk314  opus 4.7 dropped            │ @frk314     │
│ #rpow     │ @dotkrueger  reading the blog now    │ @dotkrueger │
│ #ai (•)   │ @halstavern is typing…               │ @halstavern │
│ #bitcoin  │ ─────────────────────────────────── │ +4 more…    │
│ #solana   │ Type a message…                      │             │
│ DMS       │                                      │             │
│ @halst…   │                                      │             │
└───────────┴─────────────────────────────────────┴─────────────┘
```

- `(•)` = unread dot on rooms with new messages since last visit.
- `+N` next to a DM row = unread DM count.
- Right panel X avatars are clickable to `x.com/handle` (same pattern as Free Lottery entrant grid).
- Mobile (<720px): sidebar slides out behind a hamburger; user-list collapses to a `[ 7 here ▾ ]` dropdown above the chat scrollback.

### Auth states (composer)

1. **Anonymous** — composer disabled; CTA "Sign in with rpow → tweet to verify → post". Click opens sign-in modal.
2. **Signed-in, no X handle** — composer shows "Link your X account to post"; inline `XHandleClaimModal`.
3. **Signed-in + X-verified** — composer enabled. `Enter` sends; `Shift+Enter` newline. URLs auto-linkify (no HTML; rendered as text with anchor tags).
4. **Banned** — composer shows red banner "You can read but cannot post."
5. **Rate-limited** — composer briefly disables for the cooldown with a `Retry in 3s` countdown.

### Interaction flows

- **Click @handle** → handle popover with avatar + "View on X ↗" + "Send DM" + "Block".
- **Send DM** → creates or opens the canonical thread, redirects to `/d/:handle`.
- **Block** → confirmation. Two effects: (1) future room/DM messages authored by the blocked user are filtered out of the blocker's SSE stream server-side; (2) `POST /api/chat/dms` from the blocked user to the blocker returns 403 `BLOCKED` (the blocked user can still post in public rooms, just not DM the blocker). Block is one-way per Twitter/X convention; either party can unblock from `/settings`.
- **Admin disables a room** → clients in that room receive a `system: room_disabled` event; chat replaces with `This room is closed.`; composer hidden; sidebar greys the entry.

### Empty states

- No room messages yet: `[ no messages yet · be the first ]` glyph block (same style as Free Lottery `entrants-empty`).
- No DMs yet: side-list shows `Click any @handle in a room to start a DM.`
- DM thread newly opened: `Say hello to @halstavern.`

### Component file shape

```
apps/web-chat/src/
  main.tsx
  App.tsx                  ← router + masthead + SSE provider
  RealtimeProvider.tsx     ← owns the single EventSource, exposes hooks
  Sidebar.tsx              ← rooms + DMs lists
  RoomView.tsx             ← scrollback + composer + right panel
  RoomUserList.tsx
  DmView.tsx               ← persistent thread + composer
  Composer.tsx             ← shared message input (handles auth states)
  HandlePopover.tsx        ← click-handle menu (View / DM / Block)
  XHandleClaimModal.tsx    ← copied verbatim from freelottery
  api.ts                   ← typed fetch wrappers
  styles.css               ← retro 8-bit terminal palette/tokens
```

## Performance & Storage Envelope

- **Hub:** in-process `EventEmitter`. Expected launch load: <1k concurrent subscribers. Re-evaluate beyond ~10k.
- **Sweeper:** runs every 5 min from the existing boot-tick pattern; per-room delete trims to 200 newest OR newer than 24h.
- **Initial scrollback:** indexed `(room_slug, created_at DESC)` read, default 50 rows, max 200.
- **Message body cap:** 2000 chars server-validated; client char counter from 1800.
- **Storage estimate:** ~10 active rooms × 200 msgs × 1KB ≈ 2 MB hot. DMs grow with usage; re-evaluate when DM table exceeds 100 MB.

## Moderation MVP

| Capability                          | UI                                | Backend                                                  |
|-------------------------------------|-----------------------------------|----------------------------------------------------------|
| Delete your own message             | Hover menu on every own message   | `DELETE /api/chat/messages/:id`, soft-delete             |
| Block another user                  | Handle popover → Block            | Row in `chat_user_blocks`; filter before SSE write       |
| Unblock                             | `/settings`                       | `DELETE /api/chat/blocks/:x_handle`                      |
| Admin: disable a room               | admin-API-key script              | `UPDATE chat_rooms SET disabled=1 WHERE slug=?`          |
| Admin: ban a user                   | admin-API-key script              | Row in `chat_bans`; POSTs return 403 BANNED              |
| Admin: nuke a single message        | admin-API-key script              | Soft-delete; SSE emits `*_message_deleted`               |

Banned users can still read (rooms are public) — POSTs and DM sends return 403 with `error: 'BANNED'`. Composer shows a red banner.

## Testing Strategy

Matches the project's existing Vitest + Fastify-inject integration pattern.

**Unit** (`apps/server/src/chat/*.test.ts`):
- `store.ts`: insert/read/delete, rolling-window correctness with synthetic timestamps
- `sweeper.ts`: pruning behavior at exactly N=200 and at 24h+ε
- `hub.ts`: fan-out only to subscribed keys; block-filter drops matching events
- `rateLimit.ts`: token-bucket counts, burst handling, `Retry-After` value

**Integration** (`apps/server/src/chat/routes.test.ts`):
- Full HTTP round-trips against an ephemeral Postgres test schema (existing `makeTestApp` pattern), including SSE (open stream, POST a message, assert event lands)
- Auth matrix: anon read OK; anon post 401; signed-no-X post 412 `BIND_REQUIRED`; banned user 403
- DM thread creation idempotent (POST same pair twice → same thread_id)
- Reconnect: provide `Last-Event-Id`, assert missed messages replay in order

**Frontend** (`apps/web-chat/src/*.test.tsx`):
- `RealtimeProvider` event routing → component subscribers (mock `EventSource`)
- `Composer` state machine: signed-out / no-handle / verified / banned / rate-limited
- `HandlePopover` action routing

**E2E** (`apps/web-chat/playwright/`): one happy path — anon visit → sign in → bind X → post message → see it round-trip via SSE.

## Cross-cutting Tasks (not strictly chat code)

1. New env var `CHAT_WEB_ORIGIN` in `apps/server/src/env.ts` + wired into `AppConfig`.
2. CORS allowlist in `apps/server/src/buildApp.ts` appended with `config.chatWebOrigin`.
3. New Netlify site config `apps/web-chat/netlify.toml` (mirror `freelottery`).
4. Add `'RPOW ChatRooms'` to the `protocolApps` list in `apps/web/src/pages/Apps.tsx` with `forwardSession: true`.
5. News-log entry in `apps/web/src/pages/News.tsx` announcing the launch.

## Open Questions

None at design time. Anything that surfaces during implementation will be raised on the plan.

## Out-of-Scope (v2+) — repeat for emphasis

- Message reporting/flagging workflow (data model designed to accommodate)
- User-created rooms
- Images, link unfurls, file uploads
- Message editing
- DM read receipts
- Push notifications / email notifications for offline DMs
- Slash commands
- Threads/replies inside a room
- Search
