# Freelottery Slice 1 — Foundation: migration, env, schedule module, route stubs, web app scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation for the Daily Free Lottery: Postgres migration `029_freelottery.sql` (3 tables), new `FREELOTTERY_*` env vars threaded into `AppConfig`, a pure `schedule.ts` module that computes day index / next-draw timestamp / start+end gates, route skeleton with 501 stubs for every `/api/freelottery/*` endpoint, one working `GET /api/freelottery/status` route that uses the schedule module, and a new `apps/web-freelottery/` Vite app that builds and renders a placeholder. Subsequent slices add entry flow, draw runner, and public page UI.

**Architecture:** New migration creates `freelottery_codes`, `freelottery_entries`, `freelottery_draws`. All `/api/freelottery/*` Fastify routes are registered up-front; everything except `/status` returns 501. The `schedule.ts` module is pure (takes a `Date` and config, returns derived values) so it's trivially unit-testable and reused later by the draw runner. CORS allowlist gains a fourth origin (`freelotteryWebOrigin`). The new web app is a near-verbatim copy of `apps/web-trivia` scaffolding with a different port (5177), package name (`@rpow/web-freelottery`), and netlify config pointed at `freelottery.rpow2.com`.

**Tech Stack:** Postgres 17, Fastify 4 + zod, vitest, React 18 + Vite 5. No new npm dependencies.

---

## Spec reference

`docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md` — Slice 1 implements: §2 decisions for env vars, §3 directory layout (server side + new web app), §4 schema, §5.3's `GET /status` endpoint, §8 configuration. Slice 1 does **not** implement: §5.1 entry flow, §5.2 draw, §6 public page UI, §7 error handling beyond stub responses, §9 integration tests. Those land in later slices.

## File structure

**Create:**

- `apps/server/migrations/029_freelottery.sql` — three tables per spec §4
- `apps/server/src/freelottery/schedule.ts` — pure functions: `getDayUtc`, `dayIndex`, `nextDrawAt`, `hasStarted`, `hasEnded`
- `apps/server/src/routes/freelottery/index.ts` — registers all sub-route modules
- `apps/server/src/routes/freelottery/entry.ts` — 501 stubs for `POST /api/freelottery/entry/start` and `POST /api/freelottery/entry/verify`
- `apps/server/src/routes/freelottery/public.ts` — 501 stubs for `GET /api/freelottery/today` and `GET /api/freelottery/winners`
- `apps/server/src/routes/freelottery/status.ts` — real `GET /api/freelottery/status` using `schedule.ts`
- `apps/server/tests/freelotteryMigration.test.ts` — table existence, columns, CHECK constraints
- `apps/server/tests/freelotterySchedule.test.ts` — pure unit tests for `schedule.ts`
- `apps/server/tests/freelotteryRoutes.test.ts` — stubs return 501; `/status` returns expected shape
- `apps/web-freelottery/package.json`
- `apps/web-freelottery/vite.config.ts`
- `apps/web-freelottery/tsconfig.json`
- `apps/web-freelottery/index.html`
- `apps/web-freelottery/netlify.toml`
- `apps/web-freelottery/src/main.tsx`
- `apps/web-freelottery/src/App.tsx`
- `apps/web-freelottery/src/styles.css`

**Modify:**

- `apps/server/src/env.ts` — add 6 new `FREELOTTERY_*` Zod fields
- `apps/server/tests/env.test.ts` — assert defaults for new env vars
- `apps/server/src/buildApp.ts` — extend `AppConfig` with `freelottery*` fields, add `freelotteryWebOrigin` to CORS allowlist, register `freelotteryRoutes`
- `apps/server/src/server.ts` — thread new env values into the `config` object
- `apps/server/tests/helpers.ts` — add the new config fields to the default test config
- `package.json` (repo root) — add `dev:freelottery` script; add `web-freelottery` to root `build` and `test` scripts

---

## Task 1: Migration `029_freelottery.sql` + tests

**Files:**

- Create: `apps/server/migrations/029_freelottery.sql`
- Create: `apps/server/tests/freelotteryMigration.test.ts`

- [ ] **Step 1.1: Write the failing migration test**

