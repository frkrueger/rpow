import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readAuth } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const CreateBody = z.object({
  recipient_email: z.string().email(),
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
  hash_h_hex: z.string().regex(/^[0-9a-f]{64}$/),
  timeout_seconds: z.number().int().min(60).max(604800).default(14400),
  idempotency_key: z.string().min(8).max(80),
});

const ClaimBody = z.object({
  preimage_hex: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function hashlockRoutes(app: FastifyInstance) {

  // ── Create ────────────────────────────────────────────────────────
  app.post('/hashlock', async (req, reply) => {
    const s = await readAuth(req, app);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const target = BigInt(parsed.data.amount_base_units);
    const hashH = Buffer.from(parsed.data.hash_h_hex, 'hex');
    const timeoutSec = parsed.data.timeout_seconds;
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot hashlock to self' });
    }

    type HlResult =
      | { hashlock_id: string; recipient_email: string; amount_base_units: string; expires_at: string; state: string }
      | { error: string; message: string; status: number };

    let out!: HlResult;
    try {
      out = await withTx<HlResult>(app.pool, async (c) => {
        // ── Idempotency ─────────────────────────────────────────────
        const dup = await c.query<{
          id: string; recipient_email: string; amount: string;
          hash_h: Buffer; expires_at: Date; state: string;
        }>(
          `SELECT id, recipient_email, amount::text AS amount, hash_h, expires_at, state
           FROM hashlocked_transfers WHERE idempotency_key = $1`,
          [idem],
        );
        if (dup.rows[0]) {
          const row = dup.rows[0];
          if (row.recipient_email !== recipient || BigInt(row.amount) !== target || !row.hash_h.equals(hashH)) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return {
            hashlock_id: row.id,
            recipient_email: row.recipient_email,
            amount_base_units: row.amount,
            expires_at: row.expires_at.toISOString(),
            state: row.state,
          };
        }

        // ── Ensure recipient row exists ─────────────────────────────
        await c.query(
          'INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING',
          [recipient],
        );

        // ── Accumulate tokens ───────────────────────────────────────
        const { rows: pool } = await c.query<{ id: string; value: string }>(
          `SELECT id, value::text AS value FROM tokens
           WHERE owner_email = $1 AND state = 'VALID'
           ORDER BY value DESC, id ASC
           FOR UPDATE SKIP LOCKED`,
          [sender],
        );

        const picked: { id: string; value: bigint }[] = [];
        let total = 0n;
        for (const row of pool) {
          const v = BigInt(row.value);
          picked.push({ id: row.id, value: v });
          total += v;
          if (total >= target) break;
        }
        // Trim unnecessary trailing tokens.
        while (picked.length > 1) {
          const tail = picked[picked.length - 1].value;
          if (total - tail >= target) { total -= tail; picked.pop(); }
          else break;
        }
        if (total < target) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
        }

        const change = total - target;
        const hlId = randomUUID();
        const expiresAt = new Date(Date.now() + timeoutSec * 1000);

        // ── Insert hashlock record ──────────────────────────────────
        await c.query(
          `INSERT INTO hashlocked_transfers
           (id, sender_email, recipient_email, amount, hash_h, idempotency_key,
            timeout_seconds, expires_at, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`,
          [hlId, sender, recipient, target.toString(), hashH, idem, timeoutSec, expiresAt],
        );

        // ── Lock consumed tokens ────────────────────────────────────
        await c.query(
          `UPDATE tokens SET state = 'HASHLOCKED', hashlock_id = $1
           WHERE id = ANY($2::uuid[])`,
          [hlId, picked.map(t => t.id)],
        );

        // ── Issue change token back to sender ───────────────────────
        if (change > 0n) {
          const changeId = randomUUID();
          const issuedAt = new Date();
          const senderHash = createHash('sha256').update(sender).digest('hex');
          const changeSig = signTokenPayload(
            { id: changeId, owner_email_hash: senderHash, value: change, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
             VALUES ($1, $2, $3, 'VALID', $4, $5, $6)`,
            [changeId, sender, change.toString(), issuedAt, picked[0].id, changeSig],
          );
        }

        return {
          hashlock_id: hlId,
          recipient_email: recipient,
          amount_base_units: target.toString(),
          expires_at: expiresAt.toISOString(),
          state: 'PENDING',
        };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const existing = await app.pool.query<{
          id: string; recipient_email: string; amount: string; expires_at: Date; state: string;
        }>(
          'SELECT id, recipient_email, amount::text AS amount, expires_at, state FROM hashlocked_transfers WHERE idempotency_key = $1',
          [idem],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          return reply.send({
            hashlock_id: row.id,
            recipient_email: row.recipient_email,
            amount_base_units: row.amount,
            expires_at: row.expires_at.toISOString(),
            state: row.state,
          });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });

  // ── Claim ─────────────────────────────────────────────────────────
  app.post('/hashlock/:id/claim', async (req, reply) => {
    const s = await readAuth(req, app);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { id } = req.params as { id: string };
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const preimage = Buffer.from(parsed.data.preimage_hex, 'hex');
    const computedHash = createHash('sha256').update(preimage).digest();

    const result = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; recipient_email: string;
        amount: string; hash_h: Buffer; expires_at: Date; state: string;
      }>(
        `SELECT id, sender_email, recipient_email, amount::text AS amount,
                hash_h, expires_at, state
         FROM hashlocked_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const hl = rows[0];
      if (!hl) return { error: 'NOT_FOUND' as const, message: 'unknown hashlock', status: 404 };
      if (hl.recipient_email !== s.email) return { error: 'UNAUTHORIZED' as const, message: 'not the recipient', status: 403 };
      if (hl.state !== 'PENDING') return { error: 'BAD_REQUEST' as const, message: `hashlock is ${hl.state}`, status: 409 };
      if (hl.expires_at.getTime() < Date.now()) return { error: 'BAD_REQUEST' as const, message: 'hashlock expired', status: 410 };

      if (!computedHash.equals(hl.hash_h)) {
        return { error: 'BAD_REQUEST' as const, message: 'preimage does not match hash', status: 400 };
      }

      // ── Invalidate locked tokens ────────────────────────────────
      const { rows: locked } = await c.query<{ id: string; value: string }>(
        `SELECT id, value::text AS value FROM tokens
         WHERE hashlock_id = $1 AND state = 'HASHLOCKED' FOR UPDATE`,
        [hl.id],
      );

      await c.query(
        `UPDATE tokens SET state = 'INVALIDATED', invalidated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [locked.map(t => t.id)],
      );

      // ── Mint recipient token ────────────────────────────────────
      const recipientTokenId = randomUUID();
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(hl.recipient_email).digest('hex');
      const amount = BigInt(hl.amount);
      const recipientSig = signTokenPayload(
        { id: recipientTokenId, owner_email_hash: ownerHash, value: amount, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
         VALUES ($1, $2, $3, 'VALID', $4, $5, $6)`,
        [recipientTokenId, hl.recipient_email, amount.toString(), issuedAt, locked[0]?.id ?? null, recipientSig],
      );

      // ── Update hashlock ─────────────────────────────────────────
      await c.query(
        `UPDATE hashlocked_transfers SET state = 'CLAIMED', preimage = $1, claimed_at = now()
         WHERE id = $2`,
        [preimage, hl.id],
      );

      return {
        hashlock_id: hl.id,
        state: 'CLAIMED' as const,
        amount_base_units: hl.amount,
        preimage_hex: parsed.data.preimage_hex,
      };
    });

    if ('error' in result) return reply.code(result.status!).send({ error: result.error, message: result.message });
    return result;
  });

  // ── Refund ────────────────────────────────────────────────────────
  app.post('/hashlock/:id/refund', async (req, reply) => {
    const s = await readAuth(req, app);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { id } = req.params as { id: string };

    const result = await withTx(app.pool, async (c) => {
      const { rows } = await c.query<{
        id: string; sender_email: string; amount: string;
        expires_at: Date; state: string;
      }>(
        `SELECT id, sender_email, amount::text AS amount, expires_at, state
         FROM hashlocked_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const hl = rows[0];
      if (!hl) return { error: 'NOT_FOUND' as const, message: 'unknown hashlock', status: 404 };
      if (hl.sender_email !== s.email) return { error: 'UNAUTHORIZED' as const, message: 'not the sender', status: 403 };
      if (hl.state !== 'PENDING') return { error: 'BAD_REQUEST' as const, message: `hashlock is ${hl.state}`, status: 409 };
      if (hl.expires_at.getTime() > Date.now()) return { error: 'BAD_REQUEST' as const, message: 'hashlock not yet expired', status: 400 };

      // ── Unlock tokens ───────────────────────────────────────────
      await c.query(
        `UPDATE tokens SET state = 'VALID', hashlock_id = NULL
         WHERE hashlock_id = $1 AND state = 'HASHLOCKED'`,
        [hl.id],
      );

      await c.query(
        `UPDATE hashlocked_transfers SET state = 'REFUNDED', refunded_at = now()
         WHERE id = $1`,
        [hl.id],
      );

      return { hashlock_id: hl.id, state: 'REFUNDED' as const, amount_base_units: hl.amount };
    });

    if ('error' in result) return reply.code(result.status!).send({ error: result.error, message: result.message });
    return result;
  });

  // ── Get ───────────────────────────────────────────────────────────
  app.get('/hashlock/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await app.pool.query<{
      id: string; sender_email: string; recipient_email: string;
      amount: string; hash_h: Buffer; expires_at: Date; state: string;
      preimage: Buffer | null; created_at: Date; claimed_at: Date | null;
    }>(
      `SELECT id, sender_email, recipient_email, amount::text AS amount,
              hash_h, expires_at, state, preimage, created_at, claimed_at
       FROM hashlocked_transfers WHERE id = $1`,
      [id],
    );
    const hl = rows[0];
    if (!hl) return reply.code(404).send({ error: 'NOT_FOUND', message: 'unknown hashlock' });

    return {
      hashlock_id: hl.id,
      sender_email: hl.sender_email,
      recipient_email: hl.recipient_email,
      amount_base_units: hl.amount,
      hash_h_hex: hl.hash_h.toString('hex'),
      expires_at: hl.expires_at.toISOString(),
      state: hl.state,
      preimage_hex: hl.preimage?.toString('hex') ?? null,
      created_at: hl.created_at.toISOString(),
      claimed_at: hl.claimed_at?.toISOString() ?? null,
    };
  });
}
