import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../session.js';

export async function claimRoutes(app: FastifyInstance) {
  type ClaimStatus = 'pending' | 'expired' | 'claimed' | 'canceled';
  type ClaimStatusRow = {
    sender_email: string;
    recipient_email: string;
    amount: number;
    expires_at: Date;
    claimed_at: Date | null;
    canceled_at: Date | null;
  };
  type ClaimResult =
    | { ok: true; recipient_email: string; amount: number }
    | { error: string; message: string; status: number };

  function claimStatus(row: Pick<ClaimStatusRow, 'expires_at' | 'claimed_at' | 'canceled_at'>): ClaimStatus {
    if (row.canceled_at) return 'canceled';
    if (row.claimed_at) return 'claimed';
    if (row.expires_at.getTime() <= Date.now()) return 'expired';
    return 'pending';
  }

  function serializeClaimStatus(row: ClaimStatusRow) {
    return {
      ok: true as const,
      sender_email: row.sender_email,
      recipient_email: row.recipient_email,
      amount: row.amount,
      expires_at: row.expires_at.toISOString(),
      status: claimStatus(row),
      claimed_at: row.claimed_at?.toISOString() ?? null,
      canceled_at: row.canceled_at?.toISOString() ?? null,
    };
  }

  async function loadClaimStatus(token: string): Promise<ClaimStatusRow | null> {
    const tokenHash = createHash('sha256').update(token).digest();
    const { rows } = await app.pool.query<ClaimStatusRow>(
      `SELECT sender_email, recipient_email, amount, expires_at, claimed_at, canceled_at
       FROM pending_transfers
       WHERE claim_token_hash=$1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async function redeemClaimToken(token: string): Promise<ClaimResult> {
    const tokenHash = createHash('sha256').update(token).digest();
    return withTx<ClaimResult>(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; recipient_email: string;
        amount: number;
      }>(
        `UPDATE pending_transfers
         SET claimed_at=now()
         WHERE claim_token_hash=$1
           AND expires_at > now()
           AND claimed_at IS NULL
           AND canceled_at IS NULL
         RETURNING id, sender_email, recipient_email, amount`,
        [tokenHash],
      );
      const pt = rows[0];
      if (!pt) {
        const status = await c.query<{ expires_at: Date; claimed_at: Date | null; canceled_at: Date | null }>(
          'SELECT expires_at, claimed_at, canceled_at FROM pending_transfers WHERE claim_token_hash=$1',
          [tokenHash],
        );
        const existing = status.rows[0];
        if (!existing) return { error: 'INVALID_CLAIM', message: 'invalid claim link', status: 400 };
        if (existing.claimed_at) return { error: 'ALREADY_CLAIMED', message: 'this gift has already been redeemed', status: 400 };
        if (existing.canceled_at) return { error: 'CLAIM_CANCELED', message: 'this gift has been canceled by the sender', status: 410 };
        if (existing.expires_at.getTime() <= Date.now()) return { error: 'CLAIM_EXPIRED', message: 'this claim link has expired', status: 410 };
        return { error: 'INVALID_CLAIM', message: 'invalid claim link', status: 400 };
      }

      const originalTokens = await c.query<{ token_id: string }>(
        `SELECT token_id
         FROM pending_transfer_tokens
         WHERE pending_transfer_id=$1
         ORDER BY token_id`,
        [pt.id],
      );
      if (originalTokens.rows.length !== pt.amount) {
        await c.query('UPDATE pending_transfers SET claimed_at=NULL WHERE id=$1', [pt.id]);
        return {
          error: 'CLAIM_UNAVAILABLE',
          message: 'this claim cannot be completed because its source token records are missing',
          status: 409,
        };
      }

      // Auto-create user (or update last_login_at if they already signed up via magic link first).
      await c.query(
        `INSERT INTO users(email) VALUES($1)
         ON CONFLICT (email) DO UPDATE SET last_login_at = now()`,
        [pt.recipient_email],
      );

      // Reissue child tokens against the original sender token ids. Claims
      // move already-mined value, so they must not create root tokens or bump
      // app_counters.minted_supply.
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(pt.recipient_email).digest('hex');
      for (const original of originalTokens.rows) {
        const newId = randomUUID();
        const sig = signTokenPayload(
          { id: newId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
           VALUES($1, $2, 1, 'VALID', $3, $4, $5)`,
          [newId, pt.recipient_email, issuedAt, original.token_id, sig],
        );
      }

      // Record the completed transfer in the ledger (separate idempotency-key namespace).
      const transferId = randomUUID();
      await c.query(
        `INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key)
         VALUES($1, $2, $3, $4, $5)`,
        [transferId, pt.sender_email, pt.recipient_email, pt.amount, `claim:${pt.id}`],
      );

      return { ok: true as const, recipient_email: pt.recipient_email, amount: pt.amount };
    });
  }

  function setClaimSession(reply: FastifyReply, email: string) {
    const sessionToken = signSession({ email }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: app.config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
  }

  app.get('/claim/status', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });

    const status = await loadClaimStatus(token);
    if (!status) return reply.code(400).send({ error: 'INVALID_CLAIM', message: 'invalid claim link' });
    return serializeClaimStatus(status);
  });

  app.post('/claim', async (req, reply) => {
    const token = (req.body as Record<string, string | undefined> | null | undefined)?.token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });

    const out = await redeemClaimToken(token);
    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    setClaimSession(reply, out.recipient_email);
    return { ok: true as const, recipient_email: out.recipient_email, amount: out.amount };
  });

  app.get('/claim', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });

    const out = await redeemClaimToken(token);

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });

    // Sign the recipient in.
    setClaimSession(reply, out.recipient_email);
    return reply.redirect(`${app.config.webOrigin}/#/wallet`, 302);
  });
}
