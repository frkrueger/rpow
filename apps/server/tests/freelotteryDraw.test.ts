import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { runOneDay } from '../src/freelottery/draw.js';

const PAST_DAY = '2026-05-10'; // any date prior to "today"
// mintMaxSupply in test helpers is 21 RPOW — too small for the 1000 RPOW prize.
// Override to a value that accommodates the prize without breaking other tests.
const DRAW_CONFIG_OVERRIDES = { solanaRpcUrl: 'http://test.local', mintMaxSupply: 1_000_000 };

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
      config: { ...ctx.config, ...DRAW_CONFIG_OVERRIDES },
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
      config: { ...ctx.config, ...DRAW_CONFIG_OVERRIDES },
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
      config: { ...ctx.config, ...DRAW_CONFIG_OVERRIDES },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    const second = await runOneDay({
      pool: ctx.pool,
      config: { ...ctx.config, ...DRAW_CONFIG_OVERRIDES },
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
      config: { ...ctx.config, ...DRAW_CONFIG_OVERRIDES },
      dayUtc: PAST_DAY,
      fetchImpl: fakeFetchImpl(),
    });
    // FakeBridgeClient records every mintTo call in `calls: MintToArgs[]`.
    expect(ctx.bridgeClient.calls).toEqual([]);
  });
});