Create `apps/server/tests/freelotteryMigration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function tableExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

async function columnType(pool: any, table: string, column: string): Promise<string | null> {
  const { rows } = await pool.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0]?.data_type ?? null;
}

async function indexExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

describe('migration 029_freelottery', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('creates freelottery_codes with the expected PK', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_codes')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_codes', 'account_email')).toBe('text');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'day_utc')).toBe('date');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'code')).toBe('text');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'expires_at')).toBe('timestamp with time zone');
  });

  it('creates freelottery_entries with ticket_count CHECK in (1,2)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_entries')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_entries', 'ticket_count')).toBe('smallint');
    // Inserting a row with ticket_count = 3 must fail the CHECK.
    await ctx.pool.query(`INSERT INTO users (email) VALUES ('a@test') ON CONFLICT DO NOTHING`);
    await expect(
      ctx.pool.query(
        `INSERT INTO freelottery_entries
           (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
         VALUES ('a@test','2026-05-13','x','u',3,0)`,
      ),
    ).rejects.toThrow(/ticket_count/);
  });

  it('creates freelottery_entries_day_idx index', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await indexExists(ctx.pool, 'freelottery_entries_day_idx')).toBe(true);
  });

  it('creates freelottery_draws with status default = ok and prize_base_units NOT NULL', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_draws')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_draws', 'prize_base_units')).toBe('bigint');
    expect(await columnType(ctx.pool, 'freelottery_draws', 'status')).toBe('text');
    await ctx.pool.query(
      `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units)
       VALUES ('2026-05-13', now(), 0, 1000000000000)`,
    );
    const { rows } = await ctx.pool.query(`SELECT status FROM freelottery_draws WHERE day_utc='2026-05-13'`);
    expect(rows[0].status).toBe('ok');
  });
});
```

- [ ] **Step 1.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotteryMigration`
Expected: FAIL (relation `freelottery_codes` does not exist) — every test case fails because the migration doesn't exist yet.

- [ ] **Step 1.3: Write the migration**

Create `apps/server/migrations/029_freelottery.sql`:

```sql
-- 029_freelottery.sql
-- RPOW Daily Free Lottery: 100-day campaign, 1,000 RPOW/day from unmined
-- supply, X-tweet verification per day. See
-- docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md.

-- 1. Per-(user, day) verification codes. Mirrors gladiator's
-- x_verification_codes but day-scoped. Deleted after successful verify;
-- otherwise expires at the day's 19:00 UTC boundary.
CREATE TABLE freelottery_codes (
  account_email TEXT NOT NULL REFERENCES users(email),
  day_utc       DATE NOT NULL,
  code          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_email, day_utc)
);

-- 2. Verified daily entries. One row per (user, day_utc). ticket_count is
-- 1 (base) or 2 (holder of >= 1 RPOW at verify time). balance snapshot is
-- recorded so the tier decision is auditable later.
CREATE TABLE freelottery_entries (
  account_email                TEXT NOT NULL REFERENCES users(email),
  day_utc                      DATE NOT NULL,
  x_handle                     TEXT NOT NULL,
  tweet_url                    TEXT NOT NULL,
  ticket_count                 SMALLINT NOT NULL CHECK (ticket_count IN (1, 2)),
  balance_base_units_at_entry  BIGINT NOT NULL,
  verified_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_email, day_utc)
);
CREATE INDEX freelottery_entries_day_idx ON freelottery_entries (day_utc, verified_at);

