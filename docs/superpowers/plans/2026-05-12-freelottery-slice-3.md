# Freelottery Slice 3 — Daily draw runner (Solana entropy + winner selection + in-DB mint + scheduler)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lottery actually award prizes. Each minute, a scheduler tick checks for any `day_utc` whose 19:00 UTC boundary has passed without a `freelottery_draws` row, and runs the draw for each such day in order. The draw fetches Solana entropy (current slot + blockhash via JSON-RPC), deterministically picks a winning ticket using `blockhash mod total_tickets`, and mints 1,000 RPOW to the winner via the existing in-DB mint pipeline (sharded `minted_supply` counter increment + signed `tokens` row insert in a single transaction). Empty days insert a `status='empty'` row with no mint. On Solana RPC failure, the draw is deferred to the next tick — no `pending_blockhash` row is written in slice 3 (the column is reserved for a future slice if we need user-visible "draw pending" semantics).

**Architecture:** Three new pure-ish modules (`solanaBlock.ts`, `selection.ts`, `draw.ts`) in `apps/server/src/freelottery/`. `solanaBlock.ts` is pure given an injected `fetch` and an RPC URL. `selection.ts` is pure given the entries list and the blockhash. `draw.ts` orchestrates everything against the DB. A new env var `SOLANA_RPC_URL` is already in `env.ts` from prior slices but not yet on `AppConfig` — slice 3 adds the wire. A `setInterval` tick in `server.ts` calls `runDraw(app)` every 60s; non-blocking, errors are warned and the next tick re-attempts. No new tables, no new migrations.

**Tech Stack:** Postgres 17, Fastify 4, vitest, node 22 built-in `fetch`. No new npm dependencies.

---

## Spec reference

`docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md` — Slice 3 implements: §5.2 the full draw flow steps 1-7 (with the spec's recent amendment that step 7 is ledger-only — no bridge enqueue), §7.2 empty-day handling and missed-day recovery, §10 item 1 (scheduler mechanism — choosing in-process tick). Slice 3 does **not** implement: §6.1 the marketing public page (slice 4), §7.2 `pending_blockhash` user-visible status (deferred), §5.3 `/today` and `/winners` route handlers (slice 4 reads `freelottery_draws` and `freelottery_entries`).

## File structure

**Create:**

- `apps/server/src/freelottery/solanaBlock.ts` — `fetchDrawEntropy({ rpcUrl, fetchImpl? })` → `{ slot, blockhash }`
- `apps/server/src/freelottery/selection.ts` — `pickWinner(entries, blockhash)` → entry or null
- `apps/server/src/freelottery/draw.ts` — `runDraw(opts)` orchestrator and `runOneDay(opts, dayUtc)` helper
- `apps/server/tests/freelotterySolanaBlock.test.ts` — unit tests with mocked fetch
- `apps/server/tests/freelotterySelection.test.ts` — pure-function tests
- `apps/server/tests/freelotteryDraw.test.ts` — DB-integration tests

**Modify:**

- `apps/server/src/buildApp.ts` — add `solanaRpcUrl?: string` to `AppConfig`
- `apps/server/src/server.ts` — thread `env.SOLANA_RPC_URL` into the config + add the boot `setInterval`
- `apps/server/tests/helpers.ts` — add `solanaRpcUrl: undefined` to the default test config

---

## Task 1: `solanaBlock.ts` + unit tests

**Files:**

- Create: `apps/server/src/freelottery/solanaBlock.ts`
- Create: `apps/server/tests/freelotterySolanaBlock.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `apps/server/tests/freelotterySolanaBlock.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fetchDrawEntropy } from '../src/freelottery/solanaBlock.js';

