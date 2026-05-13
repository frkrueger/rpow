# RPOW ChatRooms — Slice 1 (Scaffold + Room List)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `chat.rpow2.com` as a new Netlify-hosted protocol-app SPA that lists the six seeded chat rooms fetched from a new `GET /api/chat/rooms` endpoint. Zero realtime, zero posting, zero DMs — just the scaffold + first vertical slice from migration to rendered UI.

**Architecture:** New backend module at `apps/server/src/chat/` with a tiny `store.ts` (rooms read) and `routes.ts` (one endpoint). New frontend app at `apps/web-chat/` mirroring the freelottery scaffold. New env var `CHAT_WEB_ORIGIN` + CORS allowlist entry. Migration `031_chat.sql` creates all chat tables (room messages, DMs, blocks, bans) but slice 1 only reads from `chat_rooms`.

**Tech Stack:** Fastify + Postgres (`pg.Pool` via `app.pool`) + zod (existing apps/server), Vite + React 18 + TypeScript (new apps/web-chat mirrors apps/web-freelottery). Tests use the existing `makeTestApp` helper (creates an isolated Postgres schema per test, runs all migrations).

**Reference spec:** `docs/superpowers/specs/2026-05-12-rpow-chatrooms-design.md`

---

### Task 1: Migration 031_chat.sql (Postgres)

**Files:**
- Create: `apps/server/migrations/031_chat.sql`
- Test: `apps/server/tests/chatMigration.test.ts`

The repo uses Postgres (`pg.Pool`). Migrations run via `runMigrations(pool)` in `apps/server/src/db.ts`. Tests use the `makeTestApp` helper (creates an isolated `t_<hex>` schema, runs all migrations, returns the pool).

- [ ] **Step 1: Write the migration**

`apps/server/migrations/031_chat.sql`:

