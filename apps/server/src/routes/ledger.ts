import type { FastifyInstance } from 'fastify';
import { scheduleInfo, BASE_UNITS_PER_RPOW } from '../schedule.js';

// Ledger data is expensive (full-table scans on tokens). Cache aggressively
// since this is a read-only dashboard endpoint — 60s staleness is fine.
const LEDGER_CACHE_MS = 60_000;

export async function ledgerRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [
      { rows: transferred },
      { rows: circulating },
      { rows: wrapped },
      { rows: users },
      { rows: counter },
    ] = await Promise.all([
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE state='VALID'`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE state='WRAPPED'`,
      ),
      app.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users`,
      ),
      app.pool.query<{ value: string }>(
        `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
      ),
    ]);

    const counterBaseUnits = counter[0] ? BigInt(counter[0].value) : 0n;
    const totalMintedBaseUnits = counterBaseUnits;
    const totalTransferredBaseUnits = BigInt(transferred[0]!.n);
    const circulatingBaseUnits = BigInt(circulating[0]!.n);
    const wrappedBaseUnits = BigInt(wrapped[0]!.n);
    const maxSupplyBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

    const info = scheduleInfo(counterBaseUnits, {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    });

    return {
      total_minted_base_units: totalMintedBaseUnits.toString(),
      total_transferred_base_units: totalTransferredBaseUnits.toString(),
      circulating_supply_base_units: circulatingBaseUnits.toString(),
      wrapped_supply_base_units: wrappedBaseUnits.toString(),
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

  // Background warmup: each worker refreshes its cache in the background every
  // 30s so user requests never block on the cold-cache aggregate-sum queries
  // (each refresh hits the tokens table, which is ~50M rows on prod). Without
  // this, a cluster of N workers means 1/N of requests hit cold cache and
  // wait 5–20s — visible as flaky /ledger latency.
  //
  // The proper long-term fix is to maintain `circulating_supply_base_units`
  // and `wrapped_supply_base_units` counters in `app_counters` instead of
  // re-summing the tokens table — that makes /ledger O(1). For now, this
  // warmup is the surgical patch.
  if (process.env.NODE_ENV !== 'test') {
    refresh()
      .then((body) => { cached = { ts: Date.now(), body }; })
      .catch(() => { /* swallow — next user request will retry */ });
    const warmupTimer = setInterval(() => {
      // Re-entrancy guard: skip this tick if a previous refresh is still
      // running. Without this, slow SUM(tokens) queries (30M+ rows) under
      // heavy load pile up — N workers × M unfinished refreshes consumed
      // 54+ pool connections at peak and starved /send. Reuse the same
      // `inflight` slot the user-request path uses, so user requests and
      // warmup ticks dedupe against each other.
      if (inflight) return;
      inflight = (async () => {
        try {
          const body = await refresh();
          cached = { ts: Date.now(), body };
          return body;
        } finally {
          inflight = null;
        }
      })();
      inflight.catch(() => { /* swallow — next user/timer will retry */ });
    }, 30_000);
    app.addHook('onClose', async () => { clearInterval(warmupTimer); });
  }
}
