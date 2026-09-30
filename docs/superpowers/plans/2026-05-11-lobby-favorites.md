# Lobby UX Upgrade — Favorites + Sort + Search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three lobby UX features applied to BOTH gladiator and trivia:
1. **Sort:** most-recent (default) or highest-bet.
2. **Search:** filter by X handle substring (case-insensitive).
3. **Favorites:** star/unstar players; persistent server-side; a compact "Favorites in arena" sub-panel highlights which favorites are currently in the lobby.

**Architecture:** New `user_favorites` table (per-user). Three new REST endpoints under `/api/favorites/*` (shared between both apps). Both lobby endpoints (`/api/gladiator/lobby`, `/api/trivia/lobby`) gain an `is_favorite: boolean` field per row via a LEFT JOIN against `user_favorites` (using the caller's session cookie; falls back to false when unauthenticated). Frontend sort/search are pure-client (no extra round-trips). Both SPAs (`apps/web-gladiator/`, `apps/web-trivia/`) get the same UI delta.

**Tech Stack:** Postgres 17 migration, Fastify 4 routes, zod, vitest. React 18 + TypeScript on the frontend. No new dependencies.

---

## File Structure

**Backend:**
- Create: `apps/server/migrations/017_user_favorites.sql`
- Create: `apps/server/src/routes/favorites.ts` (new route module)
- Modify: `apps/server/src/routes/gladiator/lobby.ts` (add `is_favorite` join)
- Modify: `apps/server/src/routes/trivia/lobby.ts` (add `is_favorite` join)
- Modify: `apps/server/src/buildApp.ts` (register `favoritesRoutes`)
- Tests: `apps/server/tests/favorites.test.ts` + amend `gladiatorLobby.test.ts` + `triviaLobby.test.ts`

**Frontend (each repeated for both gladiator and trivia):**
- Modify: `apps/web-{gladiator,trivia}/src/api.ts` — add `LobbyEntry.is_favorite`, `fetchFavorites`, `addFavorite`, `removeFavorite`
- Modify: `apps/web-{gladiator,trivia}/src/App.tsx` — sort selector, search input, favorites star per row, `FavoritesInArenaPanel`
- Modify: `apps/web-{gladiator,trivia}/src/styles.css` — small block for star button + sort/search controls

---

## Conventions

- Email handling for favorites: store the favorited user's email as the relationship key (matches existing `users.email` PK). The frontend never sees the favoritee's email — only the X handle (UI never reveals emails of others).
- Cap favorites per user at 100. Returns 409 `FAVORITE_LIMIT_REACHED` on overflow.
- Self-favorite: rejected with 400 `SELF_FAVORITE` (you can't favorite yourself).
- Auth: all three favorites endpoints require a session (401 otherwise). Lobby endpoints stay public; spectators see `is_favorite: false` for every row.
- Frontend sort/search are pure-client over the existing lobby response (no new query params on the API).
- Empty-star → click → filled-star is optimistic UI; reverts on server error.

---

## Task 1: Migration 017 — user_favorites table

**Files:**
- Create: `apps/server/migrations/017_user_favorites.sql`
- Test: amend `apps/server/tests/migrations.test.ts` (or create `apps/server/tests/userFavoritesMigration.test.ts` if a per-migration pattern is in use)

- [ ] **Step 1: Write the migration**

```sql
-- Per-user favorites. The user identified by account_email keeps a set
-- of favorite_email values. Each pair is unique. Cascade-deletes if
-- either user is ever removed (defensive — accounts aren't deleted today
-- but the constraint is free).

CREATE TABLE user_favorites (
  account_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  favorite_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_email, favorite_email),
  CHECK (account_email <> favorite_email)
);

-- Fast lookup for "who has favorited me?" (not currently surfaced in UI
-- but cheap to add now and useful for future "follow" notifications).
CREATE INDEX user_favorites_favoritee_idx ON user_favorites(favorite_email);

-- Fast lookup for "give me X's favorites" — the dominant query pattern.
CREATE INDEX user_favorites_owner_idx ON user_favorites(account_email);
```

- [ ] **Step 2: Write failing test**

Create `apps/server/tests/userFavoritesMigration.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 017_user_favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('creates the user_favorites table with the expected columns and PK', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const colsRes = await ctx.pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'user_favorites'
       ORDER BY ordinal_position`,
    );
    const names = colsRes.rows.map((r: any) => r.column_name);
    expect(names).toEqual(['account_email', 'favorite_email', 'created_at']);
  });

  it('enforces the (account_email, favorite_email) primary key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com'), ('b@x.com')`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    await expect(
      ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`),
    ).rejects.toThrow();
  });

  it('rejects self-favorite at the CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await expect(
      ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','a@x.com')`),
    ).rejects.toThrow();
  });

  it('cascade-deletes when either user is removed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com'), ('b@x.com')`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    await ctx.pool.query(`DELETE FROM users WHERE email = 'b@x.com'`);
    const r = await ctx.pool.query(`SELECT count(*)::int AS n FROM user_favorites`);
    expect(r.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 3: Verify failing**

```
cd apps/server && TEST_DATABASE_URL='postgres://localhost/rpow_test' npx vitest run tests/userFavoritesMigration.test.ts
```

Expected: FAIL on "table does not exist" (or similar).

- [ ] **Step 4: Run the migration runner**

The migrations directory is read by `apps/server/src/db.ts`'s `runMigrations`. With the SQL file in place, re-running tests will execute it. Re-run:

```
cd apps/server && TEST_DATABASE_URL='postgres://localhost/rpow_test' npx vitest run tests/userFavoritesMigration.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/migrations/017_user_favorites.sql apps/server/tests/userFavoritesMigration.test.ts
git commit -m "feat(favorites): migration 017 — user_favorites table"
```

---

## Task 2: Backend — /api/favorites endpoints

**Files:**
- Create: `apps/server/src/routes/favorites.ts`
- Modify: `apps/server/src/buildApp.ts` (register the route module)
- Test: `apps/server/tests/favorites.test.ts`

Three endpoints, all session-required:
- `GET /api/favorites` → `{ favorites: [{ favorite_email, x_handle, x_avatar_url, created_at }] }`
- `POST /api/favorites` body `{ favorite_email: string }` → 200 `{ created_at }` or 409 if already favorited or 400 SELF_FAVORITE or 404 USER_NOT_FOUND or 409 FAVORITE_LIMIT_REACHED
- `DELETE /api/favorites/:email` → 200 `{ ok: true }` or 404 if not present

The DELETE path takes the favoritee's email URL-encoded in the path. This is a minor leak of one email per favorite, but it's symmetric with the favorite-creating client which already knows the email it sent.

Wait — actually the frontend should NOT pass emails around. Refactor: instead of `favorite_email` in the body and `:email` in the path, the frontend identifies a target user via their `x_handle`. The server looks up the email from x_handle. That keeps emails server-side.

Revised endpoint shapes:
- `POST /api/favorites` body `{ x_handle: string }` — server resolves to email, inserts.
- `DELETE /api/favorites/:x_handle` — server resolves, deletes.

GET stays the same — returns only X handles in the response (no emails).

- [ ] **Step 1: Write failing tests**

Create `apps/server/tests/favorites.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}

