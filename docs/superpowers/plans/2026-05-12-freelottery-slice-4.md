# Freelottery Slice 4 — Public marketing page + /today and /winners endpoints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slice-1 stubs at `GET /api/freelottery/today` and `GET /api/freelottery/winners` with real, fully-public (no-auth) endpoints — both backed by an in-process TTL cache so traffic from social-media spikes does not hit the DB on every request. Then replace the freelottery web app's placeholder root view with a marketing-grade public landing page that fulfills the spec §6.1 quality bar: hero with countdown, day index, today's entrants gallery, past winners feed (with Solana slot/blockhash receipts and the day's total_tickets next to each winner), explicit empty-day rows, "how it works," and a primary CTA into `/enter`. **This page is the project's marketing front and trust artifact and must be built with the `frontend-design` skill** — see spec §6.1 and the implementation requirement in Task 4 below.

**Architecture:** Two real Fastify handlers replace the slice-1 stubs. Each handler maintains a module-level cache (`let cached: { ts, body } | null = null;`) following the existing `routes/ledger.ts` pattern — 5s TTL for `/today` (so live-entry polling feels fresh), 60s for `/winners` (slower-changing data). No new DB indexes needed; both queries are small (today's entries for one date; all draws for the campaign). The frontend adds `Public.tsx` with motion-bearing hero (countdown ticking each second), a polling `useEffect` against `/today` every 5s, and a static-on-first-load fetch of `/winners`. Routing in `App.tsx` already path-splits between `/` (replaced this slice) and `/enter` (slice 2, untouched).

**Tech Stack:** Postgres 17, Fastify 4, vitest, React 18 + Vite 5. No new npm dependencies.

---

## Spec reference

`docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md` — Slice 4 implements: §5.3 the `/today` and `/winners` route shapes (with `total_tickets` exposed per winner per the recent spec amendment), §6.1 the marketing public page quality bar in full. Slice 4 does **not** implement: §6.3 the news entry (slice 5), §7.2 missed-day staging walkthrough (slice 5), `pending_blockhash` user-visible status (deferred — slice 3 left the column unused).

## File structure

**Create:**

- `apps/server/tests/freelotteryTodayWinners.test.ts` — integration tests for both public endpoints
- `apps/web-freelottery/src/Public.tsx` — marketing-grade landing page
- `apps/web-freelottery/src/Countdown.tsx` — small component for the live countdown (extracted because the App needs the time-tick logic; keeps `Public.tsx` focused on layout)

**Modify:**

- `apps/server/src/routes/freelottery/public.ts` — replace the two 501 stubs with real handlers + in-process caches
- `apps/web-freelottery/src/App.tsx` — render `<Public />` for the `/` route in place of the inline placeholder
- `apps/web-freelottery/src/api.ts` — add `today()` and `winners()` API client functions and the response types
- `apps/web-freelottery/src/styles.css` — add styles needed for the new page (the frontend-design skill may swap or augment the existing styles)

---

## Task 1: Real `GET /api/freelottery/today` handler + tests

**Files:**

- Modify: `apps/server/src/routes/freelottery/public.ts`
- Create: `apps/server/tests/freelotteryTodayWinners.test.ts`

- [ ] **Step 1.1: Write the failing tests for /today**

Create `apps/server/tests/freelotteryTodayWinners.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

const TODAY = new Date().toISOString().slice(0, 10);

/** Compute today's day_utc the same way the server's schedule will: today's
 *  calendar date if before drawHourUtc, otherwise tomorrow. */
function activeDayUtc(drawHourUtc: number): string {
  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10);
  const drawMoment = new Date(`${todayYmd}T${String(drawHourUtc).padStart(2, '0')}:00:00Z`);
  if (now.getTime() < drawMoment.getTime()) return todayYmd;
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

async function seedUserAndEntry(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  xHandle: string,
  dayUtc: string,
  tickets: 1 | 2,
  verifiedAt: string,
) {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(
    `UPDATE users SET x_handle = $1, x_avatar_url = $2 WHERE email = $3`,
    [xHandle, `https://unavatar.io/twitter/${xHandle}`, email],
  );
  await ctx.pool.query(
    `INSERT INTO freelottery_entries
       (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email, dayUtc, xHandle, 'https://twitter.com/x/status/1', tickets, 0, verifiedAt],
  );
}

describe('GET /api/freelottery/today', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('404 when feature is disabled', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('FEATURE_DISABLED');
  });

  it('returns empty entries when no one has entered today', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      day_utc: activeDayUtc(19),
      prize_base_units: '1000000000000',
      entries: [],
      total_entries: 0,
      total_tickets: 0,
    });
    expect(body.draws_at).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\.000Z$/);
  });

  it('returns today entries with handles + avatars + ticket counts, ordered by verified_at ASC', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const dayUtc = activeDayUtc(19);
    await seedUserAndEntry(ctx, 'a@b.com', 'alice', dayUtc, 1, '2026-05-12T10:00:00Z');
    await seedUserAndEntry(ctx, 'c@d.com', 'charlie', dayUtc, 2, '2026-05-12T11:00:00Z');

    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total_entries).toBe(2);
    expect(body.total_tickets).toBe(3);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      x_handle: 'alice',
      x_avatar_url: 'https://unavatar.io/twitter/alice',
      ticket_count: 1,
    });
    expect(body.entries[1]).toMatchObject({
      x_handle: 'charlie',
      x_avatar_url: 'https://unavatar.io/twitter/charlie',
      ticket_count: 2,
    });
  });

  it('excludes entries from other days', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const dayUtc = activeDayUtc(19);
    await seedUserAndEntry(ctx, 'a@b.com', 'alice', dayUtc, 1, '2026-05-12T10:00:00Z');
    // Yesterday's entry — should NOT show up.
    await seedUserAndEntry(ctx, 'old@x.com', 'oldhandle', '2026-04-01', 1, '2026-04-01T10:00:00Z');

    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.json().total_entries).toBe(1);
    expect(r.json().entries[0].x_handle).toBe('alice');
  });
});
```

- [ ] **Step 1.2: Run the test and verify it fails**

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelotteryTodayWinners`
Expected: FAIL — /today still returns the slice-1 501 stub.

- [ ] **Step 1.3: Implement the real `/today` handler**

In `apps/server/src/routes/freelottery/public.ts`, replace the file's contents with:

```typescript
import type { FastifyInstance } from 'fastify';
import { getDayUtc, hasEnded } from '../../freelottery/schedule.js';

const TODAY_CACHE_MS = 5_000;
const WINNERS_CACHE_MS = 60_000;

interface TodayEntry {
  x_handle: string;
  x_avatar_url: string | null;
  ticket_count: 1 | 2;
  verified_at: string;
}

interface TodayBody {
  day_utc: string;
  draws_at: string;
  prize_base_units: string;
  entries: TodayEntry[];
  total_entries: number;
  total_tickets: number;
}

interface WinnerRow {
  day_utc: string;
  status: 'ok' | 'empty';
  x_handle: string | null;
  x_avatar_url: string | null;
  prize_base_units: string;
  total_tickets: number;
  solana_slot: string | null;
  solana_blockhash: string | null;
  mint_credited_at: string | null;
  tweet_url: string | null;
}

function scheduleFor(app: FastifyInstance) {
  return {
    startUtcDate: app.config.freelotteryStartUtcDate,
    totalDays: app.config.freelotteryTotalDays,
    drawHourUtc: app.config.freelotteryDrawHourUtc,
  };
}

function drawMomentFor(dayUtc: string, hourUtc: number): Date {
  return new Date(`${dayUtc}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

export async function publicRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // GET /api/freelottery/today — fully public, no auth
  // ---------------------------------------------------------------------
  let todayCache: { ts: number; body: TodayBody } | null = null;

  app.get('/api/freelottery/today', async (_req, reply) => {
    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    if (hasEnded(new Date(), sched)) {
      return reply.code(404).send({ error: 'CAMPAIGN_ENDED', message: 'campaign has ended' });
    }
    const dayUtc = getDayUtc(new Date(), sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_NOT_STARTED', message: 'campaign has not started yet' });
    }

    if (todayCache && Date.now() - todayCache.ts < TODAY_CACHE_MS && todayCache.body.day_utc === dayUtc) {
      return todayCache.body;
    }

    const { rows } = await app.pool.query<{
      x_handle: string;
      x_avatar_url: string | null;
      ticket_count: number;
      verified_at: Date;
    }>(
      `SELECT e.x_handle, u.x_avatar_url, e.ticket_count, e.verified_at
       FROM freelottery_entries e
       JOIN users u ON u.email = e.account_email
       WHERE e.day_utc = $1
       ORDER BY e.verified_at ASC, e.account_email ASC`,
      [dayUtc],
    );

    const entries: TodayEntry[] = rows.map(r => ({
      x_handle: r.x_handle,
      x_avatar_url: r.x_avatar_url,
      ticket_count: r.ticket_count as 1 | 2,
      verified_at: r.verified_at.toISOString(),
    }));
    const totalTickets = entries.reduce((sum, e) => sum + e.ticket_count, 0);

    const body: TodayBody = {
      day_utc: dayUtc,
      draws_at: drawMomentFor(dayUtc, sched.drawHourUtc).toISOString(),
      prize_base_units: app.config.freelotteryPrizeBaseUnits.toString(),
      entries,
      total_entries: entries.length,
      total_tickets: totalTickets,
    };
    todayCache = { ts: Date.now(), body };
    return body;
  });

  // ---------------------------------------------------------------------
  // GET /api/freelottery/winners — implemented in Task 2
  // ---------------------------------------------------------------------
  app.get('/api/freelottery/winners', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
```

(The `/winners` stub stays for now — Task 2 replaces it.)

- [ ] **Step 1.4: Run the test and verify the /today cases pass**

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelotteryTodayWinners`
Expected: the 4 `/today` tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add apps/server/src/routes/freelottery/public.ts apps/server/tests/freelotteryTodayWinners.test.ts
git commit -m "feat(freelottery): GET /today — public entries list, 5s cache"
```

---

## Task 2: Real `GET /api/freelottery/winners` handler

**Files:**

- Modify: `apps/server/src/routes/freelottery/public.ts`
- Modify: `apps/server/tests/freelotteryTodayWinners.test.ts`

- [ ] **Step 2.1: Add the failing tests for /winners**

Append the following block to `apps/server/tests/freelotteryTodayWinners.test.ts` (after the `describe('GET /api/freelottery/today', ...)` block, before the file ends):

```typescript
async function seedDraw(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  opts: {
    dayUtc: string;
    status: 'ok' | 'empty';
    winnerEmail?: string;
    winnerXHandle?: string;
    totalTickets: number;
    solanaSlot?: number;
    solanaBlockhash?: string;
    tweetUrl?: string;
  },
) {
  if (opts.winnerEmail) {
    await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING`, [opts.winnerEmail]);
    await ctx.pool.query(
      `UPDATE users SET x_handle = $1, x_avatar_url = $2 WHERE email = $3`,
      [opts.winnerXHandle, `https://unavatar.io/twitter/${opts.winnerXHandle}`, opts.winnerEmail],
    );
    if (opts.tweetUrl) {
      await ctx.pool.query(
        `INSERT INTO freelottery_entries
           (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry, verified_at)
         VALUES ($1, $2, $3, $4, 1, 0, now())`,
        [opts.winnerEmail, opts.dayUtc, opts.winnerXHandle, opts.tweetUrl],
      );
    }
  }
  await ctx.pool.query(
    `INSERT INTO freelottery_draws
       (day_utc, drawn_at, total_tickets, prize_base_units, status,
        winner_email, winner_x_handle, solana_slot, solana_blockhash, mint_credited_at)
     VALUES ($1, now(), $2, 1000000000000, $3, $4, $5, $6, $7, ${opts.status === 'ok' ? 'now()' : 'NULL'})`,
    [
      opts.dayUtc,
      opts.totalTickets,
      opts.status,
      opts.winnerEmail ?? null,
      opts.winnerXHandle ?? null,
      opts.solanaSlot ?? null,
      opts.solanaBlockhash ?? null,
    ],
  );
}

