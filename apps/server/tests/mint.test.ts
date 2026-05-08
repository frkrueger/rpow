import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

// In the halving schedule with test config (mintMaxSupply=21 RPOW), one mint
// always credits MINT_BASE_REWARD_BASE_UNITS = 7,812,500 base units (the cap is
// reached far before the first 1M-RPOW halving boundary).
const REWARD_BASE_UNITS = 7_812_500n;
const ONE_RPOW = 1_000_000_000n;
const CAP_BASE_UNITS = 21n * ONE_RPOW;            // = 21,000,000,000

async function loginAndChallenge(ctx: Awaited<ReturnType<typeof makeTestApp>>) {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  const cookie = r.headers['set-cookie'] as string;
  const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
  return { cookie, ch };
}

// Set app_counters.minted_supply directly to a base-unit value.
async function setMintedSupplyBaseUnits(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  baseUnits: bigint,
) {
  await ctx.pool.query(
    `UPDATE app_counters SET value = $1::bigint WHERE name='minted_supply'`,
    [baseUnits.toString()],
  );
}

describe('POST /mint', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits a token on a valid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.value_base_units).toBe(REWARD_BASE_UNITS.toString());
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.balance_base_units).toBe(REWARD_BASE_UNITS.toString());
    expect(me.minted_base_units).toBe(REWARD_BASE_UNITS.toString());
  });

  it('rejects invalid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SOLUTION');
  });

  it('rejects double-claim of same challenge', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const first = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('CHALLENGE_ALREADY_CLAIMED');
  });

  it('refuses with 410 SUPPLY_EXHAUSTED when cap is reached between challenge and mint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    // Challenge was issued at supply=0. Now race the cap by setting minted_supply
    // straight to the test cap (21 RPOW = 21 * 10^9 base units).
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
  });

  it('serializes concurrent mints at the cap boundary so only one succeeds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Pre-set minted_supply to (cap - 1 reward) base units so exactly one mint
    // can fit before the cap is hit. Fire 5 concurrent mints; expect 1 success
    // and 4 SUPPLY_EXHAUSTED.
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS - REWARD_BASE_UNITS);

    const cookies: string[] = [];
    const challenges: Array<{ challenge_id: string; nonce_prefix: string; difficulty_bits: number }> = [];
    for (let i = 0; i < 5; i++) {
      const email = `racer-${i}@x.com`;
      await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
      const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
      const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
      const cookie = r.headers['set-cookie'] as string;
      cookies.push(cookie);
      const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
      challenges.push(ch);
    }

    // Pre-mine all 5 nonces (all challenges were stamped at the same difficulty
    // since difficulty is fixed in the halving model, so all are valid).
    const nonces = challenges.map(ch =>
      findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits)
    );

    const results = await Promise.all(
      challenges.map((ch, i) =>
        ctx.app.inject({
          method: 'POST', url: '/mint',
          headers: { cookie: cookies[i], 'content-type': 'application/json' },
          payload: { challenge_id: ch.challenge_id, solution_nonce: nonces[i].toString() },
        }),
      ),
    );

    const successes = results.filter(r => r.statusCode === 200);
    const exhausted = results.filter(r => r.statusCode === 410 && r.json().error === 'SUPPLY_EXHAUSTED');
    expect(successes.length).toBe(1);
    expect(exhausted.length).toBe(4);
  });
});