describe('POST /api/favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { 'content-type': 'application/json' },
      payload: { x_handle: 'alice' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 BAD_REQUEST on invalid body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { not_a_handle: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 USER_NOT_FOUND when x_handle does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'nobody' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('USER_NOT_FOUND');
  });

  it('400 SELF_FAVORITE when favoriting yourself', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await markVerified(ctx.pool, 'a@x.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'alice' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_FAVORITE');
  });

  it('200 happy path — inserts and is idempotent', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'bob' },
    });
    expect(r1.statusCode).toBe(200);
    expect(typeof r1.json().created_at).toBe('string');

    // Idempotent second insert — also 200 with the original created_at preserved.
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'bob' },
    });
    expect(r2.statusCode).toBe(200);

    const rows = await ctx.pool.query(
      `SELECT account_email, favorite_email FROM user_favorites WHERE account_email = 'a@x.com'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ account_email: 'a@x.com', favorite_email: 'b@x.com' });
  });

  it('409 FAVORITE_LIMIT_REACHED after 100 favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    // Pre-seed 100 favorites the fast way.
    for (let i = 0; i < 100; i++) {
      await ctx.pool.query(
        `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
        [`u${i}@x.com`, `u${i}`],
      );
      await ctx.pool.query(
        `INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com', $1)`,
        [`u${i}@x.com`],
      );
    }
    // Try to add a 101st.
    await ctx.pool.query(
      `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ('overflow@x.com','overflow', now())`,
    );
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'overflow' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('FAVORITE_LIMIT_REACHED');
  });
});

