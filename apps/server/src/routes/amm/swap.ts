import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { signSwapPayload, signTokenPayload, type SwapPayload } from '../../signing.js';
import { computeSwapOutput, computeFeeIn } from '../../amm/math.js';
import { isAllowed, readTermsAcceptedAt } from './allowlist.js';

const BuyBody = z.object({
  usdc_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
  min_rpow_out: z.string().regex(/^[0-9]{1,19}$/, 'non-negative bigint as string'),
});

const SellBody = z.object({
  rpow_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string'),
  min_usdc_out: z.string().regex(/^[0-9]{1,19}$/, 'non-negative bigint as string'),
});

export async function swapRoutes(app: FastifyInstance) {
  app.post('/amm/buy', async (req, reply) => {
    return handleSwap(req, reply, app, 'BUY');
  });

  app.post('/amm/sell', async (req, reply) => {
    return handleSwap(req, reply, app, 'SELL');
  });
}

async function handleSwap(req: any, reply: any, app: FastifyInstance, direction: 'BUY' | 'SELL') {
  // 1. Auth + allowlist + terms.
  const s = readSession(req, app.config.sessionSecret);
  if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
  if (!isAllowed(app.config.ammAllowedEmails, s.email)) {
    return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'AMM access not enabled for your account' });
  }
  const accepted = await readTermsAcceptedAt(app, s.email);
  if (!accepted) {
    return reply.code(403).send({ error: 'TERMS_NOT_ACCEPTED', message: 'you must accept the AMM terms first' });
  }

  // 2. Body parse.
  let amountIn: bigint;
  let minOut: bigint;
  if (direction === 'BUY') {
    const parsed = BuyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    amountIn = BigInt(parsed.data.usdc_base_units);
    minOut = BigInt(parsed.data.min_rpow_out);
  } else {
    const parsed = SellBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    amountIn = BigInt(parsed.data.rpow_base_units);
    minOut = BigInt(parsed.data.min_usdc_out);
  }

  type Result =
    | { ok: true; swapId: string; output: bigint; fee: bigint; signature: Buffer; createdAt: Date }
    | { error: string; message: string; status: number };

  let result: Result;
  try {
    result = await withTx<Result>(app.pool, async (c) => {
      // Lock the pool row first — serializes all concurrent swaps.
      const poolRes = await c.query<{
        rpow_reserve_base_units: string;
        usdc_reserve_base_units: string;
        fee_bps: number;
      }>(
        `SELECT rpow_reserve_base_units::text AS rpow_reserve_base_units,
                usdc_reserve_base_units::text AS usdc_reserve_base_units,
                fee_bps
         FROM amm_pool WHERE id = 'main' FOR UPDATE`,
      );
      if (poolRes.rows.length === 0) {
        return { error: 'POOL_NOT_SEEDED', message: 'pool not seeded', status: 503 };
      }
      const oldRpow = BigInt(poolRes.rows[0].rpow_reserve_base_units);
      const oldUsdc = BigInt(poolRes.rows[0].usdc_reserve_base_units);

      // Compute output via constant-product math.
      const reserveIn = direction === 'BUY' ? oldUsdc : oldRpow;
      const reserveOut = direction === 'BUY' ? oldRpow : oldUsdc;
      const output = computeSwapOutput({ reserveIn, reserveOut, amountIn });

      if (output <= 0n || output < minOut) {
        return { error: 'SLIPPAGE_EXCEEDED', message: `output ${output} < min_out ${minOut}`, status: 400 };
      }
      // Defensive: never let a swap drain the output reserve entirely.
      if (output >= reserveOut) {
        return { error: 'SLIPPAGE_EXCEEDED', message: 'swap would drain output reserve', status: 400 };
      }

      const fee = computeFeeIn(amountIn);

      let newRpow: bigint;
      let newUsdc: bigint;
      let rpowDelta: bigint; // signed, from caller's perspective (positive = caller gains)
      let usdcDelta: bigint;

      if (direction === 'BUY') {
        // Debit caller USDC.
        const userRes = await c.query<{ usdc_base_units: string }>(
          `SELECT usdc_base_units::text AS usdc_base_units FROM users WHERE email = $1 FOR UPDATE`,
          [s.email],
        );
        if (userRes.rows.length === 0 || BigInt(userRes.rows[0].usdc_base_units) < amountIn) {
          return { error: 'INSUFFICIENT_USDC', message: 'not enough USDC', status: 400 };
        }
        await c.query(
          `UPDATE users SET usdc_base_units = usdc_base_units - $1::bigint WHERE email = $2`,
          [amountIn.toString(), s.email],
        );

        // Mint RPOW token to caller. Cap-check minted_supply.
        const RPOW_BASE_UNITS_PER_RPOW = 1_000_000_000n;
        const capBaseUnits = BigInt(app.config.mintMaxSupply) * RPOW_BASE_UNITS_PER_RPOW;
        const supplyResult = await c.query(
          `UPDATE app_counters SET value = value + $1::bigint
           WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
          [output.toString(), capBaseUnits.toString()],
        );
        if ((supplyResult.rowCount ?? 0) === 0) {
          throw new Error('SUPPLY_CAP_REACHED');
        }
        const tokenId = randomUUID();
        const issuedAt = new Date();
        const ownerEmailHash = createHash('sha256').update(s.email).digest('hex');
        const sig = signTokenPayload(
          { id: tokenId, owner_email_hash: ownerEmailHash, value: output, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
           VALUES($1, $2, $3, 'VALID', $4, $5)`,
          [tokenId, s.email, output.toString(), issuedAt, sig],
        );

        newUsdc = oldUsdc + amountIn;
        newRpow = oldRpow - output;
        rpowDelta = output;     // caller gains output RPOW
        usdcDelta = -amountIn;  // caller spends amountIn USDC
      } else {
        // SELL: burn caller's RPOW. Throws INSUFFICIENT_BALANCE if short.
        await burnFromUser(c, s.email, amountIn, app.config.signingPrivateKeyHex);
        // Burned RPOW leaves user circulation (escrowed in pool).
        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
          [amountIn.toString()],
        );
        // Credit caller's USDC.
        await c.query(
          `INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
          [s.email],
        );
        await c.query(
          `UPDATE users SET usdc_base_units = usdc_base_units + $1::bigint WHERE email = $2`,
          [output.toString(), s.email],
        );

        newRpow = oldRpow + amountIn;
        newUsdc = oldUsdc - output;
        rpowDelta = -amountIn;  // caller spends amountIn RPOW
        usdcDelta = output;     // caller gains output USDC
      }

      // Persist new reserves.
      await c.query(
        `UPDATE amm_pool SET rpow_reserve_base_units = $1::bigint, usdc_reserve_base_units = $2::bigint WHERE id = 'main'`,
        [newRpow.toString(), newUsdc.toString()],
      );

      // Invariant assertion: new k must be >= old k. Anything else is a math bug.
      const oldK = oldRpow * oldUsdc;
      const newK = newRpow * newUsdc;
      if (newK < oldK) {
        throw new Error(`INVARIANT_VIOLATED: newK ${newK} < oldK ${oldK}`);
      }

      // Sign + insert audit row.
      const swapId = randomUUID();
      const createdAt = new Date();
      const payload: SwapPayload = {
        id: swapId,
        account_email_hash: createHash('sha256').update(s.email).digest('hex'),
        direction,
        rpow_delta_base_units: rpowDelta,
        usdc_delta_base_units: usdcDelta,
        fee_base_units: fee,
        pool_rpow_after: newRpow,
        pool_usdc_after: newUsdc,
        created_at: createdAt.toISOString(),
      };
      const signature = signSwapPayload(payload, app.config.signingPrivateKeyHex);

      await c.query(
        `INSERT INTO amm_swaps(id, account_email, direction, rpow_delta_base_units, usdc_delta_base_units, fee_base_units, pool_rpow_after, pool_usdc_after, signature, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [swapId, s.email, direction, rpowDelta.toString(), usdcDelta.toString(), fee.toString(), newRpow.toString(), newUsdc.toString(), signature, createdAt],
      );

      return { ok: true, swapId, output, fee, signature, createdAt };
    });
  } catch (e: any) {
    if (e?.message === 'INSUFFICIENT_BALANCE') {
      return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough RPOW' });
    }
    if (e?.message === 'SUPPLY_CAP_REACHED') {
      return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
    }
    if (e?.message?.startsWith?.('INVARIANT_VIOLATED')) {
      // Real bug — don't swallow, let the harness surface it as a 500.
      throw e;
    }
    throw e;
  }

  if ('error' in result) {
    return reply.code(result.status).send({ error: result.error, message: result.message });
  }

  return reply.code(200).send({
    swap_id: result.swapId,
    [direction === 'BUY' ? 'rpow_received' : 'usdc_received']: result.output.toString(),
    fee_base_units: result.fee.toString(),
    signature_hex: result.signature.toString('hex'),
    server_time: result.createdAt.toISOString(),
  });
}