-- 3. One row per drawn day, even empty days. Winner cols are NULL when
-- status='empty'. blockhash + slot record the Solana entropy used for the
-- draw so anyone can re-verify. mint_credited_at and on_chain_signature
-- are filled in by the credit + bridge steps.
CREATE TABLE freelottery_draws (
  day_utc              DATE PRIMARY KEY,
  drawn_at             TIMESTAMPTZ NOT NULL,
  solana_slot          BIGINT,
  solana_blockhash     TEXT,
  total_tickets        INT NOT NULL,
  winner_email         TEXT REFERENCES users(email),
  winner_x_handle      TEXT,
  prize_base_units     BIGINT NOT NULL,
  mint_credited_at     TIMESTAMPTZ,
  on_chain_signature   TEXT,
  status               TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','empty','pending_blockhash'))
);
```

- [ ] **Step 1.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotteryMigration`
Expected: PASS — all 4 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/server/migrations/029_freelottery.sql apps/server/tests/freelotteryMigration.test.ts
git commit -m "feat(freelottery): migration 029 — codes, entries, draws tables"
```

---

## Task 2: New `FREELOTTERY_*` env vars + tests

**Files:**

- Modify: `apps/server/src/env.ts`
- Modify: `apps/server/tests/env.test.ts`

- [ ] **Step 2.1: Write the failing env test**

Add this block to `apps/server/tests/env.test.ts` inside the existing `describe('parseEnv', ...)`:

```typescript
  it('parses FREELOTTERY_* with expected defaults', () => {
    const env = parseEnv({ ...BASE_ENV });
    expect(env.FREELOTTERY_START_UTC_DATE).toBeUndefined();
    expect(env.FREELOTTERY_TOTAL_DAYS).toBe(100);
    expect(env.FREELOTTERY_PRIZE_BASE_UNITS).toBe(1_000_000_000_000);
    expect(env.FREELOTTERY_DRAW_HOUR_UTC).toBe(19);
    expect(env.FREELOTTERY_ALLOWED_EMAILS).toBe('*');
    expect(env.FREELOTTERY_WEB_ORIGIN).toBe('https://freelottery.rpow2.com');
  });

  it('accepts FREELOTTERY_START_UTC_DATE in YYYY-MM-DD form', () => {
    const env = parseEnv({ ...BASE_ENV, FREELOTTERY_START_UTC_DATE: '2026-05-13' });
    expect(env.FREELOTTERY_START_UTC_DATE).toBe('2026-05-13');
  });

  it('rejects FREELOTTERY_START_UTC_DATE in wrong format', () => {
    expect(() => parseEnv({ ...BASE_ENV, FREELOTTERY_START_UTC_DATE: 'May 13' })).toThrow(/FREELOTTERY_START_UTC_DATE/);
  });

  it('rejects FREELOTTERY_DRAW_HOUR_UTC out of range', () => {
    expect(() => parseEnv({ ...BASE_ENV, FREELOTTERY_DRAW_HOUR_UTC: '24' })).toThrow(/FREELOTTERY_DRAW_HOUR_UTC/);
  });
```

- [ ] **Step 2.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- env.test`
Expected: FAIL — `env.FREELOTTERY_TOTAL_DAYS` is `undefined`, all 4 new cases fail.

- [ ] **Step 2.3: Add the Zod fields**

In `apps/server/src/env.ts`, add this block immediately after the `USDC_MINT_ADDRESS` field (around line 72), inside the `z.object({ ... })` call:

```typescript
  // Freelottery — daily free lottery. Disabled when FREELOTTERY_START_UTC_DATE is unset.
  FREELOTTERY_START_UTC_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  FREELOTTERY_TOTAL_DAYS: z.coerce.number().int().positive().default(100),
  FREELOTTERY_PRIZE_BASE_UNITS: z.coerce.number().int().positive().default(1_000_000_000_000),
  FREELOTTERY_DRAW_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(19),
  FREELOTTERY_ALLOWED_EMAILS: z.string().default('*'),
  FREELOTTERY_WEB_ORIGIN: z.string().url().default('https://freelottery.rpow2.com'),
```

- [ ] **Step 2.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- env.test`
Expected: PASS — all 4 new cases plus existing cases green.

- [ ] **Step 2.5: Commit**

```bash
git add apps/server/src/env.ts apps/server/tests/env.test.ts
git commit -m "feat(freelottery): FREELOTTERY_* env vars"
```

---

## Task 3: `AppConfig` extension + buildApp wiring (CORS + routes registered)

**Files:**

- Modify: `apps/server/src/buildApp.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/tests/helpers.ts`

This task has no dedicated tests of its own — it's pure wiring. Tasks 4 and 5 cover the schedule module and route stubs that prove the wiring works.

- [ ] **Step 3.1: Add `AppConfig` fields**

In `apps/server/src/buildApp.ts`, add this block immediately after the `triviaWebOrigin: string;` field (around line 73):

```typescript
  /** Freelottery campaign start (YYYY-MM-DD). When unset, all freelottery routes return 404. */
  freelotteryStartUtcDate?: string;
  /** Total days of the campaign (default 100). */
  freelotteryTotalDays: number;
  /** Daily prize in base units (default 10^12 = 1,000 RPOW). */
  freelotteryPrizeBaseUnits: bigint;
  /** UTC hour at which the daily entry window closes and draw runs (default 19). */
  freelotteryDrawHourUtc: number;
  /** CSV allowlist; '*' opens to all signed-in users. */
  freelotteryAllowedEmails: string;
  /** CORS origin for the Freelottery frontend. */
  freelotteryWebOrigin: string;
```

- [ ] **Step 3.2: Add the new origin to the CORS allowlist**

In `apps/server/src/buildApp.ts`, change the `allowedOrigins` array (around line 141):

Find:
```typescript
  const allowedOrigins = [opts.config.webOrigin, opts.config.longShotWebOrigin, opts.config.gladiatorWebOrigin, opts.config.triviaWebOrigin];
