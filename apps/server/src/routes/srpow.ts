import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { isAllowed } from '../wrap-allowlist.js';

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
      // full pool to pick an exact-sum subset.
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

      // Greedy exact-sum: walk largest-first, skip rows that would overshoot.
      const picked: { id: string; value: bigint }[] = [];
      let total = 0n;
      for (const row of pool) {
        const v = BigInt(row.value);
        if (total + v <= target) {
          picked.push({ id: row.id, value: v });
          total += v;
          if (total === target) break;
        }
      }
      if (total !== target) {
        return { error: 'EXACT_SUM_REQUIRED' as const };
      }

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

      return { fresh: { eventId, wallet, ids } };
    });

    if ('error' in phase1) {
      const code = phase1.error;
      if (code === 'DUP_DIFFERENT_PARAMS') return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key reused with different parameters' });
      if (code === 'NO_WALLET_BOUND') return reply.code(400).send({ error: 'NO_WALLET_BOUND', message: 'bind a Solana wallet first' });
      if (code === 'INSUFFICIENT_BALANCE') return reply.code(400).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough VALID tokens' });
      if (code === 'EXACT_SUM_REQUIRED') return reply.code(400).send({
        error: 'EXACT_SUM_REQUIRED',
        message: 'your tokens cannot be combined to exactly equal that amount; pick an amount that matches your denominations',
      });
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
      const { eventId, wallet, ids } = phase1.fresh;

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
          await c.query(
            `UPDATE tokens SET state='WRAPPED' WHERE id = ANY($1::uuid[])`,
            [ids],
          );
        });
        return { ok: true, event_id: eventId, status: 'CONFIRMED', solana_signature: result.signature };
      }

      // Failure path: refund. Note we DO NOT null out solana_signature — the
      // pre-submit callback may have set it, and we want to preserve it so
      // the user can see the failed tx on Solscan and the reconcile worker
      // has a stable artifact for any future lookups.
      await withTx(app.pool, async (c) => {
        await c.query(
          `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
          [result.failureReason, eventId],
        );
        await c.query(
          `UPDATE tokens SET state='VALID', wrap_event_id=NULL WHERE id = ANY($1::uuid[])`,
          [ids],
        );
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