describe('GET /api/favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/favorites' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the caller’s favorites with x_handle + avatar', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    await ctx.pool.query(`UPDATE users SET x_avatar_url = 'https://x.com/avatar/bob.jpg' WHERE email = 'b@x.com'`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/favorites',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.favorites).toHaveLength(1);
    expect(body.favorites[0]).toMatchObject({
      x_handle: 'bob',
      x_avatar_url: 'https://x.com/avatar/bob.jpg',
    });
    expect(typeof body.favorites[0].created_at).toBe('string');
    expect(body.favorites[0].favorite_email).toBeUndefined(); // emails never leaked
  });

  it('returns empty list if no favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().favorites).toEqual([]);
  });
});

describe('DELETE /api/favorites/:x_handle', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/favorites/bob' });
    expect(res.statusCode).toBe(401);
  });

  it('200 happy path removes the favorite', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/favorites/bob',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const rows = await ctx.pool.query(`SELECT * FROM user_favorites WHERE account_email = 'a@x.com'`);
    expect(rows.rowCount).toBe(0);
  });

  it('200 ok even if the favorite did not exist (idempotent delete)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/favorites/bob',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify fail**

```
cd apps/server && TEST_DATABASE_URL='postgres://localhost/rpow_test' npx vitest run tests/favorites.test.ts
```

Expected: FAIL (route doesn't exist).

- [ ] **Step 3: Implement the route**

Create `apps/server/src/routes/favorites.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';

const FAVORITE_LIMIT = 100;

const PostBody = z.object({
  x_handle: z.string().min(1).max(64),
});

export async function favoritesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------
  // GET /api/favorites — caller's favorites (no emails in response)
  // ---------------------------------------------------------------
  app.get('/api/favorites', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const res = await app.pool.query<{
      x_handle: string | null;
      x_avatar_url: string | null;
      created_at: Date;
    }>(
      `SELECT u.x_handle, u.x_avatar_url, uf.created_at
       FROM user_favorites uf
       JOIN users u ON u.email = uf.favorite_email
       WHERE uf.account_email = $1
       ORDER BY uf.created_at DESC`,
      [s.email],
    );

    const favorites = res.rows
      .filter(r => r.x_handle !== null)
      .map(r => ({
        x_handle: r.x_handle!,
        x_avatar_url: r.x_avatar_url ?? null,
        created_at: r.created_at.toISOString(),
      }));

    return reply.code(200).send({ favorites });
  });

  // ---------------------------------------------------------------
  // POST /api/favorites { x_handle }
  // ---------------------------------------------------------------
  app.post('/api/favorites', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const handle = parsed.data.x_handle;

    // Resolve handle → email. The lookup is case-insensitive because the existing
    // verification flow stores handles as-typed; we don't want a UX mismatch.
    const userRes = await app.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE lower(x_handle) = lower($1) AND x_handle_verified_at IS NOT NULL`,
      [handle],
    );
    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'no verified user with that handle' });
    }
    const favoriteeEmail = userRes.rows[0].email;

    if (favoriteeEmail === s.email) {
      return reply.code(400).send({ error: 'SELF_FAVORITE', message: 'you cannot favorite yourself' });
    }

    // Cap check — count first.
    const countRes = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_favorites WHERE account_email = $1`,
      [s.email],
    );
    if (countRes.rows[0].n >= FAVORITE_LIMIT) {
      // Allow re-adding an already-favorited one (idempotent) — only block if it's NEW.
      const existsRes = await app.pool.query(
        `SELECT 1 FROM user_favorites WHERE account_email = $1 AND favorite_email = $2`,
        [s.email, favoriteeEmail],
      );
      if (existsRes.rowCount === 0) {
        return reply.code(409).send({ error: 'FAVORITE_LIMIT_REACHED', message: `favorites limit is ${FAVORITE_LIMIT}` });
      }
    }

    const insertRes = await app.pool.query<{ created_at: Date }>(
      `INSERT INTO user_favorites(account_email, favorite_email)
       VALUES ($1, $2)
       ON CONFLICT (account_email, favorite_email) DO UPDATE SET created_at = user_favorites.created_at
       RETURNING created_at`,
      [s.email, favoriteeEmail],
    );

    return reply.code(200).send({ created_at: insertRes.rows[0].created_at.toISOString() });
  });

  // ---------------------------------------------------------------
  // DELETE /api/favorites/:x_handle
  // ---------------------------------------------------------------
  app.delete('/api/favorites/:x_handle', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { x_handle: handle } = req.params as { x_handle: string };

    // Resolve handle → email. If the user doesn't exist, this is still a no-op success.
    const userRes = await app.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE lower(x_handle) = lower($1)`,
      [handle],
    );
    if (userRes.rows.length === 0) {
      return reply.code(200).send({ ok: true });
    }
    const favoriteeEmail = userRes.rows[0].email;

    await app.pool.query(
      `DELETE FROM user_favorites WHERE account_email = $1 AND favorite_email = $2`,
      [s.email, favoriteeEmail],
    );

    return reply.code(200).send({ ok: true });
  });
}
```

- [ ] **Step 4: Register in buildApp.ts**

In `apps/server/src/buildApp.ts`, import `favoritesRoutes` and register it alongside the existing route modules. The other routes are registered with `await app.register(longshotRoutes)` etc. — add `await app.register(favoritesRoutes);` in the same spot.

(Read the file first to confirm the registration pattern, then add the line in the right place.)

- [ ] **Step 5: Run tests — verify pass**

```
cd apps/server && TEST_DATABASE_URL='postgres://localhost/rpow_test' npx vitest run tests/favorites.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/favorites.ts apps/server/src/buildApp.ts apps/server/tests/favorites.test.ts
git commit -m "feat(favorites): GET/POST/DELETE /api/favorites endpoints"
```

---

## Task 3: Extend lobby endpoints with is_favorite

**Files:**
- Modify: `apps/server/src/routes/gladiator/lobby.ts`
- Modify: `apps/server/src/routes/trivia/lobby.ts`
- Amend: `apps/server/tests/gladiatorLobby.test.ts`
- Amend: `apps/server/tests/triviaLobby.test.ts`

Both lobby endpoints gain an `is_favorite: boolean` field on each row. When the request has no session, every row gets `is_favorite: false`. When the request has a session, the SQL does `LEFT JOIN user_favorites uf ON uf.account_email = $1 AND uf.favorite_email = <session_owner.email>`, and `is_favorite` is `uf.account_email IS NOT NULL`.

- [ ] **Step 1: Write failing tests**

Amend `apps/server/tests/gladiatorLobby.test.ts` — add a new `describe('is_favorite field', …)` block:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(`UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`, [handle, email]);
}

describe('GET /api/gladiator/lobby — is_favorite', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  async function seedGladiator(ctx: any, email: string, handle: string) {
    await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
    await markVerified(ctx.pool, email, handle);
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
       VALUES($1, $2, 10, 30, 30, 'OPEN', now())`,
      [id, email],
    );
  }

  it('is_favorite is false for spectators on every row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedGladiator(ctx, 'a@x.com', 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
    const g = res.json().gladiators[0];
    expect(g.is_favorite).toBe(false);
  });

  it('is_favorite reflects the caller’s user_favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedGladiator(ctx, 'a@x.com', 'alice');
    await seedGladiator(ctx, 'b@x.com', 'bob');
    const cookie = await login(ctx, 'me@x.com');
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('me@x.com','a@x.com')`);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby', headers: { cookie } });
    const byHandle: Record<string, any> = {};
    for (const g of res.json().gladiators) byHandle[g.x_handle] = g;
    expect(byHandle.alice.is_favorite).toBe(true);
    expect(byHandle.bob.is_favorite).toBe(false);
  });
});
```

And similarly amend `apps/server/tests/triviaLobby.test.ts` with the same shape (substituting `trivia_sessions`, `/api/trivia/lobby`, `players` instead of `gladiators`).

- [ ] **Step 2: Update the gladiator lobby SQL**

In `apps/server/src/routes/gladiator/lobby.ts`, change the handler to read the session and pass the email to the SQL. Final form:

```ts
import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

export async function lobbyRoutes(app: FastifyInstance) {
  app.get('/api/gladiator/lobby', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    const callerEmail = s?.email ?? null;

    const res = await app.pool.query<{
      session_id: string;
      account_email: string;
      x_handle: string;
      x_avatar_url: string | null;
      bet_base_units: string;
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      opened_at: Date;
      last_flip_at: Date | null;
      is_favorite: boolean;
    }>(
      `SELECT
         gs.id AS session_id,
         gs.account_email,
         u.x_handle,
         u.x_avatar_url,
         gs.bet_base_units::text,
         gs.bankroll_remaining_base_units::text,
         gs.flips_won,
         gs.flips_lost,
         gs.opened_at,
         gs.last_flip_at,
         (uf.account_email IS NOT NULL) AS is_favorite
       FROM gladiator_sessions gs
       JOIN users u ON u.email = gs.account_email
       LEFT JOIN user_favorites uf
         ON uf.account_email = $1::text AND uf.favorite_email = gs.account_email
       WHERE gs.status = 'OPEN'
       ORDER BY gs.opened_at DESC`,
      [callerEmail],
    );

    const gladiators = res.rows.map((row) => ({
      session_id: row.session_id,
      account_email: row.account_email,
      x_handle: row.x_handle,
      x_avatar_url: row.x_avatar_url ?? null,
      bet_base_units: row.bet_base_units,
      bankroll_remaining_base_units: row.bankroll_remaining_base_units,
      flips_won: row.flips_won,
      flips_lost: row.flips_lost,
      opened_at: row.opened_at.toISOString(),
      last_flip_at: row.last_flip_at ? row.last_flip_at.toISOString() : null,
      is_favorite: row.is_favorite,
    }));

    return reply.code(200).send({ gladiators });
  });
}
```

When `callerEmail` is null, the LEFT JOIN's condition `uf.account_email = null::text` matches no rows (NULLs aren't equal), so `is_favorite` is `false` for everyone — exactly the spectator behavior we want.

