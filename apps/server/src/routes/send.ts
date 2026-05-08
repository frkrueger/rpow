import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const Body = z.object({
  recipient_email: z.string().email(),
  amount: z.number().int().positive().max(1_000_000),
  idempotency_key: z.string().min(8).max(80),
});

const PENDING_TTL_DAYS = 30;
const PendingParams = z.object({ id: z.string().uuid() });

type PendingStatus = 'pending' | 'expired' | 'claimed' | 'canceled';

interface PendingTransferRow {
  id: string;
  sender_email: string;
  recipient_email: string;
  amount: number;
  created_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  canceled_at: Date | null;
}

function pendingStatus(row: Pick<PendingTransferRow, 'expires_at' | 'claimed_at' | 'canceled_at'>): PendingStatus {
  if (row.canceled_at) return 'canceled';
  if (row.claimed_at) return 'claimed';
  if (row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

async function sendClaimEmail(app: FastifyInstance, pending: { sender_email: string; recipient_email: string; amount: number }, claimToken: string): Promise<void> {
  const claimUrl = `${app.config.webOrigin}/#/claim?token=${claimToken}`;
  const sender = pending.sender_email;
  const recipient = pending.recipient_email;
  const amount = pending.amount;
  const subject = `${sender} sent you ${amount} RPOW`;
  const text = `${sender} sent you ${amount} RPOW (Reusable Proofs of Work) on rpow2.com.\n\nClick to claim:\n${claimUrl}\n\nLink expires in ${PENDING_TTL_DAYS} days.\n\n--\nrpow2.com — a modern tribute to a tribute to the original rpow by hal finney`;
  const safeSender = escapeHtml(sender);
  const safeClaimUrl = escapeHtml(claimUrl);
  const html = `<div style="font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;background:#0b0b0b;color:#e8e3d3;padding:24px;max-width:560px;margin:0 auto;">
  <p style="margin:0 0 16px 0;font-size:14px;"><strong style="color:#6ee7b7;">${safeSender}</strong> just sent you <strong style="color:#6ee7b7;">${amount} RPOW</strong> (Reusable Proofs of Work) on <a href="https://rpow2.com" style="color:#6ee7b7;">rpow2.com</a>.</p>
  <p style="margin:0 0 24px 0;"><a href="${safeClaimUrl}" style="background:#6ee7b7;color:#0b0b0b;padding:10px 18px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block;">[ CLAIM ${amount} RPOW ]</a></p>
  <p style="font-size:12px;color:#888;margin:0 0 8px 0;">Or paste this link in your browser:</p>
  <p style="font-size:11px;color:#aaa;margin:0 0 24px 0;word-break:break-all;"><a href="${safeClaimUrl}" style="color:#aaa;">${safeClaimUrl}</a></p>
  <hr style="border:none;border-top:1px solid #333;margin:24px 0;">
  <p style="font-size:11px;color:#666;margin:0;">Link expires in ${PENDING_TTL_DAYS} days. rpow2.com — a modern tribute to a tribute to the original rpow by hal finney.</p>
</div>`;

  await app.mailer.send({ to: recipient, subject, text, html });
}

function serializePending(row: PendingTransferRow) {
  return {
    id: row.id,
    recipient_email: row.recipient_email,
    amount: row.amount,
    status: pendingStatus(row),
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    claimed_at: row.claimed_at?.toISOString() ?? null,
    canceled_at: row.canceled_at?.toISOString() ?? null,
  };
}

async function getPendingForSender(c: PoolClient, id: string, sender: string): Promise<PendingTransferRow | null> {
  const { rows } = await c.query<PendingTransferRow>(
    `SELECT id, sender_email, recipient_email, amount, created_at, expires_at, claimed_at, canceled_at
     FROM pending_transfers
     WHERE id=$1 AND sender_email=$2
     FOR UPDATE`,
    [id, sender],
  );
  return rows[0] ?? null;
}

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const amount = parsed.data.amount;
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });

    type SendResult =
      | { ok: true; transferred: number; recipient_email: string; transfer_id: string; pending?: boolean }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE'; message: string; status: number };

    let out!: SendResult;
    try {
      out = await withTx<SendResult>(app.pool, async (c) => {
        // Idempotency: check both transfers and pending_transfers tables.
        const txDup = await c.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM transfers WHERE sender_email=$1 AND idempotency_key=$2', [sender, idem],
        );
        if (txDup.rows[0]) {
          if (txDup.rows[0].recipient_email !== recipient || txDup.rows[0].amount !== amount) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, transferred: txDup.rows[0].amount, recipient_email: txDup.rows[0].recipient_email, transfer_id: txDup.rows[0].id };
        }
        const ptDup = await c.query<{ id: string; recipient_email: string; amount: number; canceled_at: Date | null }>(
          'SELECT id, recipient_email, amount, canceled_at FROM pending_transfers WHERE sender_email=$1 AND idempotency_key=$2', [sender, idem],
        );
        if (ptDup.rows[0]) {
          if (ptDup.rows[0].canceled_at) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key refers to a canceled pending transfer', status: 409 };
          }
          if (ptDup.rows[0].recipient_email !== recipient || ptDup.rows[0].amount !== amount) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return { ok: true as const, pending: true, transferred: ptDup.rows[0].amount, recipient_email: ptDup.rows[0].recipient_email, transfer_id: ptDup.rows[0].id };
        }

        // Lock and check balance (same for both paths).
        const lockSql = `SELECT id FROM tokens
          WHERE owner_email=$1 AND state='VALID'
          ORDER BY issued_at ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`;
        const { rows: locked } = await c.query<{ id: string }>(lockSql, [sender, amount]);
        if (locked.length < amount) return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };

        const recipientExists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);

        if (recipientExists.rowCount) {
          // Existing recipient: invalidate sender tokens, mint fresh tokens for recipient.
          const transferId = randomUUID();
          const ownerHash = createHash('sha256').update(recipient).digest('hex');
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
              [newId, recipient, issuedAt, t.id, sig],
            );
          }

          await c.query(
            'INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key) VALUES($1,$2,$3,$4,$5)',
            [transferId, sender, recipient, amount, idem],
          );
          return { ok: true as const, transferred: amount, recipient_email: recipient, transfer_id: transferId };
        }

        // Recipient does not exist: invalidate sender tokens and create a pending claim.
        for (const t of locked) {
          await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        }

        const claimToken = randomBytes(32).toString('base64url');
        const claimTokenHash = createHash('sha256').update(claimToken).digest();
        const pendingId = randomUUID();
        const expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);

        await c.query(
          `INSERT INTO pending_transfers
           (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [pendingId, sender, recipient, amount, idem, claimTokenHash, expiresAt],
        );
        for (const t of locked) {
          await c.query(
            'INSERT INTO pending_transfer_tokens(pending_transfer_id, token_id) VALUES($1,$2)',
            [pendingId, t.id],
          );
        }

        // Email send is inside the transaction so a failure rolls back the invalidation.
        await sendClaimEmail(app, { sender_email: sender, recipient_email: recipient, amount }, claimToken);

        return { ok: true as const, transferred: amount, recipient_email: recipient, transfer_id: pendingId, pending: true };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_email: string; amount: number }>(
          'SELECT id, recipient_email, amount FROM transfers WHERE sender_email=$1 AND idempotency_key=$2', [sender, idem],
        );
        if (tx.rows[0]) {
          if (tx.rows[0].recipient_email !== recipient || tx.rows[0].amount !== amount) {
            return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key reused with different parameters' });
          }
          return reply.send({ ok: true, transferred: tx.rows[0].amount, recipient_email: tx.rows[0].recipient_email, transfer_id: tx.rows[0].id });
        }
        const pt = await app.pool.query<{ id: string; recipient_email: string; amount: number; canceled_at: Date | null }>(
          'SELECT id, recipient_email, amount, canceled_at FROM pending_transfers WHERE sender_email=$1 AND idempotency_key=$2', [sender, idem],
        );
        if (pt.rows[0]) {
          if (pt.rows[0].canceled_at) {
            return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key refers to a canceled pending transfer' });
          }
          if (pt.rows[0].recipient_email !== recipient || pt.rows[0].amount !== amount) {
            return reply.code(409).send({ error: 'BAD_REQUEST', message: 'idempotency_key reused with different parameters' });
          }
          return reply.send({ ok: true, pending: true, transferred: pt.rows[0].amount, recipient_email: pt.rows[0].recipient_email, transfer_id: pt.rows[0].id });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  async function listPending(req: FastifyRequest, reply: FastifyReply, shape: 'object' | 'array') {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { rows } = await app.pool.query<PendingTransferRow>(
      `SELECT id, sender_email, recipient_email, amount, created_at, expires_at, claimed_at, canceled_at
       FROM pending_transfers
       WHERE sender_email=$1
      ORDER BY created_at DESC`,
      [s.email],
    );
    const serialized = rows.map(serializePending);
    return shape === 'array' ? serialized : { pending_transfers: serialized };
  }

  async function resendPending(req: FastifyRequest, reply: FastifyReply) {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = PendingParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid pending transfer id' });

    type ResendResult =
      | { ok: true; pending: ReturnType<typeof serializePending> }
      | { error: 'BAD_REQUEST' | 'NOT_FOUND'; message: string; status: number };

    const out = await withTx<ResendResult>(app.pool, async (c) => {
      const pending = await getPendingForSender(c, parsed.data.id, s.email);
      if (!pending) return { error: 'NOT_FOUND' as const, message: 'pending transfer not found', status: 404 };
      if (pending.claimed_at) return { error: 'BAD_REQUEST' as const, message: 'pending transfer has already been claimed', status: 409 };
      if (pending.canceled_at) return { error: 'BAD_REQUEST' as const, message: 'pending transfer has been canceled', status: 409 };

      const claimToken = randomBytes(32).toString('base64url');
      const claimTokenHash = createHash('sha256').update(claimToken).digest();
      const expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);
      const { rows } = await c.query<PendingTransferRow>(
        `UPDATE pending_transfers
         SET claim_token_hash=$1, expires_at=$2
         WHERE id=$3
         RETURNING id, sender_email, recipient_email, amount, created_at, expires_at, claimed_at, canceled_at`,
        [claimTokenHash, expiresAt, pending.id],
      );
      const updated = rows[0]!;
      await sendClaimEmail(app, updated, claimToken);
      return { ok: true as const, pending: serializePending(updated) };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return { ok: true, ...out.pending };
  }

  async function cancelPending(req: FastifyRequest, reply: FastifyReply) {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = PendingParams.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid pending transfer id' });

    type CancelResult =
      | { ok: true; pending: ReturnType<typeof serializePending>; reclaimed: number }
      | { error: 'BAD_REQUEST' | 'NOT_FOUND'; message: string; status: number };

    const out = await withTx<CancelResult>(app.pool, async (c) => {
      const pending = await getPendingForSender(c, parsed.data.id, s.email);
      if (!pending) return { error: 'NOT_FOUND' as const, message: 'pending transfer not found', status: 404 };
      if (pending.claimed_at) return { error: 'BAD_REQUEST' as const, message: 'pending transfer has already been claimed', status: 409 };
      if (pending.canceled_at) return { ok: true as const, pending: serializePending(pending), reclaimed: 0 };

      const tokenIds = await c.query<{ token_id: string }>(
        `SELECT token_id
         FROM pending_transfer_tokens
         WHERE pending_transfer_id=$1`,
        [pending.id],
      );
      let reclaimed = 0;
      if (tokenIds.rows.length) {
        const tokenIdValues = tokenIds.rows.map((r) => r.token_id);
        const restored = await c.query(
          `UPDATE tokens
           SET state='VALID', invalidated_at=NULL
           WHERE id = ANY($1::uuid[])
             AND owner_email=$2
             AND state='INVALIDATED'`,
          [tokenIdValues, s.email],
        );
        reclaimed = restored.rowCount ?? 0;
      }

      const { rows } = await c.query<PendingTransferRow>(
        `UPDATE pending_transfers
         SET canceled_at=now()
         WHERE id=$1
         RETURNING id, sender_email, recipient_email, amount, created_at, expires_at, claimed_at, canceled_at`,
        [pending.id],
      );
      return { ok: true as const, pending: serializePending(rows[0]!), reclaimed };
    });

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return { ok: true, ...out.pending, reclaimed: out.reclaimed };
  }

  app.get('/send/pending', (req, reply) => listPending(req, reply, 'object'));
  app.get('/pending-transfers', (req, reply) => listPending(req, reply, 'array'));
  app.post('/send/pending/:id/resend', resendPending);
  app.post('/pending-transfers/:id/resend', resendPending);
  app.post('/send/pending/:id/cancel', cancelPending);
  app.post('/pending-transfers/:id/cancel', cancelPending);
}