describe('GET /api/freelottery/winners', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('404 when feature is disabled', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('FEATURE_DISABLED');
  });

  it('returns [] when no draws have been processed', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ winners: [] });
  });

  it('returns ok draws with winner profile + slot/blockhash receipts', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, {
      dayUtc: '2026-05-10',
      status: 'ok',
      winnerEmail: 'a@b.com',
      winnerXHandle: 'alice',
      totalTickets: 3,
      solanaSlot: 123_456_789,
      solanaBlockhash: 'a'.repeat(64),
      tweetUrl: 'https://twitter.com/alice/status/1',
    });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(200);
    const winners = r.json().winners;
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      day_utc: '2026-05-10',
      status: 'ok',
      x_handle: 'alice',
      x_avatar_url: 'https://unavatar.io/twitter/alice',
      total_tickets: 3,
      prize_base_units: '1000000000000',
      solana_slot: '123456789',
      solana_blockhash: 'a'.repeat(64),
      tweet_url: 'https://twitter.com/alice/status/1',
    });
    expect(winners[0].mint_credited_at).not.toBeNull();
  });

  it('includes empty-day rows with null winner', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, {
      dayUtc: '2026-05-09',
      status: 'empty',
      totalTickets: 0,
    });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    const winners = r.json().winners;
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      day_utc: '2026-05-09',
      status: 'empty',
      x_handle: null,
      x_avatar_url: null,
      total_tickets: 0,
    });
    expect(winners[0].mint_credited_at).toBeNull();
  });

  it('returns most-recent first', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, { dayUtc: '2026-05-08', status: 'empty', totalTickets: 0 });
    await seedDraw(ctx, { dayUtc: '2026-05-10', status: 'empty', totalTickets: 0 });
    await seedDraw(ctx, { dayUtc: '2026-05-09', status: 'empty', totalTickets: 0 });
    const winners = (await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' })).json().winners;
    expect(winners.map((w: any) => w.day_utc)).toEqual(['2026-05-10', '2026-05-09', '2026-05-08']);
  });
});
```

- [ ] **Step 2.2: Run the test and verify the /winners cases fail**

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelotteryTodayWinners`
Expected: the new /winners tests fail (501). /today tests still pass.