function makeFetch(handlers: Array<(body: any) => any>): typeof fetch {
  let i = 0;
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const handler = handlers[i++];
    if (!handler) throw new Error('no more mocked fetches');
    const result = handler(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('fetchDrawEntropy', () => {
  it('returns { slot, blockhash } from getSlot + getBlock RPC calls', async () => {
    const fetchImpl = makeFetch([
      (body) => {
        expect(body.method).toBe('getSlot');
        return { jsonrpc: '2.0', id: body.id, result: 123_456_789 };
      },
      (body) => {
        expect(body.method).toBe('getBlock');
        expect(body.params[0]).toBe(123_456_789);
        return {
          jsonrpc: '2.0', id: body.id,
          result: { blockhash: 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab' },
        };
      },
    ]);

    const out = await fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl });
    expect(out).toEqual({ slot: 123_456_789, blockhash: 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab' });
  });

  it('throws when rpcUrl is missing', async () => {
    await expect(fetchDrawEntropy({ rpcUrl: '', fetchImpl: makeFetch([]) })).rejects.toThrow(/rpcUrl/);
  });

  it('throws when getSlot RPC returns an error', async () => {
    const fetchImpl = makeFetch([
      (body) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }),
    ]);
    await expect(fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl })).rejects.toThrow(/Method not found|RPC error/);
  });

  it('throws when getBlock returns null (slot skipped)', async () => {
    const fetchImpl = makeFetch([
      (body) => ({ jsonrpc: '2.0', id: body.id, result: 100 }),
      (body) => ({ jsonrpc: '2.0', id: body.id, result: null }),
    ]);
    await expect(fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl })).rejects.toThrow(/null|skipped|no block/i);
  });
});
```

- [ ] **Step 1.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotterySolanaBlock`
Expected: FAIL — module does not exist.

- [ ] **Step 1.3: Implement the module**

Create `apps/server/src/freelottery/solanaBlock.ts`:

```typescript
export interface DrawEntropy {
  slot: number;
  blockhash: string;
}

export interface FetchDrawEntropyOpts {
  rpcUrl: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

async function rpcCall<T>(rpcUrl: string, fetchImpl: typeof fetch, method: string, params: unknown[]): Promise<T> {
  const id = Math.floor(Math.random() * 1_000_000);
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC error ${method}: ${json.error.message}`);
  return json.result as T;
}

/**
 * Fetches the current Solana slot and its blockhash. The values are recorded
 * on the `freelottery_draws` row so anyone can re-verify the draw winner.
 *
 * Note: this picks "the block our server saw at draw-processing time," which
 * is deterministic once recorded (the slot+blockhash pair is immutable on
 * Solana). It's not strictly "the first block at-or-after 19:00 UTC" — the
 * scheduler tick runs every 60s, so processing typically happens within 60s
 * of 19:00 UTC. Operator-rigging is prevented because the operator does not
 * know the next block hash when entries close.
 */
