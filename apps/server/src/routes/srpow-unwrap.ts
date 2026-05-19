import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';
import { isAllowed } from '../wrap-allowlist.js';

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

    // 'confirmed' — proceed to swap+burn+credit. Implemented in Task 9.
    // For now: leave the row PENDING and return 202 so the test passes.
    return reply.code(202).send({ event_id: eventId, status: 'PENDING' as const, message: 'unwrap pipeline pending (impl in task 9)' });
  });
}
