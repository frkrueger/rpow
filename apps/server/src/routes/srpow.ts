import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { isAllowed } from '../wrap-allowlist.js';
import { signTokenPayload } from '../signing.js';

const WrapBody = z.object({
  amount_base_units: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, 'positive bigint as string')
    .refine(
      (s) => {
        try {
          const n = BigInt(s);
          return n > 0n && n <= 10n ** 18n;
        } catch {
          return false;
        }
      },
      'amount_base_units must be a positive bigint up to 10^18',
    ),
  idempotency_key: z.string().min(8).max(80),
});

export async function srpowRoutes(app: FastifyInstance) {
  app.post('/srpow/wrap', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    if (!isAllowed(app.wrapAllowlist, s.email)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'wrap not enabled for your account' });
    }
    const parsed = WrapBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const { amount_base_units, idempotency_key } = parsed.data;
    const target = BigInt(amount_base_units);

    // Phase 1: DB lock (single tx).
    const phase1 = await withTx(app.pool, async (c) => {
      // amount column is now BIGINT base units; read as text and compare bigints.
      const dup = await c.query<{ id: string; amount: string; status: string; solana_signature: string | null }>(
        'SELECT id, amount::text AS amount, status, solana_signature FROM srpow_wrap_events WHERE idempotency_key=$1',
        [idempotency_key],
      );
      const existing = dup.rows[0];
      if (existing) {
        if (BigInt(existing.amount) !== target) {
          return { error: 'DUP_DIFFERENT_PARAMS' as const };
        }
        return { existing };
      }

      const userRow = await c.query<{ solana_wallet: string | null }>(
        'SELECT solana_wallet FROM users WHERE email=$1', [s.email],
      );
      const wallet = userRow.rows[0]?.solana_wallet;
      if (!wallet) return { error: 'NO_WALLET_BOUND' as const };

      // Per-user serialization.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_srpow_wrap'), hashtext($1))`, [s.email]);

      // Pull candidate tokens largest-first; FOR UPDATE locks them so concurrent
      // /send|/wrap calls don't race over the same rows. No LIMIT — we need the
      // full pool to pick a subset summing to >= target.
      const { rows: pool } = await c.query<{ id: string; value: string }>(
        `SELECT id, value::text AS value FROM tokens
         WHERE owner_email=$1 AND state='VALID'
         ORDER BY value DESC, id ASC
         FOR UPDATE SKIP LOCKED`,
        [s.email],
      );

      const totalAvailable = pool.reduce((acc, r) => acc + BigInt(r.value), 0n);
      if (totalAvailable < target) {
        return { error: 'INSUFFICIENT_BALANCE' as const };
      }

      // Greedy largest-first accumulation: pick rows until sum >= target.
      // The leftover (sum - target) is issued back as a CHANGE token, so the
      // user can wrap any amount up to their full balance regardless of how
      // their tokens are denominated.
      const picked: { id: string; value: bigint }[] = [];
      let total = 0n;
      for (const row of pool) {
        const v = BigInt(row.value);
        picked.push({ id: row.id, value: v });
        total += v;
        if (total >= target) break;
      }
      // Trim trailing tokens that aren't needed: if removing the smallest
      // picked token still leaves total >= target, drop it. Repeats until
      // the picked set is the minimal accumulating prefix.
      while (picked.length > 1) {
        const tail = picked[picked.length - 1].value;
        if (total - tail >= target) {
          total -= tail;
          picked.pop();
        } else break;
      }
      const change = total - target;

      const eventId = randomUUID();
      await c.query(
        `INSERT INTO srpow_wrap_events
         (id, user_email, solana_wallet, amount, direction, status, idempotency_key)
         VALUES($1,$2,$3,$4,'WRAP','PENDING',$5)`,
        [eventId, s.email, wallet, target.toString(), idempotency_key],
      );
      const ids = picked.map(r => r.id);
      await c.query(
        `UPDATE tokens SET state='LOCKED_FOR_BRIDGE', wrap_event_id=$1
         WHERE id = ANY($2::uuid[])`,
        [eventId, ids],
      );

      // If there's a change amount, issue a LOCKED change token now. It
      // becomes VALID on Phase-2 confirm, or is deleted on Phase-2 refund.
      let changeId: string | null = null;
      if (change > 0n) {
        changeId = randomUUID();
        const issuedAt = new Date();
        const ownerHash = createHash('sha256').update(s.email).digest('hex');
        const sig = signTokenPayload(
          { id: changeId, owner_email_hash: ownerHash, value: change, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig, wrap_event_id, is_change)
           VALUES($1, $2, $3, 'LOCKED_FOR_BRIDGE', $4, $5, $6, TRUE)`,
          [changeId, s.email, change.toString(), issuedAt, sig, eventId],
        );
      }

      return { fresh: { eventId, wallet, ids, changeId, change } };
    });

    if ('error' in phase1) {
      const code = phase1.error;
      if (code === 'DUP_DIFFERENT_PARAMS') return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key reused with different parameters' });
      if (code === 'NO_WALLET_BOUND') return reply.code(400).send({ error: 'NO_WALLET_BOUND', message: 'bind a Solana wallet first' });
      if (code === 'INSUFFICIENT_BALANCE') return reply.code(400).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough VALID tokens' });
    }

    // Replay path: a previous call already completed Phase 1+2 (or refunded).
    // The `!` is sound: 'existing' in phase1 was just verified, and the
    // producer above only writes phase1.existing as a non-null row.
    if ('existing' in phase1) {
      const e = phase1.existing!;
      if (e.status === 'CONFIRMED') {
        return { ok: true, event_id: e.id, status: 'CONFIRMED' as const, solana_signature: e.solana_signature ?? '' };
      }
      if (e.status === 'PENDING') {
        return reply.code(202).send({ event_id: e.id, status: 'PENDING' as const, message: 'wrap in progress, retry shortly' });
      }
      // REFUNDED or FAILED
      return reply.code(503).send({
        error: 'BRIDGE_FAILED',
        event_id: e.id,
        status: e.status,
        failure_reason: 'idempotent replay of a previously-failed wrap',
      });
    }

    if ('fresh' in phase1) {
      const { eventId, wallet, ids, changeId, change } = phase1.fresh;

      const result = await app.bridgeClient.mintTo(
        { recipientWallet: wallet, amountBaseUnits: target },
        async (signature) => {
          // Persist signature BEFORE the bridge client awaits confirmation. If
          // the server crashes between here and the confirmation result, the
          // reconcile worker on next boot will see this row's solana_signature
          // and resolve it via getSignatureStatus — preventing an erroneous
          // refund of a wrap that actually confirmed on-chain.
          await app.pool.query(
            `UPDATE srpow_wrap_events SET solana_signature=$1, updated_at=now() WHERE id=$2`,
            [signature, eventId],
          );
        },
      );

      if (result.status === 'confirmed') {
        await withTx(app.pool, async (c) => {
          await c.query(
            `UPDATE srpow_wrap_events SET status='CONFIRMED', solana_signature=$1, updated_at=now() WHERE id=$2`,
            [result.signature, eventId],
          );
          // Source tokens -> WRAPPED (state already filtered by !is_change in
          // case the event has both source and change tokens linked).
          await c.query(
            `UPDATE tokens SET state='WRAPPED' WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          // Change token (if any) -> VALID, becomes user-spendable.
          if (changeId) {
            await c.query(
              `UPDATE tokens SET state='VALID' WHERE id=$1`,
              [changeId],
            );
          }
        });
        return {
          ok: true,
          event_id: eventId,
          status: 'CONFIRMED',
          solana_signature: result.signature,
          change_base_units: change.toString(),
        };
      }

      // Failure path: refund. Source tokens go back to VALID; the change token
      // (if any) is deleted since it was never user-visible. We DO NOT null
      // out solana_signature — the pre-submit callback may have set it, and
      // we want to preserve it so the user can see the failed tx on Solscan
      // and the reconcile worker has a stable artifact for any future lookups.
      await withTx(app.pool, async (c) => {
        await c.query(
          `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
          [result.failureReason, eventId],
        );
        await c.query(
          `UPDATE tokens SET state='VALID', wrap_event_id=NULL WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        if (changeId) {
          await c.query(`DELETE FROM tokens WHERE id=$1`, [changeId]);
        }
      });
      return reply.code(503).send({
        error: 'BRIDGE_FAILED', event_id: eventId, status: 'REFUNDED',
        failure_reason: result.failureReason,
      });
    }
  });

  app.get('/srpow/events', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { rows } = await app.pool.query(
      `SELECT id, direction, amount::text AS amount, status, solana_signature, failure_reason, created_at, updated_at
       FROM srpow_wrap_events WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100`,
      [s.email],
    );
    return rows.map(r => ({
      event_id: r.id,
      direction: r.direction,
      amount_base_units: r.amount,
      status: r.status,
      solana_signature: r.solana_signature,
      failure_reason: r.failure_reason,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  });

  app.get<{ Params: { id: string } }>('/srpow/events/:id', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { rows } = await app.pool.query(
      `SELECT id, direction, amount::text AS amount, status, solana_signature, failure_reason, created_at, updated_at
       FROM srpow_wrap_events WHERE id=$1 AND user_email=$2`,
      [req.params.id, s.email],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'NOT_FOUND', message: 'event not found' });
    const r = rows[0];
    return {
      event_id: r.id, direction: r.direction, amount_base_units: r.amount, status: r.status,
      solana_signature: r.solana_signature, failure_reason: r.failure_reason,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  });
}