- [ ] **Step 2.3: Implement the real `/winners` handler**

In `apps/server/src/routes/freelottery/public.ts`, replace the placeholder `/winners` route at the bottom of `publicRoutes`. Change:

```typescript
  app.get('/api/freelottery/winners', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
```

to:

```typescript
  // ---------------------------------------------------------------------
  // GET /api/freelottery/winners — fully public, no auth
  // ---------------------------------------------------------------------
  let winnersCache: { ts: number; body: { winners: WinnerRow[] } } | null = null;

  app.get('/api/freelottery/winners', async (_req, reply) => {
    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    if (winnersCache && Date.now() - winnersCache.ts < WINNERS_CACHE_MS) {
      return winnersCache.body;
    }

    const { rows } = await app.pool.query<{
      day_utc: string;
      status: 'ok' | 'empty' | 'pending_blockhash';
      winner_x_handle: string | null;
      x_avatar_url: string | null;
      prize_base_units: string;
      total_tickets: number;
      solana_slot: string | null;
      solana_blockhash: string | null;
      mint_credited_at: Date | null;
      tweet_url: string | null;
    }>(
      `SELECT
         d.day_utc::text AS day_utc,
         d.status,
         d.winner_x_handle,
         u.x_avatar_url,
         d.prize_base_units::text AS prize_base_units,
         d.total_tickets,
         d.solana_slot::text AS solana_slot,
         d.solana_blockhash,
         d.mint_credited_at,
         e.tweet_url
       FROM freelottery_draws d
       LEFT JOIN users u ON u.email = d.winner_email
       LEFT JOIN freelottery_entries e
         ON e.account_email = d.winner_email AND e.day_utc = d.day_utc
       WHERE d.status IN ('ok', 'empty')
       ORDER BY d.day_utc DESC`,
    );

    const winners: WinnerRow[] = rows.map(r => ({
      day_utc: r.day_utc,
      status: r.status as 'ok' | 'empty',
      x_handle: r.winner_x_handle,
      x_avatar_url: r.x_avatar_url,
      prize_base_units: r.prize_base_units,
      total_tickets: r.total_tickets,
      solana_slot: r.solana_slot,
      solana_blockhash: r.solana_blockhash,
      mint_credited_at: r.mint_credited_at ? r.mint_credited_at.toISOString() : null,
      tweet_url: r.tweet_url,
    }));
    const body = { winners };
    winnersCache = { ts: Date.now(), body };
    return body;
  });
```