- [ ] **Step 3: Update the trivia lobby SQL**

Same change in `apps/server/src/routes/trivia/lobby.ts`. Replace the existing query with:

```ts
import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

export async function lobbyRoutes(app: FastifyInstance) {
  app.get('/api/trivia/lobby', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    const callerEmail = s?.email ?? null;

    const res = await app.pool.query<{
      session_id: string;
      account_email: string;
      x_handle: string;
      x_avatar_url: string | null;
      bet_base_units: string;
      bankroll_remaining_base_units: string;
      matches_won: number;
      matches_lost: number;
      opened_at: Date;
      last_match_at: Date | null;
      is_favorite: boolean;
    }>(
      `SELECT
         ts.id AS session_id,
         ts.account_email,
         u.x_handle,
         u.x_avatar_url,
         ts.bet_base_units::text,
         ts.bankroll_remaining_base_units::text,
         ts.matches_won,
         ts.matches_lost,
         ts.opened_at,
         ts.last_match_at,
         (uf.account_email IS NOT NULL) AS is_favorite
       FROM trivia_sessions ts
       JOIN users u ON u.email = ts.account_email
       LEFT JOIN user_favorites uf
         ON uf.account_email = $1::text AND uf.favorite_email = ts.account_email
       WHERE ts.status = 'OPEN'
       ORDER BY ts.opened_at DESC`,
      [callerEmail],
    );

    const players = res.rows.map((row) => ({
      session_id: row.session_id,
      account_email: row.account_email,
      x_handle: row.x_handle,
      x_avatar_url: row.x_avatar_url ?? null,
      bet_base_units: row.bet_base_units,
      bankroll_remaining_base_units: row.bankroll_remaining_base_units,
      matches_won: row.matches_won,
      matches_lost: row.matches_lost,
      opened_at: row.opened_at.toISOString(),
      last_match_at: row.last_match_at ? row.last_match_at.toISOString() : null,
      is_favorite: row.is_favorite,
    }));

    return reply.code(200).send({ players });
  });
}
```

