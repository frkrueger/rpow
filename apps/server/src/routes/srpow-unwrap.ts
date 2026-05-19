import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';
import { isAllowed } from '../wrap-allowlist.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const UnwrapBody = z.object({
  signature: z.string().min(40).max(120),
  amount_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/),
  idempotency_key: z.string().min(8).max(80),
});

async function markUnwrapFailed(pool: import('pg').Pool, eventId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE srpow_wrap_events SET status='FAILED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, eventId],
  );
}

export async function srpowUnwrapRoutes(app: FastifyInstance) {
  app.get('/srpow/config', async () => {
    return {
      bridge_wallet_pubkey: app.config.bridgeWalletPubkey ?? '',
      srpow_mint_address: app.config.srpowMintAddress ?? '',
      fee_bps: app.config.srpowUnwrapFeeBps,
      min_unwrap_base_units: app.config.srpowUnwrapMinBaseUnits.toString(),
      max_unwrap_base_units: (10n ** 18n).toString(),
      slippage_bps: app.config.srpowUnwrapSlippageBps,
    };
  });

  app.post('/srpow/unwrap', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!isAllowed(app.wrapAllowlist, s.email)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'unwrap not enabled for your account' });
    }

    const parsed = UnwrapBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const { signature, amount_base_units, idempotency_key } = parsed.data;
    const amount = BigInt(amount_base_units);

    if (amount < app.config.srpowUnwrapMinBaseUnits) {
      return reply.code(400).send({ error: 'INSUFFICIENT_AMOUNT', message: 'below minimum unwrap amount' });
    }
    if (amount > 10n ** 18n) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'amount exceeds maximum' });
    }

    // Idempotency-key replay path
    const dup = await app.pool.query<{
      id: string; amount: string; status: string;
      solana_signature: string | null; swap_signature: string | null; burn_signature: string | null;
      direction: string;
    }>(
      `SELECT id, amount::text AS amount, status, solana_signature, swap_signature, burn_signature, direction
       FROM srpow_wrap_events WHERE idempotency_key=$1`,
      [idempotency_key],
    );
    if (dup.rows[0]) {
      const e = dup.rows[0];
      if (e.direction !== 'UNWRAP' || BigInt(e.amount) !== amount || e.solana_signature !== signature) {
        return reply.code(409).send({ error: 'DUP_DIFFERENT_PARAMS' });
      }
      if (e.status === 'CONFIRMED') {
        return {
          ok: true, event_id: e.id, status: 'CONFIRMED' as const,
          credit_base_units: ((amount * (10000n - BigInt(app.config.srpowUnwrapFeeBps))) / 10000n).toString(),
          inbound_signature: e.solana_signature,
          swap_signature: e.swap_signature, burn_signature: e.burn_signature,
        };
      }
      if (e.status === 'PENDING') {
        return reply.code(202).send({ event_id: e.id, status: 'PENDING' as const, message: 'unwrap in progress' });
      }
      return reply.code(503).send({ error: 'BRIDGE_FAILED', event_id: e.id, status: e.status });
    }

    // Wallet binding
    const userRow = await app.pool.query<{ solana_wallet: string | null }>(
      `SELECT solana_wallet FROM users WHERE email=$1`, [s.email],
    );
    const wallet = userRow.rows[0]?.solana_wallet;
    if (!wallet) return reply.code(400).send({ error: 'NO_WALLET_BOUND' });

    // Inbound-sig reuse check. The partial UNIQUE index on solana_signature
    // (direction='UNWRAP') is the source of truth, but checking it here lets
    // us return INBOUND_SIG_REUSED rather than DAILY_UNWRAP_LIMIT when the
    // same sig is replayed with a fresh idempotency_key on the same day.
    const sigDup = await app.pool.query<{ id: string }>(
      `SELECT id FROM srpow_wrap_events
       WHERE direction='UNWRAP' AND solana_signature=$1`,
      [signature],
    );
    if (sigDup.rows[0]) {
      return reply.code(409).send({ error: 'INBOUND_SIG_REUSED' });
    }

    // Daily quota — excluding REFUNDED/FAILED
    const today = new Date().toISOString().slice(0, 10);
    const { rows: countRows } = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM srpow_wrap_events
       WHERE user_email=$1 AND direction='UNWRAP'
         AND status NOT IN ('REFUNDED','FAILED')
         AND created_at::date = $2::date`,
      [s.email, today],
    );
    if ((countRows[0]?.n ?? 0) >= 1) {
      return reply.code(429).send({ error: 'DAILY_UNWRAP_LIMIT', message: '1 unwrap per day; resets at UTC midnight' });
    }

    // INSERT first so we have an event_id even if verification is pending
    const eventId = randomUUID();
    try {
      await app.pool.query(
        `INSERT INTO srpow_wrap_events
         (id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
         VALUES($1,$2,$3,$4,'UNWRAP','PENDING',$5,$6)`,
        [eventId, s.email, wallet, amount.toString(), idempotency_key, signature],
      );
    } catch (e: any) {
      if (String(e?.message ?? '').match(/srpow_unwrap_inbound_sig_unique/)) {
        return reply.code(409).send({ error: 'INBOUND_SIG_REUSED' });
      }
      throw e;
    }

    // Verify inbound transfer
    if (!app.config.srpowMintAddress || !app.config.bridgeWalletPubkey) {
      await markUnwrapFailed(app.pool, eventId, 'srpow not configured');
      return reply.code(503).send({ error: 'BRIDGE_DISABLED' });
    }
    const v = await app.bridgeClient.verifyInboundTransfer({
      signature, expectedFrom: wallet, expectedTo: app.config.bridgeWalletPubkey,
      expectedAmount: amount, mint: app.config.srpowMintAddress,
    });
    if (v.status === 'pending') {
      return reply.code(202).send({ event_id: eventId, status: 'PENDING' as const, message: 'inbound sig not finalized yet, retry shortly' });
    }
    if (v.status === 'not_found') {
      await markUnwrapFailed(app.pool, eventId, 'inbound sig not_found');
      return reply.code(400).send({ error: 'TRANSFER_NOT_LANDED', event_id: eventId });
    }
    if (v.status === 'failed') {
      await markUnwrapFailed(app.pool, eventId, `inbound sig failed: ${v.reason}`);
      return reply.code(400).send({ error: 'TRANSFER_NOT_LANDED', event_id: eventId });
    }
    if (v.status === 'mismatch') {
      await markUnwrapFailed(app.pool, eventId, `inbound mismatch: ${v.reason}`);
      if (v.reason === 'wrong_from') return reply.code(403).send({ error: 'WRONG_SENDER', event_id: eventId });
      return reply.code(400).send({ error: 'AMOUNT_MISMATCH', event_id: eventId });
    }

    // 'confirmed' — execute the pipeline.
    const feeAmount = (amount * BigInt(app.config.srpowUnwrapFeeBps)) / 10000n;
    const burnAmount = amount - feeAmount;

    // Step 2: swap fee SRPOW for SOL via Jupiter.
    const swapResult = await app.bridgeClient.swapSrpowForSol(
      feeAmount, app.config.srpowUnwrapSlippageBps,
      async (sig) => {
        await app.pool.query(
          `UPDATE srpow_wrap_events SET swap_signature=$1, updated_at=now() WHERE id=$2`,
          [sig, eventId],
        );
      },
    );
    if (swapResult.status !== 'confirmed') {
      // Failure path: refund. Implemented in Task 10.
      const r = await refundUnwrap(app, eventId, wallet, amount, swapResult);
      return reply.code(r.code).send(r.body);
    }

    // Step 3: burn the burn amount of SRPOW from the bridge's own ATA.
    const burnResult = await app.bridgeClient.burnSrpow(
      burnAmount,
      async (sig) => {
        await app.pool.query(
          `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
          [sig, eventId],
        );
      },
    );
    if (burnResult.status !== 'confirmed') {
      // Burn failures retry via reconcile. Mark PENDING and return 202.
      return reply.code(202).send({
        event_id: eventId, status: 'PENDING' as const,
        message: 'burn pending; reconcile will retry',
      });
    }

    // Step 4: credit user + update counters atomically.
    await creditUserAndUpdateCounters(
      app.pool, app.config.signingPrivateKeyHex,
      eventId, s.email, burnAmount, feeAmount,
    );

    return {
      ok: true, event_id: eventId, status: 'CONFIRMED' as const,
      credit_base_units: burnAmount.toString(),
      inbound_signature: signature,
      swap_signature: swapResult.signature,
      burn_signature: burnResult.signature,
    };
  });
}

