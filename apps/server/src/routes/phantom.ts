import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyPhantomSignature } from '@rpow/solana-bridge';
import { readSession } from './auth.js';
import { withTx } from '../db.js';

const NONCE_TTL_MS = 5 * 60 * 1000;

const BindBody = z.object({
  nonce: z.string().uuid(),
  wallet_address: z.string().min(32).max(44),
  signature_base58: z.string().min(80).max(100),
});

export async function phantomRoutes(app: FastifyInstance) {
  app.post('/phantom/challenge', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    await app.pool.query(
      'INSERT INTO phantom_challenges(nonce, user_email, expires_at) VALUES($1,$2,$3)',
      [nonce, s.email, expiresAt],
    );
    return { nonce, message: `rpow2.com bind: ${nonce}`, expires_at: expiresAt.toISOString() };
  });

  app.post('/phantom/bind', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = BindBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    const { nonce, wallet_address, signature_base58 } = parsed.data;

    return await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{ user_email: string; expires_at: Date; used_at: Date | null }>(
        'SELECT user_email, expires_at, used_at FROM phantom_challenges WHERE nonce=$1 FOR UPDATE',
        [nonce],
      );
      const ch = rows[0];
      if (!ch) return reply.code(400).send({ error: 'NONCE_INVALID', message: 'unknown nonce' });
      if (ch.user_email !== s.email) return reply.code(400).send({ error: 'NONCE_INVALID', message: 'wrong user' });
      if (ch.expires_at.getTime() < Date.now()) return reply.code(400).send({ error: 'NONCE_EXPIRED', message: 'nonce expired' });

      const message = `rpow2.com bind: ${nonce}`;
      if (!verifyPhantomSignature(message, signature_base58, wallet_address)) {
        return reply.code(400).send({ error: 'BAD_SIGNATURE', message: 'signature does not verify' });
      }

      // Idempotent rebind: if user already has this exact wallet, succeed without changing anything.
      const existing = await c.query<{ solana_wallet: string | null }>(
        'SELECT solana_wallet FROM users WHERE email=$1', [s.email],
      );
      if (existing.rows[0]?.solana_wallet === wallet_address) {
        await c.query('UPDATE phantom_challenges SET used_at=now() WHERE nonce=$1', [nonce]);
        return { ok: true, solana_wallet: wallet_address };
      }

      // Block nonce replay AFTER the idempotent same-wallet path: an honest
      // re-bind of the same wallet still no-ops, but a different-wallet replay
      // of an already-used nonce is rejected.
      if (ch.used_at !== null) {
        return reply.code(400).send({ error: 'NONCE_INVALID', message: 'nonce already used' });
      }

      try {
        await c.query('UPDATE users SET solana_wallet=$1 WHERE email=$2', [wallet_address, s.email]);
        await c.query('UPDATE phantom_challenges SET used_at=now() WHERE nonce=$1', [nonce]);
      } catch (e: any) {
        if (e?.code === '23505') {       // unique violation on solana_wallet
          return reply.code(400).send({ error: 'WALLET_TAKEN', message: 'wallet already bound to another user' });
        }
        throw e;
      }
      return { ok: true, solana_wallet: wallet_address };
    });
  });
}