```

Replace with:
```typescript
  const allowedOrigins = [opts.config.webOrigin, opts.config.longShotWebOrigin, opts.config.gladiatorWebOrigin, opts.config.triviaWebOrigin, opts.config.freelotteryWebOrigin];
```

- [ ] **Step 3.3: Register the freelottery routes**

In `apps/server/src/buildApp.ts`, immediately after the `triviaRoutes` import (line 22), add:

```typescript
import { freelotteryRoutes } from './routes/freelottery/index.js';
```

And in the body where routes are registered (right after `await app.register(triviaRoutes);` around line 178), add:

```typescript
  await app.register(freelotteryRoutes);
```

- [ ] **Step 3.4: Thread env values in `server.ts`**

In `apps/server/src/server.ts`, immediately after the `triviaWebOrigin: env.TRIVIA_WEB_ORIGIN,` line (around line 122), add:

```typescript
    freelotteryStartUtcDate: env.FREELOTTERY_START_UTC_DATE,
    freelotteryTotalDays: env.FREELOTTERY_TOTAL_DAYS,
    freelotteryPrizeBaseUnits: BigInt(env.FREELOTTERY_PRIZE_BASE_UNITS),
    freelotteryDrawHourUtc: env.FREELOTTERY_DRAW_HOUR_UTC,
    freelotteryAllowedEmails: env.FREELOTTERY_ALLOWED_EMAILS,
    freelotteryWebOrigin: env.FREELOTTERY_WEB_ORIGIN,
```

- [ ] **Step 3.5: Update the default test config**

In `apps/server/tests/helpers.ts`, add to the `config` object (immediately after `triviaWebOrigin: 'http://trivia.test',` around line 72):

```typescript
    freelotteryStartUtcDate: undefined,
    freelotteryTotalDays: 100,
    freelotteryPrizeBaseUnits: 1_000_000_000_000n,
    freelotteryDrawHourUtc: 19,
    freelotteryAllowedEmails: '*',
    freelotteryWebOrigin: 'http://freelottery.test',
```

- [ ] **Step 3.6: Run the whole server test suite to confirm wiring compiles**

Run: `npm --workspace apps/server test`
Expected: existing tests still pass; the new `freelotteryRoutes` import in `buildApp.ts` will cause a compile error until Task 4 creates the module. That's fine — Task 4 ships with this so they can be reviewed together. Verify by running the typecheck:

Run: `cd apps/server && npx tsc -b --noEmit`
Expected: ONE error about the missing `./routes/freelottery/index.js`. No other errors.

(If you prefer green CI between tasks, you may temporarily comment out the import and `register` line and reinstate them at the end of Task 4. Either order is acceptable.)

- [ ] **Step 3.7: Commit**

```bash
git add apps/server/src/buildApp.ts apps/server/src/server.ts apps/server/tests/helpers.ts
git commit -m "feat(freelottery): wire FREELOTTERY_* into AppConfig + CORS"
```

---

## Task 4: `schedule.ts` pure module + unit tests

**Files:**

- Create: `apps/server/src/freelottery/schedule.ts`
- Create: `apps/server/tests/freelotterySchedule.test.ts`

- [ ] **Step 4.1: Write the failing unit tests**

Create `apps/server/tests/freelotterySchedule.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  getDayUtc,
  dayIndex,
  nextDrawAt,
  hasStarted,
  hasEnded,
} from '../src/freelottery/schedule.js';

const CFG = {
  startUtcDate: '2026-05-13',
  totalDays: 100,
  drawHourUtc: 19,
};