- [ ] **Step 4: Run tests**

```
cd apps/server && TEST_DATABASE_URL='postgres://localhost/rpow_test' npx vitest run tests/gladiatorLobby.test.ts tests/triviaLobby.test.ts tests/favorites.test.ts tests/userFavoritesMigration.test.ts
```

Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/gladiator/lobby.ts apps/server/src/routes/trivia/lobby.ts apps/server/tests/gladiatorLobby.test.ts apps/server/tests/triviaLobby.test.ts
git commit -m "feat(favorites): lobby endpoints expose is_favorite per row"
```

---

## Task 4: web-gladiator frontend — sort + search + favorites

**Files:**
- Modify: `apps/web-gladiator/src/api.ts` (add `is_favorite` field + 3 favorites fns)
- Modify: `apps/web-gladiator/src/App.tsx` (sort/search controls + star button + FavoritesInArenaPanel)
- Modify: `apps/web-gladiator/src/styles.css` (small style block)

### Sort + search controls (above the OPEN GLADIATORS list)

```
[ Search: ___________ ]   Sort by: ( recent ▼ )
```

Sort options: `recent` (default — `opened_at DESC` from the server, no client sort needed) and `highest-bet` (client-side sort by `BigInt(bet_base_units)` descending).

Search: lowercase substring match against `x_handle`.

### Star button per row

Empty ☆ → not a favorite. Click adds. Filled ★ → favorite. Click removes. Optimistic UI: update local state immediately, then call API; on error revert and surface the error.

### FavoritesInArenaPanel

Above OPEN GLADIATORS. Appears only when:
- The user is verified (has favorites stored)
- AT LEAST ONE favorite is currently in the lobby

Shows compact rows: `@alice — bet 0.1 RPOW — [ FLIP! ]`. Same FLIP button wiring as the main lobby. The set is derived: `lobby.filter(g => g.is_favorite)`.

### Step 1: Update `api.ts`

In `apps/web-gladiator/src/api.ts`:

1. Add `is_favorite: boolean` to the `LobbyEntry` interface (near `flips_lost`).
2. Add at the bottom (above `formatRpow`):

```ts
export interface FavoriteRow {
  x_handle: string;
  x_avatar_url: string | null;
  created_at: string;
}