- [ ] **Step 2.4: Run the tests and verify all pass**

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelotteryTodayWinners`
Expected: all `/today` and `/winners` tests green (9 total).

- [ ] **Step 2.5: Drop the obsolete slice-1 stub tests**

Two route stubs (`/today` and `/winners`) in `apps/server/tests/freelotteryRoutes.test.ts` still assert 501. Remove them — the real handlers are now under test in `freelotteryTodayWinners.test.ts`.

Find:

```typescript
  it('GET /api/freelottery/today returns 501 (stub)', async () => { ... });

  it('GET /api/freelottery/winners returns 501 (stub)', async () => { ... });
```

Replace with a single comment line:

```typescript
  // /today and /winners are real handlers as of slice 4 — see freelotteryTodayWinners.test.ts.
```

Verify the remaining `freelotteryRoutes.test.ts` tests still pass:

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelotteryRoutes`
Expected: 2 tests pass (the /status tests; the entry stubs were already removed in slice 2).

- [ ] **Step 2.6: Commit**

```bash
git add apps/server/src/routes/freelottery/public.ts apps/server/tests/freelotteryTodayWinners.test.ts apps/server/tests/freelotteryRoutes.test.ts
git commit -m "feat(freelottery): GET /winners — public results feed, 60s cache"
```