```sql
-- ============================================================
-- Migration 031: RPOW ChatRooms.
-- Slice 1 creates the full schema (rooms, messages, DMs, blocks, bans,
-- mutes, tips) and seeds the six initial rooms with their AI host metadata.
-- Slice 1 wires only GET /api/chat/rooms — host runtime (slice 2) and
-- tip plumbing (slice 3) come later but share this schema.
-- See docs/superpowers/specs/2026-05-12-rpow-chatrooms-design.md.
-- ============================================================

CREATE TABLE chat_rooms (
  slug             TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  category         TEXT NOT NULL,                       -- 'ORIGINALS' | 'TECH' | 'CRYPTO' | 'GENERATIONS' | 'CULTURE' | 'LOUNGE'
  sort_order       INTEGER NOT NULL DEFAULT 0,
  disabled         BOOLEAN NOT NULL DEFAULT false,
  host_name        TEXT NOT NULL,
  host_persona     TEXT NOT NULL,
  host_avatar_url  TEXT,
  host_enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_rooms_category_sort ON chat_rooms(category, sort_order);

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
  user_a_email  TEXT NOT NULL REFERENCES users(email),
  user_b_email  TEXT NOT NULL REFERENCES users(email),
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

-- AI host can temporarily mute a user in one room. Soft, expires automatically.
CREATE TABLE chat_room_mutes (
  room_slug    TEXT NOT NULL REFERENCES chat_rooms(slug),
  user_email   TEXT NOT NULL REFERENCES users(email),
  muted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  muted_until  TIMESTAMPTZ NOT NULL,
  muted_by     TEXT NOT NULL,
  reason       TEXT,
  PRIMARY KEY (room_slug, user_email)
);
CREATE INDEX idx_chat_room_mutes_until ON chat_room_mutes(muted_until);

-- Host-awarded RPOW tips for good discussion contributions.
CREATE TABLE chat_tips (
  id                 BIGSERIAL PRIMARY KEY,
  room_slug          TEXT NOT NULL REFERENCES chat_rooms(slug),
  host_name          TEXT NOT NULL,
  message_id         BIGINT NOT NULL REFERENCES chat_room_messages(id),
  recipient_email    TEXT NOT NULL REFERENCES users(email),
  recipient_x_handle TEXT NOT NULL,
  base_units         BIGINT NOT NULL,
  reason             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_tips_created_at ON chat_tips(created_at DESC);
CREATE INDEX idx_chat_tips_recipient ON chat_tips(recipient_email, created_at DESC);

-- Initial 20 rooms across 6 categories, each with a named AI host.
INSERT INTO chat_rooms (slug, title, description, category, sort_order, host_name, host_persona) VALUES
  -- ORIGINALS
  ('general',     '#general',     'Catch-all lounge.',                       'ORIGINALS',   10, 'Vint Cerf',     'AI host inspired by the internet pioneer. Welcoming, steers tangents back to topic, asks open-ended questions.'),
  ('rpow',        '#rpow',        'rpow2 announcements + meta.',             'ORIGINALS',   20, 'Hal Finney',    'AI host inspired by Hal Finney. Thoughtful, technical, cypherpunk-historical. Explains primitives carefully.'),
  -- TECH
  ('technology',  '#technology',  'Broad tech talk.',                        'TECH',        10, 'Ada Lovelace',  'AI host inspired by the first programmer. Curious about how things work; loves design diagrams.'),
  ('ai',          '#ai',          'AI, LLMs, agents.',                       'TECH',        20, 'Alan Turing',   'AI host inspired by Turing. Probes assumptions, asks "what would the test be?".'),
  ('programming', '#programming', 'Code, languages, tooling.',               'TECH',        30, 'The Hacker',    'Fictional AI host. Pragmatic, opinionated about tooling, comfortable in any language.'),
  ('web3',        '#web3',        'Decentralized web, identity, infra.',     'TECH',        40, 'The Architect', 'Fictional AI host. Systems-thinker. Skeptical of hype, asks about user value.'),
  -- CRYPTO
  ('bitcoin',     '#bitcoin',     'Bitcoin + Lightning.',                    'CRYPTO',      10, 'Satoshi',       'AI host inspired by the Bitcoin pseudonym. Terse, prefers source over speculation.'),
  ('solana',      '#solana',      'Solana ecosystem.',                       'CRYPTO',      20, 'Anatoly',       'AI host inspired by Anatoly Yakovenko. Performance-minded, fast-takes on validators and tps.'),
  ('ethereum',    '#ethereum',    'Ethereum, EVM, L2s.',                     'CRYPTO',      30, 'The Founder',   'Fictional AI host. Long-arc thinker about Ethereum''s evolution; references EIPs.'),
  ('trading',     '#trading',     'Markets, charts, OTC.',                   'CRYPTO',      40, 'The Trader',    'Fictional AI host. Cool-headed about volatility; talks position-sizing, not predictions.'),
  -- GENERATIONS
  ('gen-z',       '#gen-z',       'Gen Z lounge (~ages 13-28).',             'GENERATIONS', 10, 'Zee',           'Fictional Gen-Z AI host. Internet-fluent, low patience for grandstanding.'),
  ('millennials', '#millennials', 'Millennials lounge (~ages 29-44).',       'GENERATIONS', 20, 'Avery',         'Fictional Millennial AI host. Nostalgic about early-internet culture, dry humor.'),
  ('gen-x',       '#gen-x',       'Gen X lounge (~ages 45-60).',             'GENERATIONS', 30, 'Marlow',        'Fictional Gen-X AI host. Wry, skeptical, references 90s and 00s.'),
  ('boomers',     '#boomers',     'Boomers lounge (~ages 61+).',             'GENERATIONS', 40, 'Hank',          'Fictional Boomer AI host. Generous with context, references the long arc.'),
  -- CULTURE
  ('music',       '#music',       'Music — listening, making, recommending.', 'CULTURE',     10, 'Riff',          'Fictional AI host. Eclectic taste; equally at home with jazz and grime.'),
  ('movies',      '#movies',      'Films & TV.',                             'CULTURE',     20, 'Reel',          'Fictional AI host. Talks craft (cinematography, editing), not box office.'),
  ('gaming',      '#gaming',      'Video games + tabletop.',                 'CULTURE',     30, 'Pixel',          'Fictional AI host. Loves a good systems-design rant; respects retro.'),
  ('books',       '#books',       'Reading list, recommendations.',          'CULTURE',     40, 'Page',           'Fictional AI host. Quiet, careful, asks what you''ve been reading.'),
  ('sports',      '#sports',      'All sports, all leagues.',                'CULTURE',     50, 'Coach',          'Fictional AI host. Stats-curious, hates hot takes.'),
  -- LOUNGE
  ('random',      '#random',      'Anything goes.',                          'LOUNGE',      10, 'The Wanderer',   'Fictional AI host. Wandering curiosity, asks "what''s on your mind?".'),
  ('late-night',  '#late-night',  'Quiet-hours conversation.',               'LOUNGE',      20, 'Owl',            'Fictional AI host. Calm, thoughtful, low-key. Speaks slower.');
```