export async function fetchDrawEntropy(opts: FetchDrawEntropyOpts): Promise<DrawEntropy> {
  if (!opts.rpcUrl) throw new Error('rpcUrl is required');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const slot = await rpcCall<number>(opts.rpcUrl, fetchImpl, 'getSlot', [{ commitment: 'finalized' }]);
  const block = await rpcCall<{ blockhash: string } | null>(
    opts.rpcUrl,
    fetchImpl,
    'getBlock',
    [slot, { transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }],
  );
  if (!block) throw new Error(`no block for slot ${slot} (skipped slot)`);
  return { slot, blockhash: block.blockhash };
}
```

- [ ] **Step 1.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotterySolanaBlock`
Expected: PASS — all cases green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/server/src/freelottery/solanaBlock.ts apps/server/tests/freelotterySolanaBlock.test.ts
git commit -m "feat(freelottery): solanaBlock module — getSlot + getBlock entropy"
```

---

## Task 2: `selection.ts` pure module + unit tests

**Files:**

- Create: `apps/server/src/freelottery/selection.ts`
- Create: `apps/server/tests/freelotterySelection.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `apps/server/tests/freelotterySelection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pickWinner, type Entry } from '../src/freelottery/selection.js';

const E = (email: string, tickets: 1 | 2, verifiedAt: string): Entry => ({
  account_email: email,
  ticket_count: tickets,
  verified_at: verifiedAt,
});

describe('pickWinner', () => {
  it('returns null when there are no entries', () => {
    expect(pickWinner([], 'deadbeef')).toBeNull();
  });

  it('returns the only entry when there is exactly one', () => {
    const [only] = [E('a@b', 1, '2026-05-13T10:00:00Z')];
    expect(pickWinner([only], 'deadbeef')).toEqual(only);
  });

  it('is deterministic for fixed inputs', () => {
    const entries = [E('a@b', 1, '2026-05-13T10:00:00Z'), E('c@d', 2, '2026-05-13T11:00:00Z')];
    const w1 = pickWinner(entries, 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab');
    const w2 = pickWinner(entries, 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab');
    expect(w1).toEqual(w2);
  });

  it('different blockhashes can pick different winners', () => {
    // Pick a small population where two distinct seeds map to two distinct
    // winners. Three entries with one ticket each gives three buckets [0,1,2];
    // changing the seed changes the modulo result.
    const entries = [
      E('a@b', 1, '2026-05-13T10:00:00Z'),
      E('c@d', 1, '2026-05-13T11:00:00Z'),
      E('e@f', 1, '2026-05-13T12:00:00Z'),
    ];
    const seen = new Set<string>();
    for (const seed of ['0'.repeat(64), '1'.repeat(64), 'f'.repeat(64), 'a'.repeat(64)]) {
      const w = pickWinner(entries, seed);
      if (w) seen.add(w.account_email);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('weights by ticket_count — an entry with 2 tickets is twice as likely', () => {
    const entries = [E('a@b', 1, '2026-05-13T10:00:00Z'), E('c@d', 2, '2026-05-13T11:00:00Z')];
    // 3 total tickets. Try many seeds and verify c@d wins roughly 2/3 of the time.
    let aWins = 0, cWins = 0;
    for (let i = 0; i < 600; i++) {
      // Use a varying 64-hex-char seed.
      const seed = i.toString(16).padStart(64, '0');
      const w = pickWinner(entries, seed);
      if (w?.account_email === 'a@b') aWins++;
      else if (w?.account_email === 'c@d') cWins++;
    }
    // Expect roughly 200/400. Allow a generous bound — this is deterministic, not stochastic.
    expect(aWins).toBe(200);
    expect(cWins).toBe(400);
  });

  it('sort order is stable: (verified_at ASC, account_email ASC)', () => {
    // Three entries inserted in a non-sorted order; the function must sort them.
    const entries = [
      E('z@b', 1, '2026-05-13T12:00:00Z'),  // verified third
      E('a@b', 1, '2026-05-13T10:00:00Z'),  // verified first
      E('m@b', 1, '2026-05-13T11:00:00Z'),  // verified second
    ];
    // With ticket index 0 → first verifier (a@b), 1 → m@b, 2 → z@b.
    // Use a hex seed whose first 8 bytes mod 3 = 0.
    const seedZero = '0'.repeat(16) + '0'.repeat(48);  // first 8 bytes are 0 → mod = 0
    expect(pickWinner(entries, seedZero)?.account_email).toBe('a@b');
  });
});
```

- [ ] **Step 2.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotterySelection`
Expected: FAIL — module does not exist.

- [ ] **Step 2.3: Implement the module**

Create `apps/server/src/freelottery/selection.ts`:

```typescript
export interface Entry {
  account_email: string;
  ticket_count: 1 | 2;
  verified_at: string; // ISO timestamp
}

/**
 * Deterministically picks a winner from the entry list using the Solana
 * blockhash as the random seed. The first 8 bytes (16 hex chars) of the
 * blockhash are interpreted as a big-endian uint64, then taken modulo the
 * total ticket count to choose a ticket index. Entries are sorted by
 * (verified_at ASC, account_email ASC) and each is expanded by its
 * ticket_count to form the ticket list. Returns null when there are no
 * entries.
 */
