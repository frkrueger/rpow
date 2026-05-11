import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { signLpEventPayload, type LpEventPayload } from '../../signing.js';
import { isAllowed, readTermsAcceptedAt } from './allowlist.js';

const AddBody = z.object({
  rpow_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
  usdc_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
  min_lp_out: z.string().regex(/^[0-9]{1,19}$/, 'non-negative bigint as string'),
});

function bmin(a: bigint, b: bigint): bigint { return a < b ? a : b; }

export async function lpRoutes(app: FastifyInstance) {
  app.post('/amm/lp/add', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!isAllowed(app.config.ammAllowedEmails, s.email)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'AMM access not enabled' });
    }
    const accepted = await readTermsAcceptedAt(app, s.email);
    if (!accepted) {
      return reply.code(403).send({ error: 'TERMS_NOT_ACCEPTED', message: 'must accept AMM terms first' });
    }

    const parsed = AddBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const rpowIn = BigInt(parsed.data.rpow_base_units);
    const usdcIn = BigInt(parsed.data.usdc_base_units);
    const minLpOut = BigInt(parsed.data.min_lp_out);

    type R =
      | { ok: true; lpMinted: bigint; rpowUsed: bigint; usdcUsed: bigint; rpowRefunded: bigint; usdcRefunded: bigint; eventId: string; signature: Buffer; createdAt: Date }
      | { error: string; message: string; status: number };

    let result: R;
    try {
      result = await withTx<R>(app.pool, async (c) => {
        const poolRes = await c.query<{
          rpow_reserve_base_units: string;
          usdc_reserve_base_units: string;
          total_lp_supply: string;
        }>(
          `SELECT rpow_reserve_base_units::text AS rpow_reserve_base_units,
                  usdc_reserve_base_units::text AS usdc_reserve_base_units,
                  total_lp_supply::text AS total_lp_supply
           FROM amm_pool WHERE id='main' FOR UPDATE`,
        );
        if (poolRes.rows.length === 0) {
          return { error: 'POOL_NOT_SEEDED', message: 'pool not seeded', status: 503 };
        }
        const R_rpow = BigInt(poolRes.rows[0].rpow_reserve_base_units);
        const R_usdc = BigInt(poolRes.rows[0].usdc_reserve_base_units);
        const totalLp = BigInt(poolRes.rows[0].total_lp_supply);

        // LP minted = min of side-proportional shares.
        const lpFromRpow = (rpowIn * totalLp) / R_rpow;
        const lpFromUsdc = (usdcIn * totalLp) / R_usdc;
        const lpMinted = bmin(lpFromRpow, lpFromUsdc);
        if (lpMinted <= 0n || lpMinted < minLpOut) {
          return { error: 'SLIPPAGE_EXCEEDED', message: `lpMinted ${lpMinted} < min_lp_out ${minLpOut}`, status: 400 };
        }

        // Side amounts actually used.
        const rpowUsed = (lpMinted * R_rpow) / totalLp;
        const usdcUsed = (lpMinted * R_usdc) / totalLp;
        const rpowRefunded = rpowIn - rpowUsed;
        const usdcRefunded = usdcIn - usdcUsed;

        // Check USDC balance + debit.
        const userRes = await c.query<{ usdc_base_units: string }>(
          `SELECT usdc_base_units::text AS usdc_base_units FROM users WHERE email = $1 FOR UPDATE`,
          [s.email],
        );
        if (userRes.rows.length === 0 || BigInt(userRes.rows[0].usdc_base_units) < usdcUsed) {
          return { error: 'INSUFFICIENT_USDC', message: 'not enough USDC', status: 400 };
        }
        if (usdcUsed > 0n) {
          await c.query(
            `UPDATE users SET usdc_base_units = usdc_base_units - $1::bigint WHERE email = $2`,
            [usdcUsed.toString(), s.email],
          );
        }

        // Burn RPOW used (only the portion actually consumed).
        if (rpowUsed > 0n) {
          await burnFromUser(c, s.email, rpowUsed, app.config.signingPrivateKeyHex);
        }

        // Update pool reserves + total_lp.
        const newR_rpow = R_rpow + rpowUsed;
        const newR_usdc = R_usdc + usdcUsed;
        const newTotalLp = totalLp + lpMinted;
        await c.query(
          `UPDATE amm_pool SET rpow_reserve_base_units = $1::bigint, usdc_reserve_base_units = $2::bigint, total_lp_supply = $3::bigint WHERE id='main'`,
          [newR_rpow.toString(), newR_usdc.toString(), newTotalLp.toString()],
        );

        // Upsert LP balance.
        await c.query(
          `INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ($1, $2::bigint)
           ON CONFLICT (account_email) DO UPDATE SET lp_balance = amm_lp_balances.lp_balance + EXCLUDED.lp_balance`,
          [s.email, lpMinted.toString()],
        );

        // Audit row.
        const eventId = randomUUID();
        const createdAt = new Date();
        const payload: LpEventPayload = {
          id: eventId,
          account_email_hash: createHash('sha256').update(s.email).digest('hex'),
          type: 'ADD',
          rpow_delta_base_units: -rpowUsed,  // caller loses RPOW
          usdc_delta_base_units: -usdcUsed,  // caller loses USDC
          lp_delta_base_units: lpMinted,     // caller gains LP
          pool_rpow_after: newR_rpow,
          pool_usdc_after: newR_usdc,
          total_lp_after: newTotalLp,
          created_at: createdAt.toISOString(),
        };
        const signature = signLpEventPayload(payload, app.config.signingPrivateKeyHex);
        await c.query(
          `INSERT INTO amm_lp_events(id, account_email, type, rpow_delta_base_units, usdc_delta_base_units, lp_delta_base_units, pool_rpow_after, pool_usdc_after, total_lp_after, signature, created_at)
           VALUES($1, $2, 'ADD', $3, $4, $5, $6, $7, $8, $9, $10)`,
          [eventId, s.email, (-rpowUsed).toString(), (-usdcUsed).toString(), lpMinted.toString(), newR_rpow.toString(), newR_usdc.toString(), newTotalLp.toString(), signature, createdAt],
        );

        return { ok: true, lpMinted, rpowUsed, usdcUsed, rpowRefunded, usdcRefunded, eventId, signature, createdAt };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough RPOW' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      event_id: result.eventId,
      lp_minted: result.lpMinted.toString(),
      rpow_used: result.rpowUsed.toString(),
      usdc_used: result.usdcUsed.toString(),
      rpow_refunded: result.rpowRefunded.toString(),
      usdc_refunded: result.usdcRefunded.toString(),
      signature_hex: result.signature.toString('hex'),
      server_time: result.createdAt.toISOString(),
    });
  });
}
