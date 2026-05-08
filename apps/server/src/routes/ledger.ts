import type { FastifyInstance } from 'fastify';
import { difficultyForSupply, epochInfo } from '../schedule.js';

// /ledger is polled aggressively by every active client (mining UI refresh,
// status bar). Each call does 4 full-table scans on tokens (no suitable
// index for these aggregates). Without coalescing, thousands of concurrent
// pollers melt the DB.
//
// Cache the response for LEDGER_CACHE_MS and coalesce concurrent refreshes
// behind a single in-flight promise. ~5s staleness is invisible in a ledger
// view.
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
      baseBits: app.config.difficultyBits,
      epochSize: app.config.mintEpochSize,
      maxSupply: app.config.mintMaxSupply,
    };
    const scheduledBits = difficultyForSupply(totalMinted, opts);
    const currentDifficultyBits = Math.max(app.config.difficultyFloor, scheduledBits);
    const info = epochInfo(totalMinted, opts);
    return {
      total_minted: totalMinted,
      total_transferred: transferred[0]!.n,
      circulating_supply: circ[0]!.n,
      current_difficulty_bits: currentDifficultyBits,
      user_count: users[0]!.n,
      max_supply: app.config.mintMaxSupply,
      epoch: info.epoch,
      epoch_size: app.config.mintEpochSize,
      next_milestone_at: info.nextMilestoneAt,
      coins_until_next_milestone: info.coinsToNext,
      next_difficulty_bits: info.nextDifficultyBits,
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
