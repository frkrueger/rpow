import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { isqrt } from '../../amm/math.js';
import { isAmmAdmin } from './allowlist.js';

const MIN_LIQUIDITY = 1000n;

const Body = z.object({
  rpow_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
  usdc_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
});

export async function seedRoutes(app: FastifyInstance) {
  app.post('/amm/seed', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!isAmmAdmin(app, s.email)) {
      return reply.code(403).send({ error: 'NOT_ADMIN', message: 'AMM admin access required' });
    }

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const rpow = BigInt(parsed.data.rpow_base_units);
    const usdc = BigInt(parsed.data.usdc_base_units);

    const initialLp = isqrt(rpow * usdc);
    if (initialLp <= MIN_LIQUIDITY) {
      return reply.code(400).send({ error: 'INVALID_AMOUNT', message: `seed too small; isqrt(rpow*usdc)=${initialLp} must be > ${MIN_LIQUIDITY}` });
    }

    type SeedResult =
      | { ok: true; initialLp: bigint; totalLp: bigint }
      | { error: string; message: string; status: number };

    let result: SeedResult;
    try {
      result = await withTx<SeedResult>(app.pool, async (c) => {
        // Lock: ensure no concurrent seed. Using SELECT … FOR UPDATE on a row
        // that doesn't exist is a no-op; rely on the INSERT failing on the PK
        // collision if a race occurs (caught below).
        const exists = await c.query(`SELECT 1 FROM amm_pool WHERE id='main'`);
        if ((exists.rowCount ?? 0) > 0) {
          return { error: 'POOL_ALREADY_SEEDED', message: 'pool is already seeded', status: 409 };
        }

        // Check + debit admin's USDC.
        const userRes = await c.query<{ usdc_base_units: string }>(
          `SELECT usdc_base_units::text AS usdc_base_units FROM users WHERE email = $1 FOR UPDATE`,
          [s.email],
        );
        if (userRes.rows.length === 0 || BigInt(userRes.rows[0].usdc_base_units) < usdc) {
          return { error: 'INSUFFICIENT_USDC', message: 'not enough USDC', status: 400 };
        }
        await c.query(
          `UPDATE users SET usdc_base_units = usdc_base_units - $1::bigint WHERE email = $2`,
          [usdc.toString(), s.email],
        );

        // Burn admin's RPOW. burnFromUser throws INSUFFICIENT_BALANCE if short.
        await burnFromUser(c, s.email, rpow, app.config.signingPrivateKeyHex);

        // Decrement minted_supply by the burned RPOW (same convention as
        // trivia/gladiator seeding — the RPOW is "escrowed" in the pool
        // and not counted as in-user-balance circulation).
        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
          [rpow.toString()],
        );

        // Insert pool + LP rows.
        await c.query(
          `INSERT INTO amm_pool(id, rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply, fee_bps, seeded_at)
           VALUES ('main', $1, $2, $3, 30, now())`,
          [rpow.toString(), usdc.toString(), initialLp.toString()],
        );

        const adminLp = initialLp - MIN_LIQUIDITY;
        await c.query(
          `INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ($1, $2)`,
          [s.email, adminLp.toString()],
        );

        return { ok: true, initialLp: adminLp, totalLp: initialLp };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough RPOW' });
      }
      // Unique PK violation if a race seeded under us.
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'POOL_ALREADY_SEEDED', message: 'pool seeded by concurrent request' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }
    return reply.code(200).send({
      initial_lp: result.initialLp.toString(),
      total_lp: result.totalLp.toString(),
    });
  });
}
