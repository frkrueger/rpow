import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { isAmmAdmin } from './allowlist.js';

const CreditBody = z.object({
  email: z.string().email(),
  amount_base_units: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
});

export async function adminRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------
  // POST /amm/admin/credit-usdc { email, amount_base_units }
  //
  // Admin-only escape hatch for alpha testing. Credits USDC directly to a
  // user's database balance without going through Solana. Shipped in slice 1
  // so the AMM math can be tested before the real deposit indexer (slice 5).
  //
  // This endpoint is INTENTIONALLY not allowlist-gated for the recipient —
  // an admin can credit any user, including users who haven't accepted the
  // terms yet. (Useful for seeding test scenarios.)
  // ---------------------------------------------------------------
  app.post('/amm/admin/credit-usdc', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    if (!isAmmAdmin(app, s.email)) {
      return reply.code(403).send({ error: 'NOT_ADMIN', message: 'AMM admin access required' });
    }

    const parsed = CreditBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const targetEmail = parsed.data.email.toLowerCase().trim();
    const amount = BigInt(parsed.data.amount_base_units);

    // Ensure the target user row exists; auto-create on the fly to mirror the
    // /send and gladiator behaviors where any signed-in email can be credited.
    await app.pool.query(
      `INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [targetEmail],
    );

    // Hard system-wide USDC cap. Refuses credits that would push the total
    // (user balances + pool reserve) over AMM_USDC_POOL_CAP_BASE_UNITS.
    // Bounds worst-case hot-wallet loss for the alpha.
    //
    // We sum user balances first, then add the pool reserve only when the
    // amm_pool table exists (it's created in slice 2 Task 1). We cannot use
    // a SQL CASE WHEN to_regclass(...) IS NULL THEN 0 ELSE (SELECT FROM
    // amm_pool ...) END because PostgreSQL resolves all table references at
    // parse/plan time regardless of runtime CASE branches.
    const userTotalRes = await app.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(usdc_base_units), 0)::text AS total FROM users`,
    );
    let currentTotal = BigInt(userTotalRes.rows[0].total);

    // Add pool reserve if the amm_pool table exists yet.
    const tableExistsRes = await app.pool.query<{ oid: string | null }>(
      `SELECT to_regclass('amm_pool')::text AS oid`,
    );
    if (tableExistsRes.rows[0].oid !== null) {
      const poolRes = await app.pool.query<{ reserve: string }>(
        `SELECT COALESCE(usdc_reserve_base_units, 0)::text AS reserve FROM amm_pool WHERE id = 'main'`,
      );
      if (poolRes.rows.length > 0) {
        currentTotal += BigInt(poolRes.rows[0].reserve);
      }
    }
    const cap = BigInt(app.config.ammUsdcPoolCapBaseUnits);
    if (currentTotal + amount > cap) {
      return reply.code(409).send({
        error: 'USDC_POOL_CAP_EXCEEDED',
        message: `system-wide USDC cap is ${cap} base units; current ${currentTotal}, would add ${amount}`,
      });
    }

    const res = await app.pool.query<{ usdc_base_units: string }>(
      `UPDATE users
       SET usdc_base_units = usdc_base_units + $1::bigint
       WHERE email = $2
       RETURNING usdc_base_units::text`,
      [amount.toString(), targetEmail],
    );

    return reply.code(200).send({
      email: targetEmail,
      new_balance_base_units: res.rows[0].usdc_base_units,
    });
  });
}
