import type { FastifyInstance } from 'fastify';
import { scheduleInfo, BASE_UNITS_PER_RPOW } from '../schedule.js';

const LEDGER_CACHE_MS = 5_000;

export async function ledgerRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [
      { rows: minted },
      { rows: transferred },
      { rows: circulating },
      { rows: users },
      { rows: counter },
    ] = await Promise.all([
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE parent_token_id IS NULL`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE state='VALID'`,
      ),
      app.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users`,
      ),
      app.pool.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
      ),
    ]);

    const totalMintedBaseUnits = BigInt(minted[0]!.n);
    const totalTransferredBaseUnits = BigInt(transferred[0]!.n);
    const circulatingBaseUnits = BigInt(circulating[0]!.n);
    const counterBaseUnits = counter[0] ? BigInt(counter[0].value) : 0n;
    const maxSupplyBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

    const info = scheduleInfo(counterBaseUnits, {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    });

    return {
      total_minted_base_units: totalMintedBaseUnits.toString(),
      total_transferred_base_units: totalTransferredBaseUnits.toString(),
      circulating_supply_base_units: circulatingBaseUnits.toString(),
      minted_supply_counter_base_units: counterBaseUnits.toString(),
      max_supply_base_units: maxSupplyBaseUnits.toString(),
      base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),
      current_difficulty_bits: Math.max(app.config.difficultyFloor, info.currentDifficultyBits),
      current_reward_base_units: info.currentRewardBaseUnits.toString(),
      next_reward_base_units: info.nextRewardBaseUnits.toString(),
      next_halving_at_base_units: info.nextHalvingAtBaseUnits.toString(),
      base_units_to_next_halving: info.baseUnitsToNextHalving.toString(),
      halving_index: info.halvingIndex,
      is_capped: info.isCapped,
      user_count: users[0]!.n,
    };
  }

  app.get('/ledger', async () => {
    if (cached && Date.now() - cached.ts < LEDGER_CACHE_MS) return cached.body;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const body = await refresh();
        cached = { ts: Date.now(), body };
        return body;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  });
}
