import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

// Test fixture (see helpers.ts):
//   difficultyBits=8, difficultyFloor=4, mintMaxSupply=21 (RPOW).
// 1 RPOW = 1_000_000_000 base units. The 21-RPOW test cap is far below the
// 9M RPOW schedule offset, so the schedule stays in epoch 0: halving_index=0,
// current_reward = 1_000_000 (= 0.001 RPOW), and next_halving_at_base_units
// is clamped to the maxSupply (21 * 1e9).

const RPOW = 1_000_000_000n;
const MAX_SUPPLY_BU = 21n * RPOW;

describe('GET /ledger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('public, no auth, returns counters and schedule info in base units', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/ledger' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      total_minted_base_units: '0',
      total_transferred_base_units: '0',
      circulating_supply_base_units: '0',
      minted_supply_counter_base_units: '0',
      max_supply_base_units: MAX_SUPPLY_BU.toString(),
      base_units_per_rpow: RPOW.toString(),
      // difficultyBits=8 from fixture, well above the floor=4
      current_difficulty_bits: 8,
      // initial reward: 0.001 RPOW = 1_000_000 base units; halves at next milestone
      current_reward_base_units: '1000000',
      next_reward_base_units: '500000',
      // halving boundary clamped to maxSupply (21 RPOW)
      next_halving_at_base_units: MAX_SUPPLY_BU.toString(),
      base_units_to_next_halving: MAX_SUPPLY_BU.toString(),
      halving_index: 0,
      is_capped: false,
      user_count: 0,
    });
  });

  it('reports growing supply as tokens + counter are seeded', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { randomUUID } = await import('node:crypto');
    // Seed 12 root tokens at 1 RPOW each (= 12 * 1e9 base units of supply).
    for (let i = 0; i < 12; i++) {
      await ctx.pool.query(
        `INSERT INTO tokens(id, owner_email, value, state, server_sig)
         VALUES ($1, $2, $3, 'VALID', '\\x00')`,
        [randomUUID(), `seed-${i}@x.com`, RPOW.toString()],
      );
    }
    // Keep the maintained counter in sync with the seeded supply (server's
    // /mint path increments this; tests inject directly so we mirror it).
    await ctx.pool.query(
      `UPDATE app_counters SET value = $1 WHERE name = 'minted_supply'`,
      [(12n * RPOW).toString()],
    );

    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.total_minted_base_units).toBe((12n * RPOW).toString());
    expect(body.circulating_supply_base_units).toBe((12n * RPOW).toString());
    expect(body.minted_supply_counter_base_units).toBe((12n * RPOW).toString());
    // 12 RPOW supply is still inside phase 0 (1M-RPOW halving interval).
    expect(body.halving_index).toBe(0);
    expect(body.current_reward_base_units).toBe('7812500');
    expect(body.current_difficulty_bits).toBe(8);
    // 21 - 12 = 9 RPOW remaining until the (clamped) next halving = the cap
    expect(body.base_units_to_next_halving).toBe((9n * RPOW).toString());
    expect(body.next_halving_at_base_units).toBe(MAX_SUPPLY_BU.toString());
    expect(body.is_capped).toBe(false);
  });

  it('reports is_capped at maxSupply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { randomUUID } = await import('node:crypto');
    for (let i = 0; i < 21; i++) {
      await ctx.pool.query(
        `INSERT INTO tokens(id, owner_email, value, state, server_sig)
         VALUES ($1, $2, $3, 'VALID', '\\x00')`,
        [randomUUID(), `seed-${i}@x.com`, RPOW.toString()],
      );
    }
    await ctx.pool.query(
      `UPDATE app_counters SET value = $1 WHERE name = 'minted_supply'`,
      [MAX_SUPPLY_BU.toString()],
    );

    const body = (await ctx.app.inject({ method: 'GET', url: '/ledger' })).json();
    expect(body.total_minted_base_units).toBe(MAX_SUPPLY_BU.toString());
    expect(body.minted_supply_counter_base_units).toBe(MAX_SUPPLY_BU.toString());
    expect(body.is_capped).toBe(true);
    expect(body.base_units_to_next_halving).toBe('0');
  });
});