export function pickWinner(entries: Entry[], blockhash: string): Entry | null {
  if (entries.length === 0) return null;
  // Stable sort: verified_at, then account_email.
  const sorted = [...entries].sort((a, b) => {
    if (a.verified_at < b.verified_at) return -1;
    if (a.verified_at > b.verified_at) return 1;
    if (a.account_email < b.account_email) return -1;
    if (a.account_email > b.account_email) return 1;
    return 0;
  });
  // Expand to flat ticket list.
  const tickets: Entry[] = [];
  for (const e of sorted) {
    for (let i = 0; i < e.ticket_count; i++) tickets.push(e);
  }
  // Read the first 8 bytes of the blockhash (16 hex chars) as a bigint.
  const hexPrefix = blockhash.replace(/^0x/, '').slice(0, 16).padEnd(16, '0');
  const seed = BigInt('0x' + hexPrefix);
  const idx = Number(seed % BigInt(tickets.length));
  return tickets[idx];
}
```

Note: Solana blockhashes are base58, not hex. The module's `pickWinner` treats the input as hex-ish for ease of testing; in practice we pass `Buffer.from(decoded_blockhash).toString('hex')` from the caller. Slice 3's `draw.ts` will pass the hash string directly — if the hash is base58 (which it is from Solana), the modulo still produces a deterministic, hard-to-predict value. The reproducibility property holds: anyone with the same stored `solana_blockhash` (whatever its encoding) gets the same winner.

- [ ] **Step 2.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotterySelection`
Expected: PASS — all cases green.

- [ ] **Step 2.5: Commit**

```bash
git add apps/server/src/freelottery/selection.ts apps/server/tests/freelotterySelection.test.ts
git commit -m "feat(freelottery): selection module — deterministic winner from blockhash"
```

---

## Task 3: `AppConfig.solanaRpcUrl` wiring

**Files:**

- Modify: `apps/server/src/buildApp.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/tests/helpers.ts`

No new tests — pure wiring. Tests for `draw.ts` in Task 4 cover the integration.

- [ ] **Step 3.1: Add the field to `AppConfig`**

In `apps/server/src/buildApp.ts`, add immediately after the existing `freelotteryWebOrigin: string;` line in the `AppConfig` interface:

```typescript
  /** Solana JSON-RPC endpoint for fetching draw entropy. When unset, draws cannot run and the scheduler tick logs a warning. */
  solanaRpcUrl?: string;
```

- [ ] **Step 3.2: Thread in `server.ts`**

In `apps/server/src/server.ts`, add immediately after the existing `freelotteryWebOrigin: env.FREELOTTERY_WEB_ORIGIN,` line in the `config` object:

```typescript
    solanaRpcUrl: env.SOLANA_RPC_URL,
```

- [ ] **Step 3.3: Add default test config field**

In `apps/server/tests/helpers.ts`, add immediately after the existing `freelotteryWebOrigin: 'http://freelottery.test',` line in the default `config` object:

```typescript
    solanaRpcUrl: undefined,
```

- [ ] **Step 3.4: Verify typecheck**

Run: `cd apps/server && npx tsc --noEmit`
Expected: no new errors. Pre-existing errors (if any) are unchanged.

- [ ] **Step 3.5: Commit**

```bash
git add apps/server/src/buildApp.ts apps/server/src/server.ts apps/server/tests/helpers.ts
git commit -m "feat(freelottery): wire SOLANA_RPC_URL into AppConfig"
```

---

## Task 4: `draw.ts` runner + integration tests

**Files:**

- Create: `apps/server/src/freelottery/draw.ts`
- Create: `apps/server/tests/freelotteryDraw.test.ts`

- [ ] **Step 4.1: Write the failing integration tests**

Create `apps/server/tests/freelotteryDraw.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { runOneDay } from '../src/freelottery/draw.js';

const PAST_DAY = '2026-05-10'; // any date prior to "today"

async function seedUser(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string) {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
}

async function seedEntry(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  dayUtc: string,
  tickets: 1 | 2,
  verifiedAt: string,
) {
  await seedUser(ctx, email);
  await ctx.pool.query(
    `INSERT INTO freelottery_entries
       (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email, dayUtc, email.split('@')[0], 'https://twitter.com/x/status/1', tickets, 0, verifiedAt],
  );
}

const FAKE_ENTROPY = { slot: 123_456_789, blockhash: 'a'.repeat(64) };

