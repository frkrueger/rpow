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