async function creditUserAndUpdateCounters(
  pool: import('pg').Pool,
  signingPrivateKeyHex: string,
  eventId: string,
  userEmail: string,
  creditAmount: bigint,        // 0.95X — the user's RPOW credit + decrement of wrapped_supply
  feeBurnedAmount: bigint,     // 0.05X — the fee portion swapped, tracked separately
): Promise<void> {
  await withTx(pool, async (c) => {
    const tokenId = randomUUID();
    const issuedAt = new Date();
    const ownerHash = createHash('sha256').update(userEmail).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerHash, value: creditAmount, issued_at: issuedAt.toISOString() },
      signingPrivateKeyHex,
    );
    // Trigger on tokens INSERT increments circulating_supply automatically.
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig, wrap_event_id, is_change)
       VALUES($1, $2, $3, 'VALID', $4, $5, $6, FALSE)`,
      [tokenId, userEmail, creditAmount.toString(), issuedAt, sig, eventId],
    );

    // Manually decrement wrapped_supply_base_units. No specific WRAPPED token
    // "represents" the SRPOW being unwrapped (SRPOW is fungible on-chain);
    // picking a random user's WRAPPED row to invalidate would be misleading
    // audit data. Pay the cost of one extra write to keep history honest.
    const wrappedShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value - $1
       WHERE name='wrapped_supply_base_units' AND shard=$2`,
      [creditAmount.toString(), wrappedShard],
    );

    // Bump the fee burn counter (informational only).
    const feeShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value + $1
       WHERE name='unwrap_fee_burned_srpow_base_units' AND shard=$2`,
      [feeBurnedAmount.toString(), feeShard],
    );

    await c.query(
      `UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`,
      [eventId],
    );
  });
}

async function refundUnwrap(
  app: { pool: import('pg').Pool; bridgeClient: any },
  eventId: string,
  wallet: string,
  amount: bigint,
  swapResult: { status: string; quoted_slippage_bps?: number; failureReason?: string },
): Promise<{ code: number; body: any }> {
  const reason = swapResult.status === 'slippage_exceeded'
    ? `swap_failed: slippage_exceeded (${swapResult.quoted_slippage_bps} bps)`
    : `swap_failed: ${(swapResult as any).failureReason ?? 'unknown'}`;

  // Bridge sends the full X SRPOW back to the user's wallet from its own ATA.
  const refund = await app.bridgeClient.transferSrpowFromBridge(
    wallet, amount,
    async (sig: string) => {
      // The refund sig is stored in burn_signature (operational compromise to
      // avoid a 4th sig column). failure_reason makes the role unambiguous.
      await app.pool.query(
        `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
        [sig, eventId],
      );
    },
  );

  if (refund.status !== 'confirmed') {
    // Refund itself failed — leave the event PENDING and surface a 503.
    // Operator must intervene (manual SRPOW transfer back).
    await app.pool.query(
      `UPDATE srpow_wrap_events SET failure_reason=$1, updated_at=now() WHERE id=$2`,
      [`${reason}; refund_failed`, eventId],
    );
    return { code: 503, body: { error: 'BRIDGE_FAILED', event_id: eventId, status: 'PENDING' } };
  }

  await app.pool.query(
    `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, eventId],
  );
  return { code: 503, body: { error: 'BRIDGE_FAILED', event_id: eventId, status: 'REFUNDED' } };
}