export async function fetchFavorites(): Promise<FavoriteRow[]> {
  const res = await fetch(`${API_BASE}/api/favorites`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.favorites ?? [];
}

export async function addFavorite(xHandle: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/favorites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x_handle: xHandle }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `favorite ${res.status}`);
  }
}

export async function removeFavorite(xHandle: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/favorites/${encodeURIComponent(xHandle)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `unfavorite ${res.status}`);
  }
}
```

### Step 2: Update `App.tsx`

Add state for sort + search:

```tsx
const [sortMode, setSortMode] = useState<'recent' | 'highest-bet'>('recent');
const [search, setSearch] = useState('');
```

Compute the filtered/sorted lobby:

```tsx
const visibleLobby = (() => {
  let rows = [...lobby];
  if (search.trim()) {
    const q = search.toLowerCase();
    rows = rows.filter(r => r.x_handle.toLowerCase().includes(q));
  }
  if (sortMode === 'highest-bet') {
    rows.sort((a, b) => {
      const ab = BigInt(a.bet_base_units);
      const bb = BigInt(b.bet_base_units);
      if (ab > bb) return -1;
      if (ab < bb) return 1;
      return 0;
    });
  }
  return rows;
})();

const favoritesInArena = lobby.filter(g => g.is_favorite);
```

Add a header above the OPEN GLADIATORS panel showing the controls. If `favoritesInArena.length > 0`, render a `FAVORITES IN ARENA` panel above OPEN GLADIATORS.

Star button + handler:

```tsx
async function toggleFavorite(entry: LobbyEntry) {
  // Optimistic flip — server call follows.
  const next = lobby.map(g =>
    g.session_id === entry.session_id ? { ...g, is_favorite: !g.is_favorite } : g
  );
  setLobby(next);
  try {
    if (entry.is_favorite) {
      await removeFavorite(entry.x_handle);
    } else {
      await addFavorite(entry.x_handle);
    }
  } catch (e: any) {
    // Revert on failure.
    setLobby(lobby);
    console.error('favorite toggle failed:', e.message);
  }
}
```

The lobby row JSX changes from:

```tsx
<div key={g.session_id} className="lobby-row">
  <div>
    <XLink handle={g.x_handle} />
    {' — '}
    bankroll …
  </div>
  {…}
</div>
```

to (preserving the existing structure, with a star button added next to the handle, and FLIP button on the right):

```tsx
<div key={g.session_id} className="lobby-row">
  <div>
    {authState === 'verified' && !isOwnSession && (
      <button
        className={`fav-star ${g.is_favorite ? 'on' : ''}`}
        title={g.is_favorite ? 'unfavorite' : 'favorite'}
        onClick={() => toggleFavorite(g)}
      >{g.is_favorite ? '★' : '☆'}</button>
    )}
    <XLink handle={g.x_handle} />
    {' — '}
    bankroll {formatRpow(g.bankroll_remaining_base_units)} RPOW
    {' — '}
    bet {formatRpow(g.bet_base_units)} RPOW
    {' — '}
    W/L {g.flips_won}/{g.flips_lost}
  </div>
  {authState === 'verified' && !isOwnSession && (
    <button onClick={() => setFlipTarget(g)} style={{ marginLeft: 8 }}>
      [ FLIP! ]
    </button>
  )}
  {isOwnSession && (
    <span style={{ marginLeft: 8, color: '#666', fontSize: 11 }}>(you)</span>
  )}