describe('freelottery schedule', () => {
  describe('getDayUtc', () => {
    it('returns the upcoming draw date when before 19:00 UTC', () => {
      // 2026-05-13 17:00 UTC → day_utc still 2026-05-13 (entry window closes today at 19:00).
      expect(getDayUtc(new Date('2026-05-13T17:00:00Z'), CFG)).toBe('2026-05-13');
    });

    it('returns the next date when at-or-after 19:00 UTC', () => {
      // 2026-05-13 19:00 UTC → window for 2026-05-13 closed; next day_utc is 2026-05-14.
      expect(getDayUtc(new Date('2026-05-13T19:00:00Z'), CFG)).toBe('2026-05-14');
    });

    it('returns null before the campaign starts', () => {
      expect(getDayUtc(new Date('2026-05-12T17:00:00Z'), CFG)).toBeNull();
    });

    it('returns null after the campaign ends', () => {
      // Day 100 closes at 2026-08-20 19:00. After that, no more days.
      expect(getDayUtc(new Date('2026-08-20T20:00:00Z'), CFG)).toBeNull();
    });
  });

  describe('dayIndex', () => {
    it('is 1 on the first day', () => {
      expect(dayIndex('2026-05-13', CFG)).toBe(1);
    });

    it('is 100 on the last day', () => {
      expect(dayIndex('2026-08-20', CFG)).toBe(100);
    });

    it('returns null outside the campaign window', () => {
      expect(dayIndex('2026-05-12', CFG)).toBeNull();
      expect(dayIndex('2026-08-21', CFG)).toBeNull();
    });
  });

  describe('nextDrawAt', () => {
    it('returns today 19:00 UTC when before 19:00', () => {
      expect(nextDrawAt(new Date('2026-05-13T17:00:00Z'), CFG)?.toISOString())
        .toBe('2026-05-13T19:00:00.000Z');
    });

    it('returns tomorrow 19:00 UTC when at/after 19:00', () => {
      expect(nextDrawAt(new Date('2026-05-13T19:00:00Z'), CFG)?.toISOString())
        .toBe('2026-05-14T19:00:00.000Z');
    });

    it('returns null after the campaign ends', () => {
      expect(nextDrawAt(new Date('2026-08-21T00:00:00Z'), CFG)).toBeNull();
    });
  });

  describe('hasStarted / hasEnded', () => {
    // Per spec §8 and §11 step 5, entries are accepted from feature-enable time
    // through the day-100 close. So hasStarted is true whenever the campaign is
    // configured and not yet ended — even before the day-1 draw.
    it('hasStarted is true once enabled, even before day-1 close', () => {
      expect(hasStarted(new Date('2026-05-12T00:00:00Z'), CFG)).toBe(true);
    });

    it('hasEnded is true at the exact moment day-100 closes', () => {
      expect(hasEnded(new Date('2026-08-20T19:00:00Z'), CFG)).toBe(true);
      expect(hasEnded(new Date('2026-08-20T18:59:59Z'), CFG)).toBe(false);
    });
  });

  describe('disabled config', () => {
    it('every function returns null/false when startUtcDate is undefined', () => {
      const off = { startUtcDate: undefined, totalDays: 100, drawHourUtc: 19 };
      expect(getDayUtc(new Date(), off)).toBeNull();
      expect(nextDrawAt(new Date(), off)).toBeNull();
      expect(dayIndex('2026-05-13', off)).toBeNull();
      expect(hasStarted(new Date(), off)).toBe(false);
      expect(hasEnded(new Date(), off)).toBe(true);
    });
  });
});
```

- [ ] **Step 4.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotterySchedule`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4.3: Implement `schedule.ts`**

Create `apps/server/src/freelottery/schedule.ts`:

```typescript
export interface ScheduleConfig {
  /** YYYY-MM-DD; the draw date of day 1. Undefined → feature disabled. */
  startUtcDate: string | undefined;
  /** Length of campaign in days. */
  totalDays: number;
  /** UTC hour at which entry closes and the draw runs (0–23). */
  drawHourUtc: number;
}

function parseDateUtc(yyyyMmDd: string): Date {
  // Treat as UTC midnight; we only care about the date, not the time.
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function drawMomentFor(dateYmd: string, cfg: ScheduleConfig): Date {
  return new Date(`${dateYmd}T${String(cfg.drawHourUtc).padStart(2, '0')}:00:00Z`);
}

function endMoment(cfg: ScheduleConfig): Date | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const last = new Date(start);
  last.setUTCDate(last.getUTCDate() + cfg.totalDays - 1);
  return drawMomentFor(formatDateUtc(last), cfg);
}

/**
 * The `day_utc` for the entry window containing `now` — i.e. the date whose
 * draw at `drawHourUtc:00 UTC` closes the window. Returns null when before
 * the campaign starts or after it ends.
 */
export function getDayUtc(now: Date, cfg: ScheduleConfig): string | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const end = endMoment(cfg);
  if (!end) return null;
  if (now.getTime() >= end.getTime()) return null;

  // The day whose draw is the first one at-or-after `now`.
  const todayYmd = formatDateUtc(now);
  const todayDraw = drawMomentFor(todayYmd, cfg);
  let candidate: string;
  if (now.getTime() < todayDraw.getTime()) {
    candidate = todayYmd;
  } else {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    candidate = formatDateUtc(tomorrow);
  }

  // Clamp to the campaign window.
  if (parseDateUtc(candidate).getTime() < start.getTime()) return null;
  return candidate;
}

/** Returns the 1-based day index for a given `day_utc`, or null if outside the campaign. */
export function dayIndex(dayUtc: string, cfg: ScheduleConfig): number | null {
  if (!cfg.startUtcDate) return null;
  const start = parseDateUtc(cfg.startUtcDate);
  const d = parseDateUtc(dayUtc);
  const idx = Math.floor((d.getTime() - start.getTime()) / 86_400_000) + 1;
  if (idx < 1 || idx > cfg.totalDays) return null;
  return idx;
}

export function nextDrawAt(now: Date, cfg: ScheduleConfig): Date | null {
  const ymd = getDayUtc(now, cfg);
  if (!ymd) return null;
  return drawMomentFor(ymd, cfg);
}

export function hasStarted(_now: Date, cfg: ScheduleConfig): boolean {
  // The campaign is "started" iff it is enabled and not yet ended. Entry is
  // open from feature-enable time through day-100 close.
  if (!cfg.startUtcDate) return false;
  return !hasEnded(_now, cfg);
}

export function hasEnded(now: Date, cfg: ScheduleConfig): boolean {
  const end = endMoment(cfg);
  if (!end) return true;
  return now.getTime() >= end.getTime();
}
```

