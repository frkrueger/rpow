import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import * as randomness from '../src/longshot/randomness.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return res.headers['set-cookie'] as string;
}

async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}

describe('POST /api/longshot/spin', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/longshot/spin', payload: { stake_base_units: '100', odds_choice: '1:1' } });
    expect(res.statusCode).toBe(401);
  });

  it('403 if user is not on the allowlist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.longShotAllowedEmails = 'someoneelse@example.com';
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '1:1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ALLOWED');
  });

  it('GET /api/longshot/access reports allowed/denied per allowlist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    let res = await ctx.app.inject({ method: 'GET', url: '/api/longshot/access', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().access).toBe('allowed');
    (ctx.app as any).config.longShotAllowedEmails = 'someoneelse@example.com';
    res = await ctx.app.inject({ method: 'GET', url: '/api/longshot/access', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().access).toBe('denied');
  });

  it('400 on invalid odds_choice', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '5:1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on stake below min', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '5', odds_choice: '1:1' },  // below test min of 10
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('STAKE_OUT_OF_RANGE');
  });

  it('409 on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '1:1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('WIN: mints stake × m to the user, increments minted_supply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: true, hex: 'aabbccddeeff0011' });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '2:1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('WIN');
    expect(body.net_user_change_base_units).toBe('200');
    expect(body.new_balance_base_units).toBe('1200');

    const supply = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'minted_supply'`,
    );
    expect(supply.rows[0].value).toBe('200');
  });

  it('LOSE: invalidates stake worth of user tokens, decrements minted_supply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: false, hex: 'aabbccddeeff0011' });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '1:1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcome).toBe('LOSE');
    expect(body.net_user_change_base_units).toBe('-100');
    expect(body.new_balance_base_units).toBe('900');

    const supply = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'minted_supply'`,
    );
    expect(supply.rows[0].value).toBe('900');
  });

  it('records a long_shot_bets row with signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: true, hex: 'aabbccddeeff0011' });

    await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '10:1' },
    });
    const { rows } = await ctx.pool.query<{ id: string; outcome: string; payout_multiple: number; signature: Buffer }>(
      `SELECT id, outcome, payout_multiple, signature FROM long_shot_bets`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('WIN');
    expect(rows[0].payout_multiple).toBe(10);
    expect(rows[0].signature.length).toBeGreaterThan(0);
  });

  it('updates long_shot_house_pnl_base_units (LOSE → +stake)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: false, hex: 'aabbccddeeff0011' });

    await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '1:1' },
    });
    const pnl = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'long_shot_house_pnl_base_units'`,
    );
    expect(pnl.rows[0].value).toBe('100');
  });
});

describe('GET /api/longshot/history', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/longshot/history' });
    expect(res.statusCode).toBe(401);
  });

  it("returns the user's spins, newest first", async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: false, hex: 'aabbccddeeff0011' });
    for (let i = 0; i < 3; i++) {
      await ctx.app.inject({
        method: 'POST', url: '/api/longshot/spin',
        headers: { cookie, 'content-type': 'application/json' },
        payload: { stake_base_units: '50', odds_choice: '1:1' },
      });
    }
    const res = await ctx.app.inject({ method: 'GET', url: '/api/longshot/history', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.spins).toHaveLength(3);
    expect(body.spins[0].outcome).toBe('LOSE');
  });
});

describe('GET /api/longshot/stats', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns global stats, no auth required', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/longshot/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('total_spins');
    expect(body).toHaveProperty('total_volume_base_units');
    expect(body).toHaveProperty('house_pnl_base_units');
    expect(body.total_spins).toBe(0);
  });
});

describe('POST /api/longshot/spin rate limit', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('429 after 10 spins from the same IP in a minute', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedToken(ctx.pool, 'a@b.com', 100_000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 100000 WHERE name = 'minted_supply'`);
    vi.spyOn(randomness, 'drawSpin').mockReturnValue({ outcome: false, hex: 'aabbccddeeff0011' });

    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await ctx.app.inject({
        method: 'POST', url: '/api/longshot/spin',
        headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
        payload: { stake_base_units: '50', odds_choice: '1:1' },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});
