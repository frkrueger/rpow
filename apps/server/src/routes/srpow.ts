import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { isAllowed } from '../wrap-allowlist.js';

const WrapBody = z.object({
  amount: z.number().int().positive().max(1_000_000),
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
    const { amount, idempotency_key } = parsed.data;

    // Phase 1: DB lock (single tx).
    const phase1 = await withTx(app.pool, async (c) => {
      const dup = await c.query<{ id: string; amount: number; status: string; solana_signature: string | null }>(
        'SELECT id, amount, status, solana_signature FROM srpow_wrap_events WHERE idempotency_key=$1',
        [idempotency_key],
      );
      if (dup.rows[0]) {
        if (dup.rows[0].amount !== amount) {
          return { error: 'DUP_DIFFERENT_PARAMS' as const };
        }
        return { existing: dup.rows[0] };
      }

      const userRow = await c.query<{ solana_wallet: string | null }>(
        'SELECT solana_wallet FROM users WHERE email=$1', [s.email],
      );
      const wallet = userRow.rows[0]?.solana_wallet;
      if (!wallet) return { error: 'NO_WALLET_BOUND' as const };

      // Per-user serialization.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_srpow_wrap'), hashtext($1))`, [s.email]);

      const lockSql = `SELECT id FROM tokens WHERE owner_email=$1 AND state='VALID'
        ORDER BY issued_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED`;
      const { rows: locked } = await c.query<{ id: string }>(lockSql, [s.email, amount]);
      if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const };

      const eventId = randomUUID();
      await c.query(
        `INSERT INTO srpow_wrap_events
         (id, user_email, solana_wallet, amount, direction, status, idempotency_key)
         VALUES($1,$2,$3,$4,'WRAP','PENDING',$5)`,
        [eventId, s.email, wallet, amount, idempotency_key],
      );
      const ids = locked.map(r => r.id);
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
    }

    // Replay path: a previous call already completed Phase 1+2 (or refunded).
    if ('existing' in phase1) {
      const e = phase1.existing;
      return { ok: true, event_id: e.id, status: e.status, solana_signature: e.solana_signature };
    }

    // Phase 2 (Task 13 will add refund-on-failure):
    if ('fresh' in phase1) {
      const { eventId, wallet, ids } = phase1.fresh;
      const result = await app.bridgeClient.mintTo({ recipientWallet: wallet, amount });
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
      // failure path implemented in Task 13
      return reply.code(503).send({ error: 'BRIDGE_FAILED', event_id: eventId, status: 'PENDING' });
    }
  });
}