- [ ] **Step 2: Write the migration test**

`apps/server/tests/chatMigration.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 031_chat.sql', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('seeds 21 rooms across 6 categories with AI host metadata', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const { rows: countRows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM chat_rooms WHERE disabled = false'
    );
    expect(countRows[0]?.n).toBe('21');

    // Spot-check key seed values to catch typos in the SQL.
    const { rows: byCat } = await ctx.pool.query<{ category: string; n: string }>(
      `SELECT category, count(*)::text AS n FROM chat_rooms
       GROUP BY category ORDER BY category ASC`
    );
    expect(byCat).toEqual([
      { category: 'CRYPTO',      n: '4' },
      { category: 'CULTURE',     n: '5' },
      { category: 'GENERATIONS', n: '4' },
      { category: 'LOUNGE',      n: '2' },
      { category: 'ORIGINALS',   n: '2' },
      { category: 'TECH',        n: '4' },
    ]);

    const { rows: hal } = await ctx.pool.query<{ host_name: string; host_persona: string }>(
      `SELECT host_name, host_persona FROM chat_rooms WHERE slug = 'rpow'`
    );
    expect(hal[0]?.host_name).toBe('Hal Finney');
    expect(hal[0]?.host_persona).toMatch(/Hal Finney/);
  });

  it('creates all 8 chat_* tables', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'chat_%'
       ORDER BY table_name ASC`
    );
    expect(rows.map(r => r.table_name)).toEqual([
      'chat_bans',
      'chat_dm_messages',
      'chat_dm_threads',
      'chat_room_messages',
      'chat_room_mutes',
      'chat_rooms',
      'chat_tips',
      'chat_user_blocks',
    ]);
  });

  it('enforces UNIQUE(user_a_email, user_b_email) on chat_dm_threads', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    // Seed two users first (chat_dm_threads has FKs to users(email)). The
    // existing project pattern (see longshotBurn.test.ts) is the minimal
    // `INSERT INTO users(email) VALUES(...)` — other columns have defaults.
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@example.com'), ('b@example.com')`);
    await ctx.pool.query(
      `INSERT INTO chat_dm_threads (user_a_email, user_b_email) VALUES ('a@example.com', 'b@example.com')`
    );
    await expect(
      ctx.pool.query(
        `INSERT INTO chat_dm_threads (user_a_email, user_b_email) VALUES ('a@example.com', 'b@example.com')`
      )
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd apps/server && TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/chatMigration.test.ts`

(The `TEST_DATABASE_URL` env is the same one the rest of the suite uses — see `apps/server/README` or the existing test scripts for the local value.)

Expected: all three tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/migrations/031_chat.sql apps/server/tests/chatMigration.test.ts
git commit -m "feat(chat): migration 030 — chat schema + seed 6 rooms"
```

---

### Task 2: Env var + AppConfig + CORS allowlist

**Files:**
- Modify: `apps/server/src/env.ts:79` (insert after `FREELOTTERY_WEB_ORIGIN` line)
- Modify: `apps/server/src/buildApp.ts:86` (add `chatWebOrigin` to AppConfig)
- Modify: `apps/server/src/buildApp.ts:156` (extend `allowedOrigins`)
- Modify: `apps/server/src/server.ts:129` (wire env → config)
- Modify: `apps/server/tests/helpers.ts:79` (add `chatWebOrigin` to test config)

- [ ] **Step 1: Add the env var schema entry**

In `apps/server/src/env.ts`, find the line:

```ts
  FREELOTTERY_WEB_ORIGIN: z.string().url().default('https://freelottery.rpow2.com'),
```

Add immediately after:

```ts
  CHAT_WEB_ORIGIN: z.string().url().default('https://chat.rpow2.com'),
```

- [ ] **Step 2: Extend AppConfig type**

In `apps/server/src/buildApp.ts`, find the `freelotteryWebOrigin: string;` line (around line 86). Add immediately after:

```ts
  /** ChatRooms web origin (default https://chat.rpow2.com), added to the CORS allowlist. */
  chatWebOrigin: string;
```

- [ ] **Step 3: Append chatWebOrigin to allowedOrigins**

In `apps/server/src/buildApp.ts`, replace the line:

```ts
  const allowedOrigins = [opts.config.webOrigin, opts.config.longShotWebOrigin, opts.config.gladiatorWebOrigin, opts.config.triviaWebOrigin, opts.config.freelotteryWebOrigin];
```

with:

```ts
  const allowedOrigins = [opts.config.webOrigin, opts.config.longShotWebOrigin, opts.config.gladiatorWebOrigin, opts.config.triviaWebOrigin, opts.config.freelotteryWebOrigin, opts.config.chatWebOrigin];
```

- [ ] **Step 4: Wire env → config in server.ts**

In `apps/server/src/server.ts`, find the line:

```ts
    freelotteryWebOrigin: env.FREELOTTERY_WEB_ORIGIN,
```

Add immediately after:

```ts
    chatWebOrigin: env.CHAT_WEB_ORIGIN,
```

- [ ] **Step 5: Add chatWebOrigin to test helper**

In `apps/server/tests/helpers.ts`, find the line:

```ts
    freelotteryWebOrigin: 'http://freelottery.test',
```

Add immediately after:

```ts
    chatWebOrigin: 'http://chat.test',
```

- [ ] **Step 6: Verify typecheck passes**

Run: `cd apps/server && npx tsc -b`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/buildApp.ts apps/server/src/server.ts apps/server/tests/helpers.ts
git commit -m "feat(chat): CHAT_WEB_ORIGIN env var + CORS allowlist + AppConfig"
```

---

### Task 3: chat/store.ts — listRooms()

**Files:**
- Create: `apps/server/src/chat/store.ts`

(No separate store-level test — the integration test in Task 5 exercises this code path through the HTTP route. Matches the freelottery pattern, which puts route + store coverage in `freelotteryRoutes.test.ts`.)

- [ ] **Step 1: Implement listRooms()**

`apps/server/src/chat/store.ts`:

```ts
import type { Pool } from 'pg';

export interface ChatRoom {
  slug: string;
  title: string;
  description: string;
  category: string;
  sortOrder: number;
  hostName: string;
  hostAvatarUrl: string | null;
}

/** Returns enabled rooms grouped by category, ascending by sort_order within category.
 *  `host_persona` is intentionally NOT returned — it's an internal system-prompt blurb,
 *  not user-facing data. `disabled` is filtered out at query time. */
export async function listRooms(pool: Pool): Promise<ChatRoom[]> {
  const { rows } = await pool.query<{
    slug: string;
    title: string;
    description: string;
    category: string;
    sort_order: number;
    host_name: string;
    host_avatar_url: string | null;
  }>(
    `SELECT slug, title, description, category, sort_order, host_name, host_avatar_url
     FROM chat_rooms
     WHERE disabled = false
     ORDER BY category ASC, sort_order ASC, slug ASC`
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    category: r.category,
    sortOrder: r.sort_order,
    hostName: r.host_name,
    hostAvatarUrl: r.host_avatar_url,
  }));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/server && npx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/chat/store.ts
git commit -m "feat(chat): store.listRooms() — Postgres read of enabled rooms"
```

---

### Task 4: chat/routes — GET /api/chat/rooms

**Files:**
- Create: `apps/server/src/routes/chat/index.ts`
- Create: `apps/server/src/routes/chat/rooms.ts`
- Modify: `apps/server/src/buildApp.ts` (import + register)

- [ ] **Step 1: Write the routes/chat/rooms.ts handler**

`apps/server/src/routes/chat/rooms.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { listRooms } from '../../chat/store.js';

export async function roomsRoutes(app: FastifyInstance) {
  app.get('/api/chat/rooms', async () => {
    const rooms = await listRooms(app.pool);
    return { rooms };
  });
}
```

`app.pool` is the `pg.Pool` decorated in `buildApp.ts`. `listRooms` returns a Promise — no manual acquire/release needed; `pool.query` handles that internally.

- [ ] **Step 2: Write the routes index**

`apps/server/src/routes/chat/index.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { roomsRoutes } from './rooms.js';

export async function chatRoutes(app: FastifyInstance) {
  await roomsRoutes(app);
}
```

- [ ] **Step 3: Register chatRoutes in buildApp**

In `apps/server/src/buildApp.ts`, find the import line for freelotteryRoutes (around line 23):

```ts
import { freelotteryRoutes } from './routes/freelottery/index.js';
```

Add immediately after:

```ts
import { chatRoutes } from './routes/chat/index.js';
```

Then find the line where freelotteryRoutes is registered (around line 194):

```ts
  await app.register(freelotteryRoutes);
```

Add immediately after:

```ts
  await app.register(chatRoutes);
```

- [ ] **Step 4: Verify typecheck passes**

Run: `cd apps/server && npx tsc -b`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/chat/index.ts apps/server/src/routes/chat/rooms.ts apps/server/src/buildApp.ts
git commit -m "feat(chat): GET /api/chat/rooms — returns enabled rooms"
```

---

### Task 5: Integration test for GET /api/chat/rooms

**Files:**
- Create: `apps/server/tests/chatRoutes.test.ts`

- [ ] **Step 1: Write the test**

`apps/server/tests/chatRoutes.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('chat routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  describe('GET /api/chat/rooms', () => {
    it('returns the six seeded rooms', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms' });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.rooms.map((x: { slug: string }) => x.slug)).toEqual(
        ['ai', 'bitcoin', 'general', 'rpow', 'solana', 'technology']
      );
      const general = body.rooms.find((x: { slug: string }) => x.slug === 'general');
      expect(general).toEqual({
        slug: 'general',
        title: '#general',
        description: 'Catch-all lounge.',
        disabled: false,
      });
    });

    it('omits disabled rooms', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      await ctx.pool.query(`UPDATE chat_rooms SET disabled = true WHERE slug = $1`, ['solana']);
      const r = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms' });
      expect(r.statusCode).toBe(200);
      expect(r.json().rooms.map((x: { slug: string }) => x.slug)).not.toContain('solana');
    });

    it('does NOT require credentials (public read)', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({
        method: 'GET',
        url: '/api/chat/rooms',
        // intentionally no cookie / no auth header
      });
      expect(r.statusCode).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/server && TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/chatRoutes.test.ts`
Expected: all three tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/chatRoutes.test.ts
git commit -m "test(chat): integration tests for GET /api/chat/rooms"
```

---

### Task 6: Frontend scaffold — apps/web-chat

**Files:**
- Create: `apps/web-chat/package.json`
- Create: `apps/web-chat/tsconfig.json`
- Create: `apps/web-chat/vite.config.ts`
- Create: `apps/web-chat/index.html`
- Create: `apps/web-chat/src/main.tsx`
- Modify: root `package.json` (workspace already includes `apps/*` — no edit needed unless explicit)

- [ ] **Step 1: Create package.json**

`apps/web-chat/package.json`:

```json
{
  "name": "@rpow/web-chat",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5178",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

(Port 5178 because freelottery uses 5177.)

- [ ] **Step 2: Create tsconfig.json**

`apps/web-chat/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false,
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "incremental": true,
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "include": ["src"]
}
```

(Copy-and-tweak from `apps/web-freelottery/tsconfig.json` — if that file's settings differ, prefer the freelottery version verbatim and adjust the include path.)

- [ ] **Step 3: Create vite.config.ts**

`apps/web-chat/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
```

- [ ] **Step 4: Create index.html**

`apps/web-chat/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>RPOW ChatRooms</title>
  <link rel="icon" type="image/svg+xml" href="https://rpow2.com/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/src/styles.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: Create main.tsx**

`apps/web-chat/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('root not found');
createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 6: Install dependencies**

Run from the repo root:

```bash
npm install --workspaces --include-workspace-root
```

Expected: succeeds, no errors. Confirms the new workspace is picked up.

- [ ] **Step 7: Commit**

```bash
git add apps/web-chat/package.json apps/web-chat/tsconfig.json apps/web-chat/vite.config.ts apps/web-chat/index.html apps/web-chat/src/main.tsx package-lock.json
git commit -m "feat(chat): web-chat app scaffold (package, tsconfig, vite, entry)"
```

---

### Task 7: Frontend — styles.css base (retro terminal palette)

**Files:**
- Create: `apps/web-chat/src/styles.css`

- [ ] **Step 1: Copy + trim freelottery styles**

Copy `apps/web-freelottery/src/styles.css` to `apps/web-chat/src/styles.css` as a starting point. We share tokens (palette, mono font, masthead, sections) but won't need entrant-grid / ledger / countdown. **For slice 1, copy the file verbatim** — later slices will trim and add chat-specific selectors.

```bash
cp apps/web-freelottery/src/styles.css apps/web-chat/src/styles.css
```

- [ ] **Step 2: Verify the file is in place**

Run: `head -10 apps/web-chat/src/styles.css`
Expected: starts with `/* RPOW Free Lottery — retro 8-bit terminal aesthetic …` (we'll re-header in slice 2). Keep as-is for now; the tokens and base layout classes are what we need.

- [ ] **Step 3: Commit**

```bash
git add apps/web-chat/src/styles.css
git commit -m "feat(chat): web-chat styles base (retro terminal — copied from freelottery)"
```

---

### Task 8: Frontend — api.ts client

**Files:**
- Create: `apps/web-chat/src/api.ts`

- [ ] **Step 1: Write api.ts**

`apps/web-chat/src/api.ts`:

```ts
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP_${res.status}` }));
    throw Object.assign(new Error(body?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      code: body?.error,
    });
  }
  return res.json() as Promise<T>;
}

export interface ChatRoom {
  slug: string;
  title: string;
  description: string;
  disabled: boolean;
}

export interface RoomsResponse {
  rooms: ChatRoom[];
}

export const api = {
  rooms: () => jsonFetch<RoomsResponse>('/api/chat/rooms'),
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-chat/src/api.ts
git commit -m "feat(chat): web-chat api client — rooms()"
```

---

### Task 9: Frontend — App.tsx (masthead + 3-panel skeleton + sidebar fetches rooms)

**Files:**
- Create: `apps/web-chat/src/App.tsx`
- Create: `apps/web-chat/src/Sidebar.tsx`

- [ ] **Step 1: Write Sidebar.tsx**

`apps/web-chat/src/Sidebar.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ChatRoom } from './api.js';

export function Sidebar() {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { slug } = useParams<{ slug?: string }>();

  useEffect(() => {
    let cancelled = false;
    api.rooms()
      .then(r => { if (!cancelled) setRooms(r.rooms); })
      .catch(e => { if (!cancelled) setError(e.message ?? String(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-section-head">ROOMS</div>
      {error && <div className="error-banner">{error}</div>}
      {!rooms && !error && <div className="chat-sidebar-loading">Loading…</div>}
      {rooms && rooms.map(r => (
        <Link
          key={r.slug}
          className={`chat-sidebar-room${slug === r.slug ? ' active' : ''}`}
          to={`/r/${r.slug}`}
        >
          {r.title}
        </Link>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: Write App.tsx**

`apps/web-chat/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { Sidebar } from './Sidebar.js';

export function App() {
  return (
    <div className="chat-app">
      <header className="masthead">
        <span className="brand">
          <span className="dot" />
          <a className="brand-back" href="https://rpow2.com" title="Back to rpow2.com">
            <span className="brand-back-arrow">←</span> RPOW
          </a>
          <span className="brand-sep"> · CHATROOMS</span>
        </span>
        <span className="meta">PUBLIC · X-VERIFIED POST</span>
      </header>

      <div className="chat-layout">
        <Sidebar />
        <main className="chat-main">
          <Routes>
            <Route path="/" element={<Navigate to="/r/general" replace />} />
            <Route path="/r/:slug" element={<RoomPlaceholder />} />
            <Route path="*" element={<div className="enter-body"><p>Not found.</p></div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function RoomPlaceholder() {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Room <em>placeholder</em></h2>
        <p className="section-sub">Slice 2 wires the SSE stream + scrollback.</p>
      </div>
      <div className="enter-body">
        <p>Pick a room on the left. Live chat lands in slice 2.</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add chat-layout CSS rules**

Append to `apps/web-chat/src/styles.css`:

```css

/* ──────── ChatRooms layout ──────── */
.chat-app {
  max-width: 1200px;
  margin: 24px auto 64px;
  padding: 0 16px;
}
.chat-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 16px;
  margin-top: 16px;
}
.chat-sidebar {
  border: 1px solid var(--accent-dim);
  background: rgba(110,231,183,0.02);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: relative;
}
.chat-sidebar::before, .chat-sidebar::after {
  content: '+';
  position: absolute;
  color: var(--accent);
  font-size: 10px;
  opacity: 0.4;
  line-height: 1;
}
.chat-sidebar::before { top: -6px; left: -1px; }
.chat-sidebar::after  { bottom: -6px; right: -1px; }
.chat-sidebar-section-head {
  color: var(--accent);
  letter-spacing: 0.18em;
  font-size: 10px;
  text-transform: uppercase;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--accent-dim);
  margin-bottom: 6px;
}
.chat-sidebar-room {
  color: var(--fg);
  text-decoration: none;
  padding: 4px 2px;
  font-size: 13px;
  transition: color 120ms;
}
.chat-sidebar-room:hover { color: var(--accent); }
.chat-sidebar-room.active { color: var(--amber); }
.chat-sidebar-loading { color: var(--dim); font-size: 12px; }
.chat-main { min-height: 360px; }