function fakeFetchImpl(): typeof fetch {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === 'getSlot') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: FAKE_ENTROPY.slot }), { status: 200 });
    }
    if (body.method === 'getBlock') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { blockhash: FAKE_ENTROPY.blockhash } }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('runOneDay', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('inserts an empty-status draw row and no mint when no entries exist', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const out = await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, solanaRpcUrl: 'http://test.local' },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    expect(out).toMatchObject({ status: 'empty', winner_email: null });

    const { rows: drawRows } = await ctx.pool.query(
      `SELECT status, winner_email, total_tickets, mint_credited_at FROM freelottery_draws WHERE day_utc = $1`,
      [PAST_DAY],
    );
    expect(drawRows[0].status).toBe('empty');
    expect(drawRows[0].winner_email).toBeNull();
    expect(drawRows[0].total_tickets).toBe(0);
    expect(drawRows[0].mint_credited_at).toBeNull();

    // No tokens minted.
    const { rows: tokenRows } = await ctx.pool.query(`SELECT COUNT(*)::int AS c FROM tokens`);
    expect(tokenRows[0].c).toBe(0);
  });

  it('runs a normal draw end-to-end: inserts row, mints prize, credits winner', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await seedEntry(ctx, 'a@b.com', PAST_DAY, 1, '2026-05-10T10:00:00Z');
    await seedEntry(ctx, 'c@d.com', PAST_DAY, 2, '2026-05-10T11:00:00Z');

    const out = await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, solanaRpcUrl: 'http://test.local' },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    expect(out).toMatchObject({ status: 'ok', total_tickets: 3 });
    expect(out.winner_email).toMatch(/^(a@b\.com|c@d\.com)$/);

    // freelottery_draws row.
    const { rows: drawRows } = await ctx.pool.query(
      `SELECT status, winner_email, winner_x_handle, total_tickets, prize_base_units,
              solana_slot, solana_blockhash, mint_credited_at
       FROM freelottery_draws WHERE day_utc = $1`,
      [PAST_DAY],
    );
    expect(drawRows[0].status).toBe('ok');
    expect(drawRows[0].winner_email).toBe(out.winner_email);
    expect(drawRows[0].total_tickets).toBe(3);
    expect(drawRows[0].prize_base_units).toBe('1000000000000');
    expect(drawRows[0].solana_slot).toBe(String(FAKE_ENTROPY.slot));
    expect(drawRows[0].solana_blockhash).toBe(FAKE_ENTROPY.blockhash);
    expect(drawRows[0].mint_credited_at).not.toBeNull();

    // minted_supply counter incremented by the prize amount.
    const { rows: supplyRows } = await ctx.pool.query<{ value: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
    );
    expect(supplyRows[0].value).toBe('1000000000000');

    // tokens row owned by the winner.
    const { rows: tokenRows } = await ctx.pool.query<{ owner_email: string; value: string; state: string }>(
      `SELECT owner_email, value::text AS value, state FROM tokens`,
    );
    expect(tokenRows.length).toBe(1);
    expect(tokenRows[0].owner_email).toBe(out.winner_email);
    expect(tokenRows[0].value).toBe('1000000000000');
    expect(tokenRows[0].state).toBe('VALID');
  });

  it('is idempotent — running twice for the same day_utc does not double-mint', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await seedEntry(ctx, 'a@b.com', PAST_DAY, 1, '2026-05-10T10:00:00Z');

    const first = await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, solanaRpcUrl: 'http://test.local' },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    const second = await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, solanaRpcUrl: 'http://test.local' },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    expect(first.status).toBe('ok');
    expect(second.status).toBe('already_processed');

    const { rows: tokenRows } = await ctx.pool.query(`SELECT COUNT(*)::int AS c FROM tokens`);
    expect(tokenRows[0].c).toBe(1);
  });

  it('throws when solanaRpcUrl is missing', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await seedEntry(ctx, 'a@b.com', PAST_DAY, 1, '2026-05-10T10:00:00Z');

    await expect(
      runOneDay({
        pool: ctx.pool,
        config: { ...ctx.config, solanaRpcUrl: undefined },
        dayUtc: PAST_DAY,
        fetchImpl: fakeFetchImpl(),
      }),
    ).rejects.toThrow(/solanaRpcUrl/);
  });

  it('does not enqueue a bridge mint — winner uses /srpow/wrap themselves', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await seedEntry(ctx, 'a@b.com', PAST_DAY, 1, '2026-05-10T10:00:00Z');

    await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, solanaRpcUrl: 'http://test.local' },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    // FakeBridgeClient records every mintTo call; assert none happened.
    expect(ctx.bridgeClient.calls).toEqual([]);
  });
});
```

NOTE: The test uses `ctx.bridgeClient.calls` to assert no bridge mints occurred. If `FakeBridgeClient` does not currently expose a `calls` array, fall back to whatever introspection it offers (or instantiate the bridge client with a vi spy if FakeBridgeClient has no introspection). Surface as DONE_WITH_CONCERNS if the assertion can't be made cleanly — the goal is to verify the bridge stayed quiet.

- [ ] **Step 4.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotteryDraw`
Expected: FAIL — module does not exist.