- [ ] **Step 4.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotterySchedule`
Expected: PASS — all cases green.

- [ ] **Step 4.5: Commit**

```bash
git add apps/server/src/freelottery/schedule.ts apps/server/tests/freelotterySchedule.test.ts
git commit -m "feat(freelottery): pure schedule module (day_utc, dayIndex, nextDrawAt)"
```

---

## Task 5: Route stubs + working `/status` endpoint

**Files:**

- Create: `apps/server/src/routes/freelottery/index.ts`
- Create: `apps/server/src/routes/freelottery/entry.ts`
- Create: `apps/server/src/routes/freelottery/public.ts`
- Create: `apps/server/src/routes/freelottery/status.ts`
- Create: `apps/server/tests/freelotteryRoutes.test.ts`

- [ ] **Step 5.1: Write the failing route tests**

Create `apps/server/tests/freelotteryRoutes.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('freelottery routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('POST /api/freelottery/entry/start returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/freelottery/entry/start' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('POST /api/freelottery/entry/verify returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/freelottery/entry/verify' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('GET /api/freelottery/today returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('GET /api/freelottery/winners returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  describe('GET /api/freelottery/status', () => {
    it('returns disabled shape when no start date configured', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/status' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        enabled: false,
        startUtcDate: null,
        totalDays: 100,
        prizeBaseUnits: '1000000000000',
        drawHourUtc: 19,
        dayIndex: null,
        currentDayUtc: null,
        nextDrawAt: null,
        ended: true,
      });
    });
  });
});
```

- [ ] **Step 5.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotteryRoutes`
Expected: FAIL — routes 404 (not 501), and the import in `buildApp.ts` from Task 3 still doesn't resolve.

- [ ] **Step 5.3: Create `entry.ts` stub module**

Create `apps/server/src/routes/freelottery/entry.ts`:

```typescript
import type { FastifyInstance } from 'fastify';

export async function entryRoutes(app: FastifyInstance) {
  app.post('/api/freelottery/entry/start', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  app.post('/api/freelottery/entry/verify', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
```

- [ ] **Step 5.4: Create `public.ts` stub module**

Create `apps/server/src/routes/freelottery/public.ts`:

```typescript
import type { FastifyInstance } from 'fastify';

export async function publicRoutes(app: FastifyInstance) {
  app.get('/api/freelottery/today', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  app.get('/api/freelottery/winners', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
```

- [ ] **Step 5.5: Create `status.ts` (real handler)**

Create `apps/server/src/routes/freelottery/status.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { getDayUtc, dayIndex, nextDrawAt, hasEnded } from '../../freelottery/schedule.js';

export async function statusRoutes(app: FastifyInstance) {
  app.get('/api/freelottery/status', async () => {
    const cfg = app.config;
    const sched = {
      startUtcDate: cfg.freelotteryStartUtcDate,
      totalDays: cfg.freelotteryTotalDays,
      drawHourUtc: cfg.freelotteryDrawHourUtc,
    };
    const now = new Date();
    const currentDayUtc = getDayUtc(now, sched);
    return {
      enabled: !!cfg.freelotteryStartUtcDate,
      startUtcDate: cfg.freelotteryStartUtcDate ?? null,
      totalDays: cfg.freelotteryTotalDays,
      prizeBaseUnits: cfg.freelotteryPrizeBaseUnits.toString(),
      drawHourUtc: cfg.freelotteryDrawHourUtc,
      dayIndex: currentDayUtc ? dayIndex(currentDayUtc, sched) : null,
      currentDayUtc: currentDayUtc ?? null,
      nextDrawAt: nextDrawAt(now, sched)?.toISOString() ?? null,
      ended: hasEnded(now, sched),
    };
  });
}
```