@media (max-width: 720px) {
  .chat-layout { grid-template-columns: 1fr; }
  .chat-sidebar { flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .chat-sidebar-section-head { width: 100%; }
}
```

- [ ] **Step 4: Typecheck + build**

Run from `apps/web-chat`:

```bash
cd apps/web-chat
../../node_modules/.bin/tsc -b
../../node_modules/.bin/vite build
```

Expected: both exit 0; build emits `dist/index.html`, `dist/assets/index-*.css`, `dist/assets/index-*.js`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-chat/src/App.tsx apps/web-chat/src/Sidebar.tsx apps/web-chat/src/styles.css
git commit -m "feat(chat): App.tsx masthead + Sidebar fetches GET /api/chat/rooms"
```

---

### Task 10: Frontend — netlify.toml

**Files:**
- Create: `apps/web-chat/netlify.toml`

- [ ] **Step 1: Create the file**

`apps/web-chat/netlify.toml`:

```toml
# Netlify site config for chat.rpow2.com.
#
# Set "Base directory" in the Netlify dashboard to apps/web-chat/.
# Netlify reads this file from that base dir; `publish` and the working
# dir for `command` are relative to the base. `npm ci --workspaces`
# must run from the workspace root, so the command starts with `cd ../..`
# to get back to the repo root.

[build]
  command = "cd ../.. && npm ci --workspaces --include-workspace-root && npm run build --workspace @rpow/web-chat"
  publish = "dist"

[build.environment]
  NODE_VERSION = "22.20.0"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"

# SPA fallback — every route serves index.html so client routing works.
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

# Production builds use the VPS-hosted API at api.rpow2.com.
# Server-side CORS allows https://chat.rpow2.com via CHAT_WEB_ORIGIN env var
# (wired into Fastify's allowedOrigins list in this slice).
[context.production.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"

[context.deploy-preview.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"
```

- [ ] **Step 2: Commit**

```bash
git add apps/web-chat/netlify.toml
git commit -m "chore(chat): netlify.toml for chat.rpow2.com"
```

---

### Task 11: Add ChatRooms to PROTOCOL APPS + final smoke

**Files:**
- Modify: `apps/web/src/pages/Apps.tsx` (insert after Free Lottery entry, ~line 19)

- [ ] **Step 1: Add the entry**

In `apps/web/src/pages/Apps.tsx`, find the `protocolApps` array entry for `RPOW Free Lottery`. Immediately after it (before `RPOW Long Shot`), add:

```ts
  {
    name: 'RPOW ChatRooms',
    url: 'https://chat.rpow2.com/',
    description: 'AOL-style topic rooms + DMs for X-verified rpow users. Public read, X-verified post.',
    forwardSession: true,
  },
```

- [ ] **Step 2: Typecheck apps/web**

Run:

```bash
cd apps/web
../../node_modules/.bin/tsc -b
```

Expected: exit 0.

- [ ] **Step 3: Run the full server test suite**

Run:

```bash
cd apps/server
TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run
```

Expected: all tests pass — including the two new ones (`chatMigration.test.ts`, `chatRoutes.test.ts`) and the existing suites unchanged. (No separate `chatStore.test.ts` — store coverage comes through the integration test.)

- [ ] **Step 4: Local dev smoke**

In one terminal, boot the server (existing dev script — check `apps/server/package.json` for the right command, typically `npm run dev`).

In another, boot web-chat:

```bash
cd apps/web-chat
../../node_modules/.bin/vite --port 5178
```

Open `http://localhost:5178/` in a browser. Expected:
- Masthead: `● ← RPOW · CHATROOMS    PUBLIC · X-VERIFIED POST`
- Sidebar shows 6 rooms: `#general` (highlighted active because we redirect to `/r/general`), `#ai`, `#bitcoin`, `#rpow`, `#solana`, `#technology`
- Main area shows the "Room placeholder" panel.
- Clicking a different room URL switches the active highlight.
- No console errors.

If the dev server can't reach `api.rpow2.com` locally (CORS / Cloudflare), this smoke test can also be verified by running the apps/server in a second terminal so the API is at `http://localhost:<port>/api/chat/rooms` and `VITE_API_BASE_URL` is unset (defaults to '' → same-origin). Either path is fine.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Apps.tsx
git commit -m "feat(web/apps): list RPOW ChatRooms in PROTOCOL APPS"
```

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Slice 1 Done — What's Live After This Merges

- New migration on the server creates the chat schema and seeds six rooms.
- `GET /api/chat/rooms` returns the six rooms; CORS allows `chat.rpow2.com` (configurable via `CHAT_WEB_ORIGIN`).
- New Netlify site at `chat.rpow2.com` (after Netlify dashboard step — connect the repo, set base dir `apps/web-chat/`) renders a 3-panel skeleton with the room list.
- rpow2.com `/apps` page lists `RPOW ChatRooms` under PROTOCOL APPS.

## What's Not Yet in Slice 1 (deferred to slice 2+)

- `GET /api/chat/stream` SSE endpoint (slice 2)
- `POST /api/chat/messages` and the composer (slice 2)
- Presence + typing (slice 3)
- DMs (slice 4)
- Block / ban / admin killswitch (slice 5)
- Sweeper (slice 5)

## Out-of-band setup

After the commits above merge and deploy:

1. **Netlify dashboard** — create a new site, connect this repo, set "Base directory" to `apps/web-chat/`, and assign the domain `chat.rpow2.com`. (Mirror what was done for `freelottery.rpow2.com`.)
2. **DNS** — ensure `chat.rpow2.com` CNAMEs to the Netlify site.
3. **VPS env** — `CHAT_WEB_ORIGIN` defaults to `https://chat.rpow2.com` so no env file change is strictly required; only set it explicitly if the domain differs.

These are user-driven setup steps, not engineer-driven code steps.