</div>
```

The OPEN GLADIATORS heading becomes a control bar:

```tsx
<div className="panel-inner">
  <div className="lobby-controls">
    <h2 style={{ marginBottom: 0 }}>OPEN GLADIATORS ({visibleLobby.length}{search ? `/${lobby.length}` : ''})</h2>
    <div className="lobby-filter">
      <input
        type="text"
        placeholder="search @handle..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="lobby-search"
      />
      <select
        value={sortMode}
        onChange={e => setSortMode(e.target.value as 'recent' | 'highest-bet')}
        className="lobby-sort"
      >
        <option value="recent">recent</option>
        <option value="highest-bet">highest bet</option>
      </select>
    </div>
  </div>
  {visibleLobby.length === 0
    ? <p style={{ color: '#666' }}>{lobby.length === 0 ? 'nobody in the arena' : 'no matches'}</p>
    : visibleLobby.map(g => { /* … row rendering above … */ })
  }
</div>
```

Add the `FAVORITES IN ARENA` panel ABOVE `OPEN GLADIATORS` (inside the same `<section className="main-col lobby-panel">`), only when authState === 'verified' AND favoritesInArena.length > 0:

```tsx
{authState === 'verified' && favoritesInArena.length > 0 && (
  <div className="panel-inner favorites-panel">
    <h2>FAVORITES IN ARENA ({favoritesInArena.length})</h2>
    {favoritesInArena.map(g => (
      <div key={g.session_id} className="lobby-row">
        <div>
          <XLink handle={g.x_handle} />
          {' — '}
          bet {formatRpow(g.bet_base_units)} RPOW
        </div>
        {me && g.account_email !== me.email && (
          <button onClick={() => setFlipTarget(g)} style={{ marginLeft: 8 }}>
            [ FLIP! ]
          </button>
        )}
      </div>
    ))}
  </div>
)}
```

### Step 3: Update styles.css

Append to `apps/web-gladiator/src/styles.css`:

```css
/* === Lobby controls (sort + search) === */

.lobby-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.lobby-filter {
  display: flex;
  gap: 8px;
  align-items: center;
}

.lobby-search {
  background: rgba(110, 231, 183, 0.02);
  border: 1px solid var(--accent-dim);
  color: var(--fg);
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  width: 180px;
}
.lobby-search:focus { outline: none; border-color: var(--accent); }

.lobby-sort {
  background: rgba(110, 231, 183, 0.02);
  border: 1px solid var(--accent-dim);
  color: var(--fg);
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
}

/* === Favorite star button === */

.fav-star {
  background: transparent;
  border: none;
  color: var(--dim);
  font-size: 14px;
  cursor: pointer;
  padding: 0 6px 0 0;
  transition: color 100ms;
}
.fav-star:hover { color: var(--accent); }
.fav-star.on { color: var(--amber); }

/* === Favorites in arena panel === */