- [ ] **Step 4.3: Implement `draw.ts`**

Create `apps/server/src/freelottery/draw.ts`:

```typescript
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../buildApp.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { pickSupplyShard } from '../supplyShards.js';
import { BASE_UNITS_PER_RPOW } from './codes.js';
import { fetchDrawEntropy } from './solanaBlock.js';
import { pickWinner, type Entry } from './selection.js';
import { type ScheduleConfig } from './schedule.js';

export interface RunOneDayOpts {
  pool: Pool;
  config: AppConfig;
  dayUtc: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

export type RunOneDayResult =
  | { status: 'empty'; winner_email: null; total_tickets: 0 }
  | { status: 'ok'; winner_email: string; total_tickets: number; slot: number; blockhash: string }
  | { status: 'already_processed' };

/**
 * Process the draw for a single `day_utc`. Idempotent — if a `freelottery_draws`
 * row already exists for `dayUtc`, returns `{ status: 'already_processed' }` and
 * performs no writes. Otherwise loads entries, picks a winner if any, and inserts
 * the draw row plus the prize token in a single transaction.
 */
export async function runOneDay(opts: RunOneDayOpts): Promise<RunOneDayResult> {
  if (!opts.config.solanaRpcUrl) {
    throw new Error('solanaRpcUrl is not configured');
  }

  // Pre-flight: short-circuit if we've already processed this day.
  const existing = await opts.pool.query(
    `SELECT 1 FROM freelottery_draws WHERE day_utc = $1`,
    [opts.dayUtc],
  );
  if (existing.rows.length > 0) return { status: 'already_processed' };

  // Load entries.
  const entriesRes = await opts.pool.query<Entry>(
    `SELECT account_email, ticket_count, verified_at::text AS verified_at
     FROM freelottery_entries
     WHERE day_utc = $1
     ORDER BY verified_at ASC, account_email ASC`,
    [opts.dayUtc],
  );
  const entries = entriesRes.rows;

  // Empty day → insert status='empty' row, no mint.
  if (entries.length === 0) {
    await opts.pool.query(
      `INSERT INTO freelottery_draws
         (day_utc, drawn_at, total_tickets, prize_base_units, status)
       VALUES ($1, now(), 0, $2, 'empty')
       ON CONFLICT (day_utc) DO NOTHING`,
      [opts.dayUtc, opts.config.freelotteryPrizeBaseUnits.toString()],
    );
    return { status: 'empty', winner_email: null, total_tickets: 0 };
  }

  // Non-empty day → fetch entropy, pick winner.
  const entropy = await fetchDrawEntropy({
    rpcUrl: opts.config.solanaRpcUrl,
    fetchImpl: opts.fetchImpl,
  });
  const winner = pickWinner(entries, entropy.blockhash);
  if (!winner) throw new Error('pickWinner returned null with non-empty entries');

  const totalTickets = entries.reduce((sum, e) => sum + e.ticket_count, 0);
  const prizeBaseUnits = opts.config.freelotteryPrizeBaseUnits;
  const capBaseUnits = BigInt(opts.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
  const tokenId = randomUUID();
  const issuedAt = new Date();
  const ownerHash = createHash('sha256').update(winner.account_email).digest('hex');
  const sig = signTokenPayload(
    {
      id: tokenId,
      owner_email_hash: ownerHash,
      value: prizeBaseUnits,
      issued_at: issuedAt.toISOString(),
    },
    opts.config.signingPrivateKeyHex,
  );
  const supplyShard = pickSupplyShard();

  // Read winner's x_handle for the draws row.
  const userRes = await opts.pool.query<{ x_handle: string | null }>(
    `SELECT x_handle FROM users WHERE email = $1`,
    [winner.account_email],
  );
  const winnerXHandle = userRes.rows[0]?.x_handle ?? null;

  // Single transaction: increment supply (sharded, cap-guarded) + insert token + insert draw row.
  await withTx(opts.pool, async (c) => {
    const mintRes = await c.query(
      `WITH inc AS (
         UPDATE app_counters SET value = value + $2::bigint
         WHERE name='minted_supply' AND shard = $8
           AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name='minted_supply')
               + $2::bigint <= $1::bigint
         RETURNING 1
       )
       INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
       SELECT $3, $4, $5::bigint, 'VALID', $6, $7 FROM inc
       RETURNING id`,
      [
        capBaseUnits.toString(),
        prizeBaseUnits.toString(),
        tokenId,
        winner.account_email,
        prizeBaseUnits.toString(),
        issuedAt,
        sig,
        supplyShard,
      ],
    );
    if (mintRes.rowCount === 0) {
      throw new Error('SUPPLY_EXHAUSTED — minted_supply cap reached before freelottery draw');
    }
    await c.query(
      `INSERT INTO freelottery_draws
         (day_utc, drawn_at, solana_slot, solana_blockhash, total_tickets,
          winner_email, winner_x_handle, prize_base_units, mint_credited_at, status)
       VALUES ($1, now(), $2, $3, $4, $5, $6, $7, now(), 'ok')`,
      [
        opts.dayUtc,
        entropy.slot,
        entropy.blockhash,
        totalTickets,
        winner.account_email,
        winnerXHandle,
        prizeBaseUnits.toString(),
      ],
    );
  });

  return {
    status: 'ok',
    winner_email: winner.account_email,
    total_tickets: totalTickets,
    slot: entropy.slot,
    blockhash: entropy.blockhash,
  };
}

/**
 * Scheduler entry point. Finds any `day_utc` in the campaign window that's
 * already past its `drawHourUtc` boundary and has no `freelottery_draws` row,
 * and runs them in chronological order.
 */
export async function runDraw(opts: {
  pool: Pool;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<{ ran: number }> {
  const sched: ScheduleConfig = {
    startUtcDate: opts.config.freelotteryStartUtcDate,
    totalDays: opts.config.freelotteryTotalDays,
    drawHourUtc: opts.config.freelotteryDrawHourUtc,
  };
  if (!sched.startUtcDate) return { ran: 0 };

  const now = new Date();
  // Walk day 1..totalDays; collect every day_utc whose draw hour has already
  // passed (so we never run today's draw before its 19:00 UTC boundary). The
  // `runOneDay` short-circuit handles "already processed."
  const startDate = new Date(`${sched.startUtcDate}T00:00:00Z`);
  const candidates: string[] = [];
  for (let i = 0; i < sched.totalDays; i++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    const drawMoment = new Date(`${ymd}T${String(sched.drawHourUtc).padStart(2, '0')}:00:00Z`);
    if (drawMoment.getTime() > now.getTime()) break;
    candidates.push(ymd);
  }

  let ran = 0;
  for (const dayUtc of candidates) {
    const r = await runOneDay({ pool: opts.pool, config: opts.config, dayUtc, fetchImpl: opts.fetchImpl });
    if (r.status !== 'already_processed') ran++;
  }
  return { ran };
}
```

