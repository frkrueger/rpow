import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email = 'a@b.com'): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return r.headers['set-cookie'] as string;
}

// In test config, mintMaxSupply = 21 RPOW => cap in base units = 21 * 10^9.
const ONE_RPOW = 1_000_000_000n;
const CAP_BASE_UNITS = 21n * ONE_RPOW;

// Set app_counters.minted_supply directly. /challenge reads supply from there
// (cached for 5s) to fail-fast at the cap.
async function setMintedSupplyBaseUnits(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  baseUnits: bigint,
) {
  await ctx.pool.query(
    `UPDATE app_counters SET value = $1::bigint WHERE name='minted_supply'`,
    [baseUnits.toString()],
  );
}

describe('POST /challenge', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('issues a challenge to a logged-in user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.nonce_prefix).toMatch(/^[0-9a-f]+$/);
    expect(body.difficulty_bits).toBe(8);
  });

  it('rejects unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge' });
    expect(res.statusCode).toBe(401);
  });

  it('stamps the configured difficulty regardless of supply (halving model has fixed difficulty)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx);
    // Try at supply=0, then at supply=10 RPOW. Difficulty is constant in the
    // halving schedule.
    const a = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    expect(a.difficulty_bits).toBe(8);
    await setMintedSupplyBaseUnits(ctx, 10n * ONE_RPOW);
    const b = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    expect(b.difficulty_bits).toBe(8);
  });

  it('refuses with 410 SUPPLY_EXHAUSTED at cap', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx);
    // Set minted_supply to the test cap (21 RPOW = 21 * 10^9 base units).
    await setMintedSupplyBaseUnits(ctx, CAP_BASE_UNITS);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
  });
});