---

## Task 3: API client + types for the public page

**Files:**

- Modify: `apps/web-freelottery/src/api.ts`

No new tests — the API client is exercised by Task 4's manual click-through and the existing build typecheck.

- [ ] **Step 3.1: Add response interfaces + functions**

In `apps/web-freelottery/src/api.ts`, add these interfaces immediately after the existing `XHandleVerifyResponse` interface:

```typescript
export interface TodayEntry {
  x_handle: string;
  x_avatar_url: string | null;
  ticket_count: 1 | 2;
  verified_at: string;
}

export interface TodayResponse {
  day_utc: string;
  draws_at: string;
  prize_base_units: string;
  entries: TodayEntry[];
  total_entries: number;
  total_tickets: number;
}

export interface WinnerRow {
  day_utc: string;
  status: 'ok' | 'empty';
  x_handle: string | null;
  x_avatar_url: string | null;
  prize_base_units: string;
  total_tickets: number;
  solana_slot: string | null;
  solana_blockhash: string | null;
  mint_credited_at: string | null;
  tweet_url: string | null;
}

export interface WinnersResponse {
  winners: WinnerRow[];
}
```

In the existing `export const api = { ... }` block, add two new methods immediately after `verifyEntry`:

```typescript
  today: () => jsonFetch<TodayResponse>('/api/freelottery/today'),
  winners: () => jsonFetch<WinnersResponse>('/api/freelottery/winners'),
```

- [ ] **Step 3.2: Build to confirm**

Run: `npm --workspace apps/web-freelottery run build`
Expected: PASS — `dist/` regenerates cleanly.

- [ ] **Step 3.3: Commit**

```bash
git add apps/web-freelottery/src/api.ts
git commit -m "feat(freelottery): api client — today() + winners()"
```

---

## Task 4: Marketing-grade `Public.tsx` (USE THE `frontend-design` SKILL)

**Files:**

- Create: `apps/web-freelottery/src/Public.tsx`
- Create: `apps/web-freelottery/src/Countdown.tsx`
- Modify: `apps/web-freelottery/src/App.tsx`
- Modify: `apps/web-freelottery/src/styles.css`

