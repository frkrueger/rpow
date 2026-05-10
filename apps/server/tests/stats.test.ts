import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;
const REWARD_BASE_UNITS = 10_000_000n;            // 0.01 RPOW per solution at production base
const SEND_AMOUNT_BASE_UNITS = 1_000_000n;        // 0.001 RPOW: tests change-token path
const MAX_SUPPLY_BASE_UNITS = 21n * BASE_UNITS_PER_RPOW;

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({
    method: 'POST',
    url: '/auth/request',
    payload: { email },
    headers: { 'content-type': 'application/json' },
  });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(200);
  }
}

describe('GET /stats/*', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns public summary, current holder aggregates, and server-derived history', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 3);

    // Send a sub-reward amount so we exercise the change-token path:
    // a starts with 3 × 10M tokens, sends 1M to b. Change = 9M back to a.
    // After: a holds [10M, 10M, 9M] = 29M; b holds [1M] = 1M.
    const send = await ctx.app.inject({
      method: 'POST',
      url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: SEND_AMOUNT_BASE_UNITS.toString(), idempotency_key: randomUUID() },
    });
    expect(send.statusCode).toBe(200);

    const totalMinted = 3n * REWARD_BASE_UNITS;       // 30M
    const aBalance = totalMinted - SEND_AMOUNT_BASE_UNITS;  // 29M
    const bBalance = SEND_AMOUNT_BASE_UNITS;          // 1M

    const summaryRes = await ctx.app.inject({ method: 'GET', url: '/stats/summary' });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json();
    expect(summary.ledger).toMatchObject({
      total_minted_base_units: totalMinted.toString(),
      total_transferred_base_units: SEND_AMOUNT_BASE_UNITS.toString(),
      circulating_supply_base_units: totalMinted.toString(),
      minted_supply_counter_base_units: totalMinted.toString(),
      max_supply_base_units: MAX_SUPPLY_BASE_UNITS.toString(),
      base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),
      current_difficulty_bits: 8,
      current_reward_base_units: REWARD_BASE_UNITS.toString(),
      next_reward_base_units: (REWARD_BASE_UNITS / 2n).toString(),
      next_halving_at_base_units: MAX_SUPPLY_BASE_UNITS.toString(),
      base_units_to_next_halving: (MAX_SUPPLY_BASE_UNITS - totalMinted).toString(),
      halving_index: 0,
      is_capped: false,
      user_count: 2,
    });
    expect(summary.activity).toMatchObject({
      mint_count_1h: 3,
      mint_count_24h: 3,
      minted_base_units_1h: totalMinted.toString(),
      minted_base_units_24h: totalMinted.toString(),
      transfer_count_1h: 1,
      transfer_count_24h: 1,
      transferred_base_units_1h: SEND_AMOUNT_BASE_UNITS.toString(),
      transferred_base_units_24h: SEND_AMOUNT_BASE_UNITS.toString(),
      active_challengers_15m: 1,
      wrap_count_24h: 0,
      wrapped_base_units_24h: '0',
      bound_wallet_count: 0,
    });
    expect(summary.holders.holder_count).toBe(2);
    expect(summary.holders.zero_balance_user_count).toBe(0);
    expect(summary.holders.average_balance_base_units).toBe((totalMinted / 2n).toString());
    expect(summary.holders.top_balances).toEqual([
      { rank: 1, balance_base_units: aBalance.toString() },
      { rank: 2, balance_base_units: bBalance.toString() },
    ]);
    expect(summary.holders.balance_histogram).toEqual([
      {
        bucket: '0.001-0.01',
        min_balance_base_units: '1000000',
        max_balance_base_units: '9999999',
        holder_count: 1,
        total_balance_base_units: bBalance.toString(),
      },
      {
        bucket: '0.01-0.1',
        min_balance_base_units: '10000000',
        max_balance_base_units: '99999999',
        holder_count: 1,
        total_balance_base_units: aBalance.toString(),
      },
    ]);

    const historyRes = await ctx.app.inject({ method: 'GET', url: '/stats/history?window=24h&limit=10' });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.window).toBe('24h');
    expect(history.bucket_seconds).toBe(15 * 60);
    expect(history.rows.length).toBeGreaterThanOrEqual(1);
    const latest = history.rows.at(-1);
    expect(latest).toMatchObject({
      mint_count: 3,
      minted_base_units: totalMinted.toString(),
      total_minted_base_units: totalMinted.toString(),
      transfer_count: 1,
      transferred_base_units: SEND_AMOUNT_BASE_UNITS.toString(),
      total_transferred_base_units: SEND_AMOUNT_BASE_UNITS.toString(),
      circulating_supply_base_units: totalMinted.toString(),
      new_users: 2,
      user_count: 2,
      current_difficulty_bits: 8,
      current_reward_base_units: REWARD_BASE_UNITS.toString(),
      challenges: 3,
      active_challengers: 1,
    });
    expect(latest.holder_count).toBeUndefined();
    expect(latest.balance_histogram).toBeUndefined();
    expect(latest.top_balances).toBeUndefined();

    const allTime = (await ctx.app.inject({ method: 'GET', url: '/stats/history?window=all&limit=10' })).json();
    expect(allTime.window).toBe('all');
    expect(allTime.bucket_seconds).toBe(24 * 60 * 60);
  });

  it('allows configured public origins only on public stats routes', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    const stats = await ctx.app.inject({
      method: 'GET',
      url: '/stats/summary',
      headers: { origin: 'https://stats.example' },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.headers['access-control-allow-origin']).toBe('https://stats.example');
    expect(stats.headers['access-control-allow-credentials']).toBeUndefined();

    const privateRoute = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { origin: 'https://stats.example' },
    });
    expect(privateRoute.statusCode).toBe(401);
    expect(privateRoute.headers['access-control-allow-origin']).toBeUndefined();

    const webOrigin = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { origin: 'http://web.test' },
    });
    expect(webOrigin.statusCode).toBe(401);
    expect(webOrigin.headers['access-control-allow-origin']).toBe('http://web.test');
    expect(webOrigin.headers['access-control-allow-credentials']).toBe('true');
  });
});