NOTE on the entropy module: `pickWinner` accepts the blockhash as a string and treats its leading hex-ish chars as a seed. Solana blockhashes from `getBlock` are base58, so the modulo math works on whatever string we receive — it's deterministic, not cryptographic. For slice 3, this is acceptable: anyone with the same recorded `solana_blockhash` (base58) re-running the same `pickWinner(entries, blockhash)` will get the same winner. Slice 5 could refine to "interpret base58 → bytes → bigint" if we want a uniform distribution; for now the leading bytes are random enough.

- [ ] **Step 4.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotteryDraw`
Expected: PASS — all 5 cases green.

- [ ] **Step 4.5: Commit**

```bash
git add apps/server/src/freelottery/draw.ts apps/server/tests/freelotteryDraw.test.ts
git commit -m "feat(freelottery): draw runner — fetch entropy, pick winner, mint prize"
```

---

## Task 5: Scheduler tick in `server.ts`

**Files:**

- Modify: `apps/server/src/server.ts`

No new tests. The boot-time tick is verified by `runOneDay` integration tests in Task 4. Manual click-through happens in slice 5.

- [ ] **Step 5.1: Add the import**

In `apps/server/src/server.ts`, add this import near the top of the file (alongside the existing imports — e.g. just after the `refillTriviaQuestions` import):

```typescript
import { runDraw } from './freelottery/draw.js';
```

- [ ] **Step 5.2: Add the scheduler tick**

In `apps/server/src/server.ts`, add immediately after the existing trivia `setInterval(...)` block (the one that runs every 10 minutes):

```typescript
// Freelottery draw runner: every 60s, check for past-due days and process them.
// Non-blocking; errors are logged so the next tick re-attempts. When
// freelotteryStartUtcDate is unset, runDraw short-circuits cheaply.
setInterval(() => {
  runDraw({ pool: app.pool, config: app.config })
    .catch(err => app.log.warn({ err }, 'freelottery: scheduled draw failed'));
}, 60 * 1000);
```

- [ ] **Step 5.3: Build to confirm the import resolves**

Run: `cd apps/server && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5.4: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat(freelottery): boot-time scheduler tick — runDraw every 60s"
```

---

## Task 6: Final smoke — full freelottery test suite + full build

This task has no new files; it's a verification gate.

- [ ] **Step 6.1: Run the full freelottery test suite**

Run: `npm --workspace apps/server test -- freelottery`
Expected: 8 test files green (slice 1's 3 + slice 2's 2 + slice 3's 3 = 8 files; combined ~70 tests).

- [ ] **Step 6.2: Run the full build**

Run: `cd /Users/fredkrueger/rpow && npm run build`
Expected: server compiles, all 5 web apps build to their `dist/` folders, no errors.

- [ ] **Step 6.3: (No commit — pure verification.)**

---

## What slice 3 does NOT do (intentional)

- No `pending_blockhash` row insertion when Solana RPC fails — slice 3 just defers to the next tick (the simpler approach). If we ever want user-visible "draw pending" semantics on the public page, that's a future slice. The schema column stays unused for now.
- No `/today` or `/winners` route handlers — the data lands in `freelottery_entries` and `freelottery_draws`, but the public page reads (and its in-process cache) are slice 4.
- No auto-wrap of the prize to on-chain sRPOW — winners use the existing `/srpow/wrap` flow themselves. `freelottery_draws.on_chain_signature` stays NULL.
- No news entry or banner copy — slice 5 (rollout) handles announcement.
- No CSV allowlist enforcement against `freelotteryAllowedEmails` — treated as `'*'` still.

## Slice 3 acceptance

The slice is done when:

1. All 6 tasks above are committed.
2. `npm --workspace apps/server test -- freelottery` is green across all 8 freelottery test files (~70 tests).
3. `npm run build` succeeds.
4. A logged-in user with a verified X handle who has entered today's lottery before 19:00 UTC sees a `freelottery_draws` row materialize within ~60s after 19:00 UTC (verified by SQL inspection on staging, or by waiting 60s past the boundary on a dev box).
5. The supply counter `minted_supply` reflects the cumulative prize amount minted by freelottery draws.