.favorites-panel {
  border-color: var(--amber);
  background: rgba(251, 191, 36, 0.02);
  margin-bottom: 16px;
}
.favorites-panel h2 { color: var(--amber); }
```

### Step 4: Build verify

```
cd /Users/fredkrueger/rpow && npm run build --workspace @rpow/web-gladiator
```

Expected: clean build.

### Step 5: Commit

```bash
git add apps/web-gladiator/src/api.ts apps/web-gladiator/src/App.tsx apps/web-gladiator/src/styles.css
git commit -m "feat(gladiator-web): sort + search + favorites in lobby"
```

---

## Task 5: web-trivia frontend — sort + search + favorites

**Files:**
- Modify: `apps/web-trivia/src/api.ts`
- Modify: `apps/web-trivia/src/App.tsx`
- Modify: `apps/web-trivia/src/styles.css`

Mirror Task 4 exactly. The differences from web-gladiator:
- `LobbyEntry` has `matches_won`/`matches_lost` (not flips_won/lost)
- Lobby section heading is `OPEN PLAYERS` (not `OPEN GLADIATORS`)
- Challenge button is `[ CHALLENGE ]` (not `[ FLIP! ]`)
- The Match modal target setter is `setChallengeTarget` (not `setFlipTarget`)
- The favorites-panel button also says `[ CHALLENGE ]`

Otherwise the components, state shape, sort/search logic, star button, and FavoritesInArena panel are identical.

### Step 1: Mirror api.ts changes from Task 4

Add `is_favorite: boolean` to `LobbyEntry`. Append `FavoriteRow`, `fetchFavorites`, `addFavorite`, `removeFavorite` (verbatim copy from Task 4's api.ts addition).

### Step 2: Update App.tsx with the sort/search/star/FavoritesInArena patterns

Apply the same patterns from Task 4 to `apps/web-trivia/src/App.tsx`, substituting:
- `setFlipTarget` → `setChallengeTarget`
- `OPEN GLADIATORS` → `OPEN PLAYERS`
- `[ FLIP! ]` → `[ CHALLENGE ]`
- `g.flips_won/g.flips_lost` → `g.matches_won/g.matches_lost`

### Step 3: Append the same CSS block to styles.css

Same `.lobby-controls`, `.lobby-search`, `.lobby-sort`, `.fav-star`, `.favorites-panel` rules as Task 4.

### Step 4: Build verify

```
cd /Users/fredkrueger/rpow && npm run build --workspace @rpow/web-trivia
```

### Step 5: Commit

```bash
git add apps/web-trivia/src/api.ts apps/web-trivia/src/App.tsx apps/web-trivia/src/styles.css
git commit -m "feat(trivia-web): sort + search + favorites in lobby"
```

---

## Task 6: Deploy backend + frontend

**Steps:**

- [ ] **Step 1: Deploy backend (migration runs automatically on startup)**

```bash
ssh ubuntu@15.204.254.192 'sudo -u rpow bash -c "cd /opt/rpow/repo && git pull origin main && npm ci --workspaces --include-workspace-root --ignore-scripts && npm run build --workspace @rpow/shared && npm run build --workspace @rpow/server" && sudo systemctl restart rpow-server rpow-auth && echo restarted'
```

The migration `017_user_favorites.sql` runs as part of the boot sequence.

- [ ] **Step 2: Verify favorites endpoint**

```bash
curl -sS -o /dev/null -w 'HTTP:%{http_code} t:%{time_total}\n' --max-time 10 'https://api.rpow2.com/api/favorites'
```

Expected: HTTP 401 (no session) — confirms the route is registered.

- [ ] **Step 3: Verify lobby is_favorite field**

```bash
curl -sS 'https://api.rpow2.com/api/gladiator/lobby' | head -c 300
curl -sS 'https://api.rpow2.com/api/trivia/lobby' | head -c 300
```

Expected: each row has an `"is_favorite": false` field (spectator, so always false).

- [ ] **Step 4: Deploy frontend builds**

```bash
cd /Users/fredkrueger/rpow/apps/web-gladiator
netlify deploy --prod --dir=/Users/fredkrueger/rpow/apps/web-gladiator/dist --site=$(python3 -c "import json; d=json.load(open('/Users/fredkrueger/Library/Preferences/netlify/config.json')); print('see gladiator site')") --no-build
```

Look up the gladiator site_id via `netlify api listSites | grep gladiator` first. Same playbook for trivia (site `103af028-8fae-45b7-bf33-7bf8cfc475f0`).

Both SPAs already build automatically; just deploy the dist/ from the local builds.

- [ ] **Step 5: Smoke test in browser**

Visit both `https://gladiator.rpow2.com/` and `https://trivia.rpow2.com/`. Spectator view should render the same as before — no favorites panel, plain lobby rows, no star buttons. (Stars only appear for verified users.)

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Per-user favorites table | Task 1 |
| GET/POST/DELETE /api/favorites endpoints | Task 2 |
| `is_favorite` per lobby row | Task 3 |
| Sort by most-recent / highest-bet | Task 4 + 5 (frontend) |
| Search by handle substring | Task 4 + 5 |
| Star/unstar in lobby | Task 4 + 5 |
| Favorites-in-arena sub-panel | Task 4 + 5 |
| Persistence (server-side) | Task 1 |
| 100-favorite cap | Task 2 |
| Self-favorite rejection | Tasks 1 + 2 (DB + route) |
| Emails never exposed to client | Task 2 (handles only in/out) |

**No placeholders.** All code is complete inline.

**Type consistency:** `LobbyEntry.is_favorite`, `FavoriteRow`, `fetchFavorites`, `addFavorite`, `removeFavorite` names match across api.ts and App.tsx in BOTH web apps.

**Slice scope:** Both backend + both frontends in one PR. The backend changes are additive (no migration of existing rows, no API contract breaks); the lobby endpoint adds a new field but keeps all existing fields. Frontends are additive (new controls, new panel, new buttons).
