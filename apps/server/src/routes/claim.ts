import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../session.js';

export async function claimRoutes(app: FastifyInstance) {
  app.get('/claim', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });
    const tokenHash = createHash('sha256').update(token).digest();

    type ClaimResult =
      | { ok: true; recipient_email: string; amount: number }
      | { error: string; message: string; status: number };

    const out = await withTx<ClaimResult>(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; recipient_email: string;
        amount: number; expires_at: Date; claimed_at: Date | null;
      }>(
        `SELECT id, sender_email, recipient_email, amount, expires_at, claimed_at
         FROM pending_transfers WHERE claim_token_hash=$1 FOR UPDATE`,
        [tokenHash],
      );
      const pt = rows[0];
      if (!pt) return { error: 'INVALID_CLAIM', message: 'invalid claim link', status: 400 };
      if (pt.claimed_at) return { error: 'ALREADY_CLAIMED', message: 'this gift has already been redeemed', status: 400 };
      if (pt.expires_at.getTime() < Date.now()) return { error: 'CLAIM_EXPIRED', message: 'this claim link has expired', status: 410 };

      // Auto-create user (or update last_login_at if they already signed up via magic link first).
      await c.query(
        `INSERT INTO users(email) VALUES($1)
         ON CONFLICT (email) DO UPDATE SET last_login_at = now()`,
        [pt.recipient_email],
      );

      // Mint a single fresh token to recipient with value = pt.amount in base
      // units. parent_token_id=NULL so it counts as "minted" supply for
      // /ledger purposes and must increment app_counters.minted_supply by the
      // base-unit total. No cap check here: the sender's tokens were already
      // burned; refusing to claim would strand them.
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(pt.recipient_email).digest('hex');
      const newId = randomUUID();
      const sig = signTokenPayload(
        { id: newId, owner_email_hash: ownerHash, value: BigInt(pt.amount), issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         VALUES($1, $2, $3, 'VALID', $4, $5)`,
        [newId, pt.recipient_email, BigInt(pt.amount).toString(), issuedAt, sig],
      );
      await c.query(
        `UPDATE app_counters SET value = value + $1::bigint WHERE name='minted_supply'`,
        [BigInt(pt.amount).toString()],
      );

      // Record the completed transfer in the ledger (separate idempotency-key namespace).
      const transferId = randomUUID();
      await c.query(
        `INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key)
         VALUES($1, $2, $3, $4, $5)`,
        [transferId, pt.sender_email, pt.recipient_email, pt.amount, `claim:${pt.id}`],
      );

      await c.query('UPDATE pending_transfers SET claimed_at=now() WHERE id=$1', [pt.id]);

      return { ok: true as const, recipient_email: pt.recipient_email, amount: pt.amount };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    // Sign the recipient in.
    const sessionToken = signSession({ email: out.recipient_email }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: app.config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return reply.redirect(`${app.config.webOrigin}/#/wallet`, 302);
  });
}
