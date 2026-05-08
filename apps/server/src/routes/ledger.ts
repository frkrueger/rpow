import type { FastifyInstance } from 'fastify';
import { difficultyBitsForSupply, scheduleInfo, BASE_UNITS_PER_RPOW } from '../schedule.js';

// /ledger is polled aggressively by every active client (mining UI refresh,
// status bar). Each call does 4 full-table scans on tokens (no suitable
// index for these aggregates). Without coalescing, thousands of concurrent
// pollers melt the DB.
//
// Cache the response for LEDGER_CACHE_MS and coalesce concurrent refreshes
// behind a single in-flight promise. ~5s staleness is invisible in a ledger
// view.
//
// NOTE: this route is a temporary compile-fix shim after the halving switch.
// Halving Task 4 will rework /ledger to expose halving-schedule fields
// (current reward, next halving boundary, halving index, etc) in base units.
// Until then we map the new schedule API back to the old field names so the
// existing frontend doesn't 500.
const LEDGER_CACHE_MS = 5_000;

export async function ledgerRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [{ rows: minted }, { rows: transferred }, { rows: circ }, { rows: users }] = await Promise.all([
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL`),
      app.pool.query<{ n: number }>(`SELECT coalesce(sum(amount),0)::int AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE state='VALID'`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
    ]);
    const totalMinted = minted[0]!.n;
    const opts = {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    };
    // Approximate base-unit minted supply from the row count; Task 4 will
    // read app_counters.minted_supply directly (authoritative bigint).
    const approxMintedBaseUnits = BigInt(totalMinted) * BASE_UNITS_PER_RPOW;
    const scheduledBits = difficultyBitsForSupply(approxMintedBaseUnits, opts);
    const currentDifficultyBits = Math.max(app.config.difficultyFloor, scheduledBits);
    const info = scheduleInfo(approxMintedBaseUnits, opts);
    return {
      total_minted: totalMinted,
      total_transferred: transferred[0]!.n,
      circulating_supply: circ[0]!.n,
      current_difficulty_bits: currentDifficultyBits,
      user_count: users[0]!.n,
      max_supply: app.config.mintMaxSupply,
      epoch: info.halvingIndex,
      next_milestone_at: Number(info.nextHalvingAtBaseUnits / BASE_UNITS_PER_RPOW),
      coins_until_next_milestone: Number(info.baseUnitsToNextHalving / BASE_UNITS_PER_RPOW),
      next_difficulty_bits: currentDifficultyBits,
      is_capped: info.isCapped,
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
