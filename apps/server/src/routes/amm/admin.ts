import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
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
    const cap = BigInt(app.config.ammUsdcPoolCapBaseUnits);

    // Atomic cap-check + credit. The advisory lock serializes all concurrent
    // admin credits so two requests cannot both read the same currentTotal,
    // both pass the cap check, and both commit (TOCTOU race).
    //
    // pg_advisory_xact_lock is transaction-scoped: released automatically at
    // COMMIT or ROLLBACK. All callers contending on 'amm_credit' queue here.
    type TxResult =
      | { ok: true; newBalance: string }
      | { error: string; message: string; status: number };

    let txResult: TxResult;
    try {
      txResult = await withTx<TxResult>(app.pool, async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('amm_credit'))`);

        // Ensure the target user row exists inside the transaction so that
        // subsequent FOR UPDATE / UPDATE operate on a real row.
        await c.query(
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
        const userTotalRes = await c.query<{ total: string }>(
          `SELECT COALESCE(SUM(usdc_base_units), 0)::text AS total FROM users`,
        );
        let currentTotal = BigInt(userTotalRes.rows[0].total);

        // Add pool reserve if the amm_pool table exists yet.
        const tableExistsRes = await c.query<{ oid: string | null }>(
          `SELECT to_regclass('amm_pool')::text AS oid`,
        );
        if (tableExistsRes.rows[0].oid !== null) {
          const poolRes = await c.query<{ reserve: string }>(
            `SELECT COALESCE(usdc_reserve_base_units, 0)::text AS reserve FROM amm_pool WHERE id = 'main'`,
          );
          if (poolRes.rows.length > 0) {
            currentTotal += BigInt(poolRes.rows[0].reserve);
          }
        }

        if (currentTotal + amount > cap) {
          return {
            error: 'USDC_POOL_CAP_EXCEEDED',
            message: `system-wide USDC cap is ${cap} base units; current ${currentTotal}, would add ${amount}`,
            status: 409,
          };
        }

        const res = await c.query<{ usdc_base_units: string }>(
          `UPDATE users
           SET usdc_base_units = usdc_base_units + $1::bigint
           WHERE email = $2
           RETURNING usdc_base_units::text`,
          [amount.toString(), targetEmail],
        );

        return { ok: true, newBalance: res.rows[0].usdc_base_units };
      });
    } catch (e) {
      throw e;
    }

    if ('error' in txResult) {
      return reply.code(txResult.status).send({ error: txResult.error, message: txResult.message });
    }

    return reply.code(200).send({
      email: targetEmail,
      new_balance_base_units: txResult.newBalance,
    });
  });

  // ---------------------------------------------------------------
  // POST /amm/admin/claim-unattributed { solana_signature, target_email }
  //
  // Atomically promotes a usdc_unattributed_deposits row into usdc_deposits,
  // credits the target user's balance, and stamps claimed_by_email + claimed_at
  // on the audit row (row is preserved, not deleted).
  //
  // Idempotency: a second call with the same signature returns 409 ALREADY_CLAIMED.
  // ---------------------------------------------------------------
  app.post('/amm/admin/claim-unattributed', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    if (!isAmmAdmin(app, s.email)) return reply.code(403).send({ error: 'NOT_ADMIN' });

    const body = req.body as { solana_signature?: string; target_email?: string };
    if (!body?.solana_signature || !body?.target_email) {
      return reply.code(400).send({ error: 'BAD_REQUEST' });
    }

    try {
      const result = await withTx(app.pool, async (c) => {
        const u = await c.query<{
          id: string; amount_base_units: string; sender_pubkey: string; block_time: Date | null;
          claimed_by_email: string | null;
        }>(
          `SELECT id, amount_base_units::text, sender_pubkey, block_time, claimed_by_email
             FROM usdc_unattributed_deposits
            WHERE solana_signature = $1
            FOR UPDATE`,
          [body.solana_signature],
        );
        if (u.rows.length === 0) throw new Error('NOT_FOUND');
        if (u.rows[0].claimed_by_email) throw new Error('ALREADY_CLAIMED');

        // Verify target user exists.
        const user = await c.query(`SELECT 1 FROM users WHERE email = $1`, [body.target_email]);
        if (user.rows.length === 0) throw new Error('USER_NOT_FOUND');

        const row = u.rows[0];
        await c.query(`
          INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey, block_time)
          VALUES ($1, $2, $3, $4, $5)
        `, [body.target_email, row.amount_base_units, body.solana_signature, row.sender_pubkey, row.block_time]);
        await c.query(
          `UPDATE users SET usdc_base_units = usdc_base_units + $1 WHERE email = $2`,
          [row.amount_base_units, body.target_email],
        );
        await c.query(
          `UPDATE usdc_unattributed_deposits SET claimed_by_email = $1, claimed_at = now() WHERE id = $2`,
          [body.target_email, row.id],
        );
        return { credited_email: body.target_email!, amount_base_units: row.amount_base_units };
      });
      reply.code(200).send(result);
    } catch (e: any) {
      if (e.message === 'NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
      if (e.message === 'ALREADY_CLAIMED') return reply.code(409).send({ error: 'ALREADY_CLAIMED' });
      if (e.message === 'USER_NOT_FOUND') return reply.code(404).send({ error: 'USER_NOT_FOUND' });
      throw e;
    }
  });
}
