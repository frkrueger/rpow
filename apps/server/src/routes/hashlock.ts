import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { signTokenPayload } from '../signing.js';
import { withTx } from '../db.js';

const CreateBody = z.object({
  recipient_email: z.string().email(),
  amount: z.number().int().positive().max(1_000_000),
  hash_h_hex: z.string().regex(/^[0-9a-f]{64}$/),
  timeout_seconds: z.number().int().min(3600).max(604800).default(14400), // 1h–7d, default 4h
  idempotency_key: z.string().min(8).max(80),
});

const ClaimBody = z.object({
  preimage_hex: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function hashlockRoutes(app: FastifyInstance) {

  /**
   * POST /hashlock — lock tokens under a SHA-256 hash.
   *
   * Sender's tokens are moved to HASHLOCKED state. Recipient can claim
   * with the preimage. After timeout, sender can refund.
   */
  app.post('/hashlock', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const amount = parsed.data.amount;
    const hashH = Buffer.from(parsed.data.hash_h_hex, 'hex');
    const timeoutSec = parsed.data.timeout_seconds;
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot hashlock to self' });

    type HashlockResult =
      | { hashlock_id: string; recipient_email: string; amount: number; expires_at: string; state: string }
      | { error: string; message: string; status: number };

    let out!: HashlockResult;
    try {
      out = await withTx<HashlockResult>(app.pool, async (c) => {
        // Idempotency check — return existing if same params, reject if different.
        const dup = await c.query<{ id: string; recipient_email: string; amount: number; hash_h: Buffer; expires_at: Date; state: string }>(
          'SELECT id, recipient_email, amount, hash_h, expires_at, state FROM hashlocked_transfers WHERE idempotency_key=$1', [idem],
        );
        if (dup.rows[0]) {
          const row = dup.rows[0];
          if (row.recipient_email !== recipient || row.amount !== amount || !row.hash_h.equals(hashH)) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { hashlock_id: row.id, recipient_email: row.recipient_email, amount: row.amount, expires_at: row.expires_at.toISOString(), state: row.state };
        }

        // Verify recipient exists.
        const recipientExists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);
        if (!recipientExists.rowCount) {
          return { error: 'RECIPIENT_NOT_FOUND' as const, message: 'recipient has no rpow2 account', status: 404 };
        }

        // Lock sender tokens.
        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [sender, amount]);
        if (locked.length < amount) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
        }

        const hlId = randomUUID();
        const expiresAt = new Date(Date.now() + timeoutSec * 1000);

        // Mark tokens as HASHLOCKED.
        for (const t of locked) {
          await c.query(
            `UPDATE tokens SET state='HASHLOCKED', hashlock_id=$1 WHERE id=$2`,
            [hlId, t.id],
          );
        }

        // Insert hashlock record.
        await c.query(
          `INSERT INTO hashlocked_transfers
           (id, sender_email, recipient_email, amount, hash_h, idempotency_key, timeout_seconds, expires_at, state)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`,
          [hlId, sender, recipient, amount, hashH, idem, timeoutSec, expiresAt],
        );

        return { hashlock_id: hlId, recipient_email: recipient, amount, expires_at: expiresAt.toISOString(), state: 'PENDING' };
      });
    } catch (e: any) {
      // Handle unique-constraint race on idempotency_key (same pattern as send.ts).
      if (e?.code === '23505') {
        const existing = await app.pool.query<{ id: string; recipient_email: string; amount: number; expires_at: Date; state: string }>(
          'SELECT id, recipient_email, amount, expires_at, state FROM hashlocked_transfers WHERE idempotency_key=$1', [idem],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          return reply.send({ hashlock_id: row.id, recipient_email: row.recipient_email, amount: row.amount, expires_at: row.expires_at.toISOString(), state: row.state });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  /**
   * POST /hashlock/:id/claim — claim with preimage.
   *
   * Authenticated as recipient. Verifies sha256(preimage) == hash_h.
   * Invalidates locked tokens and mints fresh ones for recipient.
   */
  app.post('/hashlock/:id/claim', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { id } = req.params as { id: string };
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const preimage = Buffer.from(parsed.data.preimage_hex, 'hex');
    const computedHash = createHash('sha256').update(preimage).digest();

    const result = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; recipient_email: string;
        amount: number; hash_h: Buffer; expires_at: Date; state: string;
      }>(
        'SELECT id, sender_email, recipient_email, amount, hash_h, expires_at, state FROM hashlocked_transfers WHERE id=$1 FOR UPDATE',
        [id],
      );
      const hl = rows[0];
      if (!hl) return { error: 'BAD_REQUEST' as const, message: 'unknown hashlock', status: 404 };
      if (hl.recipient_email !== s.email) return { error: 'UNAUTHORIZED' as const, message: 'not the recipient', status: 403 };
      if (hl.state !== 'PENDING') return { error: 'BAD_REQUEST' as const, message: `hashlock is ${hl.state}`, status: 409 };
      if (hl.expires_at.getTime() < Date.now()) return { error: 'BAD_REQUEST' as const, message: 'hashlock expired', status: 410 };

      // Verify preimage.
      if (!computedHash.equals(hl.hash_h)) {
        return { error: 'BAD_REQUEST' as const, message: 'preimage does not match hash', status: 400 };
      }

      // Reissue tokens to recipient (same pattern as send.ts).
      const { rows: locked } = await c.query<{ id: string }>(
        `SELECT id FROM tokens WHERE hashlock_id=$1 AND state='HASHLOCKED' FOR UPDATE`,
        [hl.id],
      );

      const ownerHash = createHash('sha256').update(hl.recipient_email).digest('hex');
      const issuedAt = new Date();

      for (const t of locked) {
        const newId = randomUUID();
        const sig = signTokenPayload(
          { id: newId, owner_email_hash: ownerHash, value: 1, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        await c.query(
          `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
           VALUES($1, $2, 1, 'VALID', $3, $4, $5)`,
          [newId, hl.recipient_email, issuedAt, t.id, sig],
        );
      }

      // Mark claimed.
      await c.query(
        `UPDATE hashlocked_transfers SET state='CLAIMED', preimage=$1, claimed_at=now() WHERE id=$2`,
        [preimage, hl.id],
      );

      return { hashlock_id: hl.id, state: 'CLAIMED', amount: hl.amount, preimage_hex: parsed.data.preimage_hex };
    });

    if ('error' in result) return reply.code(result.status).send({ error: result.error, message: result.message });
    return result;
  });

  /**
   * POST /hashlock/:id/refund — reclaim tokens after expiry.
   *
   * Authenticated as sender. Only works after expires_at.
   */
  app.post('/hashlock/:id/refund', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { id } = req.params as { id: string };

    const result = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; amount: number; expires_at: Date; state: string;
      }>(
        'SELECT id, sender_email, amount, expires_at, state FROM hashlocked_transfers WHERE id=$1 FOR UPDATE',
        [id],
      );
      const hl = rows[0];
      if (!hl) return { error: 'BAD_REQUEST' as const, message: 'unknown hashlock', status: 404 };
      if (hl.sender_email !== s.email) return { error: 'UNAUTHORIZED' as const, message: 'not the sender', status: 403 };
      if (hl.state !== 'PENDING') return { error: 'BAD_REQUEST' as const, message: `hashlock is ${hl.state}`, status: 409 };
      if (hl.expires_at.getTime() > Date.now()) return { error: 'BAD_REQUEST' as const, message: 'hashlock not yet expired', status: 400 };

      // Unlock tokens back to sender.
      await c.query(
        `UPDATE tokens SET state='VALID', hashlock_id=NULL WHERE hashlock_id=$1 AND state='HASHLOCKED'`,
        [hl.id],
      );

      await c.query(
        `UPDATE hashlocked_transfers SET state='REFUNDED', refunded_at=now() WHERE id=$1`,
        [hl.id],
      );

      return { hashlock_id: hl.id, state: 'REFUNDED', amount: hl.amount };
    });

    if ('error' in result) return reply.code(result.status).send({ error: result.error, message: result.message });
    return result;
  });

  /**
   * GET /hashlock/:id — public. Check hashlock status.
   *
   * Counterparty uses this to verify the lock exists before paying.
   */
  app.get('/hashlock/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await app.pool.query<{
      id: string; sender_email: string; recipient_email: string;
      amount: number; hash_h: Buffer; expires_at: Date; state: string;
      preimage: Buffer | null; created_at: Date; claimed_at: Date | null;
    }>(
      'SELECT id, sender_email, recipient_email, amount, hash_h, expires_at, state, preimage, created_at, claimed_at FROM hashlocked_transfers WHERE id=$1',
      [id],
    );
    const hl = rows[0];
    if (!hl) return reply.code(404).send({ error: 'NOT_FOUND', message: 'unknown hashlock' });

    return {
      hashlock_id: hl.id,
      sender_email: hl.sender_email,
      recipient_email: hl.recipient_email,
      amount: hl.amount,
      hash_h_hex: hl.hash_h.toString('hex'),
      expires_at: hl.expires_at.toISOString(),
      state: hl.state,
      preimage_hex: hl.preimage?.toString('hex') ?? null,
      created_at: hl.created_at.toISOString(),
      claimed_at: hl.claimed_at?.toISOString() ?? null,
    };
  });
}