- [ ] **Step 5.6: Create `index.ts` wiring**

Create `apps/server/src/routes/freelottery/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { entryRoutes } from './entry.js';
import { publicRoutes } from './public.js';
import { statusRoutes } from './status.js';

export async function freelotteryRoutes(app: FastifyInstance) {
  await entryRoutes(app);
  await publicRoutes(app);
  await statusRoutes(app);
}
```

- [ ] **Step 5.7: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotteryRoutes`
Expected: PASS — all 5 cases green. Also rerun the full suite to confirm the buildApp import from Task 3 now resolves:

Run: `npm --workspace apps/server test`
Expected: all green, no compile errors.

- [ ] **Step 5.8: Commit**

```bash
git add apps/server/src/routes/freelottery apps/server/tests/freelotteryRoutes.test.ts
git commit -m "feat(freelottery): route skeleton + GET /status endpoint"
```

---

## Task 6: `apps/web-freelottery/` scaffold (builds, renders placeholder)

**Files:**

- Create: `apps/web-freelottery/package.json`
- Create: `apps/web-freelottery/vite.config.ts`
- Create: `apps/web-freelottery/tsconfig.json`
- Create: `apps/web-freelottery/index.html`
- Create: `apps/web-freelottery/netlify.toml`
- Create: `apps/web-freelottery/src/main.tsx`
- Create: `apps/web-freelottery/src/App.tsx`
- Create: `apps/web-freelottery/src/styles.css`
- Modify: `package.json` (repo root)

No new tests for the scaffold — proof is `npm run build` succeeds.

- [ ] **Step 6.1: Create `package.json`**

Create `apps/web-freelottery/package.json`:

```json
{
  "name": "@rpow/web-freelottery",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5177",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
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

- [ ] **Step 6.2: Create `vite.config.ts`**

Create `apps/web-freelottery/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
```

- [ ] **Step 6.3: Create `tsconfig.json`**

Create `apps/web-freelottery/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 6.4: Create `index.html`**

Create `apps/web-freelottery/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RPOW Free Lottery</title>
  <link rel="icon" type="image/svg+xml" href="https://rpow2.com/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/src/styles.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 6.5: Create `netlify.toml`**

Create `apps/web-freelottery/netlify.toml`:

```toml
# Netlify site config for freelottery.rpow2.com.
#
# Set "Base directory" in the Netlify dashboard to apps/web-freelottery/.
# Netlify reads this file from that base dir; `publish` and the working
# dir for `command` are also relative to the base. `npm ci --workspaces`
# must run from the workspace root, so the command starts with `cd ../..`
# to get back to the repo root before installing.

[build]
  command = "cd ../.. && npm ci --workspaces --include-workspace-root && npm run build --workspace @rpow/web-freelottery"
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
# Server-side CORS already allows https://freelottery.rpow2.com per slice 1
# (FREELOTTERY_WEB_ORIGIN env var, wired into Fastify's allowedOrigins list).
[context.production.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"

[context.deploy-preview.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"
```

- [ ] **Step 6.6: Create `src/main.tsx`**

Create `apps/web-freelottery/src/main.tsx`:

```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const SESSION_TTL = 2592000; // 30 days

(function maybeAdoptForwardedSession() {
  const m = window.location.hash.match(/[?&]s=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 6.7: Create `src/App.tsx` (placeholder)**

Create `apps/web-freelottery/src/App.tsx`:

```typescript
import { useEffect, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

interface Status {
  enabled: boolean;
  startUtcDate: string | null;
  totalDays: number;
  prizeBaseUnits: string;
  drawHourUtc: number;
  dayIndex: number | null;
  nextDrawAt: string | null;
  ended: boolean;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/freelottery/status`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setStatus)
      .catch(e => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>RPOW Free Lottery</h1>
      <p>Coming soon — 100 days of 1,000 RPOW giveaways.</p>
      {error ? <pre className="error">{error}</pre> : null}
      {status ? <pre>{JSON.stringify(status, null, 2)}</pre> : null}
    </main>
  );
}
```

- [ ] **Step 6.8: Create `src/styles.css`**

Create `apps/web-freelottery/src/styles.css`:

```css
:root {
  font-family: 'IBM Plex Mono', monospace;
  background: #0a0a0a;
  color: #f0f0f0;
}
body { margin: 0; }
main { max-width: 720px; margin: 4rem auto; padding: 0 1rem; }
h1 { font-weight: 700; letter-spacing: -0.02em; }
pre { background: #111; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 12px; }
.error { color: #ff6b6b; }
```

- [ ] **Step 6.9: Wire into the repo root `package.json`**

In the top-level `/Users/fredkrueger/rpow/package.json`, update the `build` script to add the new workspace:

Find:
```json
    "build": "tsc -b apps/server packages/shared packages/solana-bridge && npm --workspace apps/web run build && npm --workspace apps/web-longshot run build && npm --workspace apps/web-gladiator run build && npm --workspace apps/web-trivia run build",
```

Replace with:
```json
    "build": "tsc -b apps/server packages/shared packages/solana-bridge && npm --workspace apps/web run build && npm --workspace apps/web-longshot run build && npm --workspace apps/web-gladiator run build && npm --workspace apps/web-trivia run build && npm --workspace apps/web-freelottery run build",
```

And the `test` script — find:
```json
    "test": "npm --workspace packages/shared test && npm --workspace packages/solana-bridge test && npm --workspace apps/server test && npm --workspace apps/web test && npm --workspace apps/web-longshot test && npm --workspace apps/web-gladiator test && npm --workspace apps/web-trivia test",
```

Replace with:
```json
    "test": "npm --workspace packages/shared test && npm --workspace packages/solana-bridge test && npm --workspace apps/server test && npm --workspace apps/web test && npm --workspace apps/web-longshot test && npm --workspace apps/web-gladiator test && npm --workspace apps/web-trivia test && npm --workspace apps/web-freelottery test",
```

And add a `dev:freelottery` entry to the scripts block:

```json
    "dev:freelottery": "npm --workspace apps/web-freelottery run dev"
```

- [ ] **Step 6.10: Install dependencies for the new workspace**

Run: `npm install`
Expected: Adds `apps/web-freelottery` to the workspace lockfile, installs React/Vite for it. No errors.

- [ ] **Step 6.11: Build the new workspace**

Run: `npm --workspace apps/web-freelottery run build`
Expected: PASS — `dist/` folder created with `index.html`, JS bundle, CSS. No TypeScript errors.

- [ ] **Step 6.12: Commit**

```bash
git add apps/web-freelottery package.json package-lock.json
git commit -m "feat(freelottery): web-freelottery app scaffold"
```

---

## Task 7: Final smoke — full test suite + full build

This task has no new files; it's a verification gate before declaring Slice 1 done.

- [ ] **Step 7.1: Run the full test suite**

Run: `npm test`
Expected: every workspace passes — server, shared, solana-bridge, all 5 web apps.

- [ ] **Step 7.2: Run the full build**

Run: `npm run build`
Expected: server compiles, all 5 web apps build to their `dist/` folders, no errors.

- [ ] **Step 7.3: (No commit — this is a pure verification step.)**

If anything fails, stop and resolve before declaring the slice complete. Do not skip with `--no-verify` or similar.

---

## What slice 1 does NOT do (intentional)

- No entry flow (`/start`, `/verify`) — Slice 2.
- No draw scheduler, no Solana block fetch, no winner picking — Slice 3.
- No public page UI beyond a placeholder fetch of `/status` — Slice 4 (using the `frontend-design` skill per spec §6.1).
- No news entry in `apps/web/src/pages/News.tsx` — added at launch in the rollout slice. We do not announce a feature that isn't wired up.
- No CSV allowlist enforcement (the `freelotteryAllowedEmails` field is wired but unused). Used starting Slice 2.

## Slice 1 acceptance

The slice is done when:

1. All 7 tasks above are committed.
2. `npm test` passes from a clean checkout.
3. `npm run build` succeeds (including the new `web-freelottery` workspace).
4. Hitting `GET /api/freelottery/status` against a dev server returns JSON whose shape matches the test in Step 5.1.
5. Stub endpoints (`entry/start`, `entry/verify`, `today`, `winners`) all return `{ error: 'not_implemented' }` with HTTP 501.
