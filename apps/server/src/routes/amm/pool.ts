import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

const RPOW_BASE_PER_RPOW = 1_000_000_000n;

export async function poolReadRoutes(app: FastifyInstance) {
  app.get('/amm/pool', async (req, reply) => {
    const poolRes = await app.pool.query<{
      rpow_reserve_base_units: string;
      usdc_reserve_base_units: string;
      total_lp_supply: string;
      fee_bps: number;
      seeded_at: Date;
    }>(
      `SELECT
         rpow_reserve_base_units::text AS rpow_reserve_base_units,
         usdc_reserve_base_units::text AS usdc_reserve_base_units,
         total_lp_supply::text AS total_lp_supply,
         fee_bps,
         seeded_at
       FROM amm_pool WHERE id = 'main'`,
    );
    if (poolRes.rows.length === 0) {
      return reply.code(200).send({ seeded: false });
    }
    const p = poolRes.rows[0];
    const R_rpow = BigInt(p.rpow_reserve_base_units);
    const R_usdc = BigInt(p.usdc_reserve_base_units);

    // Spot price as USDC base units per 1 RPOW (10^9 RPOW base units).
    // spot_price_usdc_per_rpow_e9 = R_usdc * 10^9 / R_rpow (in USDC base units).
    const spotE9 = (R_usdc * RPOW_BASE_PER_RPOW) / R_rpow;

    const body: any = {
      seeded: true,
      reserves: {
        rpow_base_units: p.rpow_reserve_base_units,
        usdc_base_units: p.usdc_reserve_base_units,
      },
      total_lp_supply: p.total_lp_supply,
      fee_bps: p.fee_bps,
      spot_price_usdc_per_rpow_e9: spotE9.toString(),
      seeded_at: p.seeded_at.toISOString(),
    };

    // If authed, include your LP balance.
    const s = readSession(req as any, app.config.sessionSecret);
    if (s) {
      const lpRes = await app.pool.query<{ lp_balance: string }>(
        `SELECT lp_balance::text AS lp_balance FROM amm_lp_balances WHERE account_email = $1`,
        [s.email],
      );
      body.your_lp_balance = lpRes.rows[0]?.lp_balance ?? '0';
    }

    return reply.code(200).send(body);
  });
}