### REQUIRED: Use the `frontend-design` skill

The spec §6.1 requires this page to be visually distinctive, marketing-grade, and the trust artifact for the draw. **You MUST invoke the `frontend-design` skill** to produce `Public.tsx`. Do NOT write the page from scratch in default Tailwind/CSS style — this is the project's marketing front and gets the design treatment.

Before writing any code for this task, invoke the skill with the Skill tool: `frontend-design`.

The skill will guide you through generating a distinctive design. The required content surface elements (which you must hand to the skill verbatim as part of the brief) are listed in the data + content section below.

### Required content (give this to the frontend-design skill)

**Hero (above the fold):**
- Prize callout: **1,000 RPOW · daily · 100 days**
- Live countdown to next 19:00 UTC draw (use the `<Countdown />` component you'll create in Step 4.2)
- Day index ("Day 23 / 100") — derived from `/status`
- Primary CTA: "Enter today's free lottery →" (links to `/enter`)
- Live counters: `total_entries` today, `total_tickets` today (from `/today`)

**Below the fold:**
- Today's entrants gallery: each entry shows avatar (`x_avatar_url`) + handle (`x_handle`). Holders with `ticket_count: 2` get a distinctive "+1 RPOW holder" badge. Ordered as returned by API (verified_at ASC). Poll `/today` every 5 seconds to keep it fresh; new rows fade in.
- Past winners feed: each row shows avatar + handle + the day's date + a "Receipt" disclosure that reveals `solana_slot` and `solana_blockhash` (use a `<details>` element or styled equivalent) and a "View tweet" link (`tweet_url`). Each row also displays the day's `total_tickets` (e.g. "Drew from 47 tickets"). Empty-day rows are explicit: "Day N — no entries, prize skipped." Ordered most-recent-first as returned by API.
- "How it works" — 3 short steps. Display the literal tweet template verbatim in a code block:
  > I am entering the daily free lottery for 1000 RPOW. My code is {code}. freelottery.rpow2.com

**Performance and behavior:**
- On mount: fetch `/api/freelottery/status`, `/api/freelottery/today`, `/api/freelottery/winners` in parallel.
- Poll `/api/freelottery/today` every 5 seconds (the server caches at 5s anyway, so this is gentle).
- Re-fetch `/api/freelottery/winners` once per minute. `/api/freelottery/status` once per minute too.
- The countdown ticks every second client-side from a single `Date` (no extra fetches).

**State edge cases:**
- If `/status` returns `enabled: false` → render a "Coming soon" stub instead of the full layout. (Spec §11 step 5 says this happens before launch.)
- If `ended: true` → render a "Final results" header above the past winners feed; suppress the countdown and CTA.

**Style guardrails (the skill should respect these but is free to elaborate):**
- Dark background. The slice-1 placeholder used `#0a0a0a` body with `#f0f0f0` text; the skill may swap to a more distinctive palette but must remain dark/high-contrast.
- Mono accent (the slice already loads `IBM Plex Mono` from Google Fonts via `index.html`). The skill may add a display/serif face for the hero if it pulls one from the same Google Fonts request.
- No more than one external dependency. If the skill wants to add a font, animation lib, or icon set, add it via the existing `<link>` tag in `index.html` — do not introduce a new npm dependency. If the skill insists on a library, surface as DONE_WITH_CONCERNS.

### Steps

- [ ] **Step 4.1: Invoke the `frontend-design` skill**

Use the Skill tool with name `frontend-design` and a brief that includes:
- All "Required content" elements above, verbatim
- The "Style guardrails" above, verbatim
- The data shape returned by each endpoint (paste from `apps/web-freelottery/src/api.ts` after Task 3 — `TodayResponse`, `WinnersResponse`, `FreelotteryStatus`)
- The output target: a React component `Public.tsx` and a separate `Countdown.tsx`, both in `apps/web-freelottery/src/`. CSS may be added to `styles.css` or to component-local files; do not require any new npm dependency. The design must compile to a working React app via the existing Vite setup.

Follow the skill's guidance. When it's done, you should have polished `Public.tsx`, `Countdown.tsx`, and styles ready to drop in.

- [ ] **Step 4.2: Write `Countdown.tsx`**

The frontend-design skill may have produced this; if it did, use the skill's output. If it expects you to write it, here's a minimal correct implementation:

```typescript
import { useEffect, useState } from 'react';

export function Countdown({ to }: { to: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!to) return <span>—</span>;
  const target = new Date(to).getTime();
  const ms = Math.max(0, target - now);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const fmt = (n: number) => String(n).padStart(2, '0');
  return <span className="countdown">{fmt(hours)}:{fmt(minutes)}:{fmt(seconds)}</span>;
}
```

The frontend-design skill is welcome to swap this for a more visually distinctive treatment. The interface (`{ to: string | null }`) must remain stable so `Public.tsx` imports work.

- [ ] **Step 4.3: Write `Public.tsx`**

The output of the frontend-design skill in Step 4.1. Use the skill's code verbatim. Confirm:
- All required content elements are present (hero, today's entrants, past winners feed, how it works)
- Polling intervals match (`/today` every 5s, `/winners` and `/status` every 60s)
- Empty-day handling (no entries → friendly empty state; ended → final-results header)
- Imports work: `import { Countdown } from './Countdown.js'`, `import { api, FreelotteryStatus, TodayResponse, WinnersResponse } from './api.js'`

- [ ] **Step 4.4: Update `App.tsx` to render `<Public />`**

Replace `apps/web-freelottery/src/App.tsx` with:

```typescript
import { Enter } from './Enter.js';
import { Public } from './Public.js';

export function App() {
  const path = window.location.pathname;
  if (path === '/enter') return <Enter />;
  return <Public />;
}
```

- [ ] **Step 4.5: Build and click-through**

Run: `npm --workspace apps/web-freelottery run build`
Expected: PASS — no TypeScript errors, no missing imports.

Optional: `npm --workspace apps/web-freelottery run dev` and visit `http://localhost:5177` to verify the page renders. Hit `/api/freelottery/status` with a configured start date in the dev environment to see live data.

- [ ] **Step 4.6: Commit**

```bash
git add apps/web-freelottery/src
git commit -m "feat(freelottery): marketing-grade public landing page"
```

---

## Task 5: Final smoke — full freelottery test suite + full build

This task has no new files; it's a verification gate.

- [ ] **Step 5.1: Run the full freelottery test suite**

Run: `TEST_DATABASE_URL='postgres://xavior:xavior@localhost:5432/xavior' npm --workspace apps/server test -- freelottery`
Expected: 9 test files green (slice 1-3's 8 + slice 4's 1 new = 9). Total ~72 tests passing.

- [ ] **Step 5.2: Run the full monorepo build**

Run: `cd /Users/fredkrueger/rpow && npm run build`
Expected: server compiles, all 5 web apps build to `dist/`, no errors.

- [ ] **Step 5.3: (No commit — pure verification.)**

---

## What slice 4 does NOT do (intentional)

- No news entry — slice 5 (rollout).
- No top-banner copy — general behavior outside this slice's scope.
- No `pending_blockhash` user-visible status — the WHERE clause in `/winners` excludes that status entirely, deferring the question. The column stays unused from slice 3.
- No allowlist enforcement — `freelotteryAllowedEmails` still effectively `'*'` (enforced by /entry routes from slice 2, untouched here).
- No frontend snapshot tests — slice 5 (if we choose to add them).

## Slice 4 acceptance

The slice is done when:

1. All 5 tasks above are committed.
2. `freelottery` test suite is green across all 9 test files.
3. `npm run build` succeeds.
4. `GET /api/freelottery/today` and `/winners` against a dev server with `FREELOTTERY_START_UTC_DATE` set return the expected shapes for empty, partial, and post-draw states.
5. `freelottery.rpow2.com/` renders the marketing-grade Public page (in dev: `http://localhost:5177/`), with countdown ticking, today's entrants gallery polling every 5s, and the past winners feed showing receipts and per-day total_tickets.
