import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { readAuth } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { makeUnsubToken } from '../unsub.js';
import { claimEmail } from '../email-template.js';

const Body = z.object({
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
  idempotency_key: z.string().min(8).max(80),
});

const PENDING_TTL_DAYS = 30;

function formatRpow(baseUnits: bigint): string {
  const denom = 1_000_000_000n;
  const whole = baseUnits / denom;
  const frac = baseUnits % denom;
  if (frac === 0n) return `${whole}`;
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export async function sendRoutes(app: FastifyInstance) {
  app.post('/send', {
    // Pre-resolve auth in a preHandler so the rate-limit hook (also preHandler)
    // can read req.viaApiKey/apiKeyHash without re-parsing the header. Fastify
    // runs preHandlers in registration order; this one fires before rate-limit.
    preHandler: async (req: any, reply) => {
      const s = await readAuth(req, app);
      if (!s) {
        await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
        return;
      }
      req.resolvedAuth = s;
    },
    config: {
      // Burst cap: 10 sends per second per API key. Skipped entirely for
      // session auth via allowList returning true (which means "allow, skip limit").
      rateLimit: {
        max: 10,
        timeWindow: '1 second',
        hook: 'preHandler',
        // keyGenerator runs before allowList(), so we must return a non-null key
        // even when allowList will discard the limit check. __skip__ prefix is
        // a non-colliding bucket Fastify never reads.
        keyGenerator: (req: any) => req.apiKeyHash ?? `__skip__:${req.ip}`,
        allowList: (req: any) => !req.viaApiKey,
        errorResponseBuilder: (_req: any, ctx: any) => {
          const err: any = {
            error: 'RATE_LIMITED',
            message: 'API key burst limit (10/sec) exceeded',
            retry_after: Math.ceil(ctx.ttl / 1000),
          };
          err.statusCode = 429;
          return err;
        },
      },
    },
  }, async (req, reply) => {
    const s = (req as any).resolvedAuth as { email: string; viaApiKey: boolean };
    // (No 401 check needed — the preHandler already short-circuited on missing auth.)

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    if (s.viaApiKey) {
      // Per-account, not per-key: counts ALL transfers (including session-authed)
      // from this email in the last hour. Equivalent to per-key under the
      // one-key-per-account spec.
      const { rows } = await app.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM transfers
         WHERE sender_email = $1 AND created_at > now() - interval '1 hour'`,
        [s.email],
      );
      if (BigInt(rows[0].n) >= 1000n) {
        return reply.code(429).send({ error: 'RATE_LIMITED', message: 'hourly send cap (1000) reached', retry_after: 3600 });
      }
    }

    const sender = s.email;
    const recipient = parsed.data.recipient_email.toLowerCase().trim();
    const amount_base_units = parsed.data.amount_base_units;
    const target = BigInt(amount_base_units);
    const idem = parsed.data.idempotency_key;

    if (recipient === sender) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'cannot send to self' });

    type SendResult =
      | { ok: true; transferred_base_units: string; recipient_email: string; transfer_id: string; pending?: boolean }
      | { error: 'BAD_REQUEST' | 'INSUFFICIENT_BALANCE' | 'RECIPIENT_UNSUBSCRIBED'; message: string; status: number };

    let out!: SendResult;
    try {
      out = await withTx<SendResult>(app.pool, async (c) => {
        // Idempotency: check both transfers and pending_transfers tables.
        // amount columns are now BIGINT base units; read as text and compare bigints.
        const txDup = await c.query<{ id: string; recipient_email: string; amount: string }>(
          'SELECT id, recipient_email, amount::text AS amount FROM transfers WHERE idempotency_key=$1',
          [idem],
        );
        if (txDup.rows[0]) {
          if (txDup.rows[0].recipient_email !== recipient || BigInt(txDup.rows[0].amount) !== target) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return {
            ok: true as const,
            transferred_base_units: txDup.rows[0].amount,
            recipient_email: txDup.rows[0].recipient_email,
            transfer_id: txDup.rows[0].id,
          };
        }
        const ptDup = await c.query<{ id: string; recipient_email: string; amount: string }>(
          'SELECT id, recipient_email, amount::text AS amount FROM pending_transfers WHERE idempotency_key=$1',
          [idem],
        );
        if (ptDup.rows[0]) {
          if (ptDup.rows[0].recipient_email !== recipient || BigInt(ptDup.rows[0].amount) !== target) {
            return { error: 'BAD_REQUEST' as const, message: 'idempotency_key reused with different parameters', status: 409 };
          }
          return {
            ok: true as const,
            pending: true,
            transferred_base_units: ptDup.rows[0].amount,
            recipient_email: ptDup.rows[0].recipient_email,
            transfer_id: ptDup.rows[0].id,
          };
        }

        // Pull candidate tokens largest-first; FOR UPDATE locks them so concurrent
        // /send|/wrap calls don't race over the same rows. No LIMIT — we need the
        // full pool to pick an exact-sum subset.
        const { rows: pool } = await c.query<{ id: string; value: string }>(
          `SELECT id, value::text AS value FROM tokens
           WHERE owner_email=$1 AND state='VALID'
           ORDER BY value DESC, id ASC
           FOR UPDATE SKIP LOCKED`,
          [sender],
        );

        const totalAvailable = pool.reduce((acc, r) => acc + BigInt(r.value), 0n);
        if (totalAvailable < target) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
        }

        // Greedy largest-first: accumulate until sum >= target, then trim
        // unnecessary trailing tokens. Overshoot is handled by issuing a
        // change token back to the sender.
        const picked: { id: string; value: bigint }[] = [];
        let total = 0n;
        for (const row of pool) {
          const v = BigInt(row.value);
          picked.push({ id: row.id, value: v });
          total += v;
          if (total >= target) break;
        }
        while (picked.length > 1) {
          const tail = picked[picked.length - 1].value;
          if (total - tail >= target) { total -= tail; picked.pop(); }
          else break;
        }
        if (total < target) {
          return { error: 'INSUFFICIENT_BALANCE' as const, message: 'not enough tokens', status: 400 };
        }
        const change = total - target;

        const recipientExists = await c.query('SELECT 1 FROM users WHERE email=$1', [recipient]);

        if (recipientExists.rowCount) {
          const transferId = randomUUID();
          const issuedAt = new Date();

          // Invalidate sender tokens.
          for (const t of picked) {
            await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
          }

          // Mint a single token for the recipient with the exact target amount.
          const recipientHash = createHash('sha256').update(recipient).digest('hex');
          const recipientTokenId = randomUUID();
          const recipientSig = signTokenPayload(
            { id: recipientTokenId, owner_email_hash: recipientHash, value: target, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5, $6)`,
            [recipientTokenId, recipient, target.toString(), issuedAt, picked[0].id, recipientSig],
          );

          // Issue change back to sender if overshoot.
          if (change > 0n) {
            const senderHash = createHash('sha256').update(sender).digest('hex');
            const changeId = randomUUID();
            const changeSig = signTokenPayload(
              { id: changeId, owner_email_hash: senderHash, value: change, issued_at: issuedAt.toISOString() },
              app.config.signingPrivateKeyHex,
            );
            await c.query(
              `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
               VALUES($1, $2, $3, 'VALID', $4, $5, $6)`,
              [changeId, sender, change.toString(), issuedAt, picked[0].id, changeSig],
            );
          }

          await c.query(
            'INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key) VALUES($1,$2,$3,$4,$5)',
            [transferId, sender, recipient, target.toString(), idem],
          );
          return {
            ok: true as const,
            transferred_base_units: target.toString(),
            recipient_email: recipient,
            transfer_id: transferId,
          };
        }

        // Recipient does not exist: refuse if they've unsubscribed (we'd be
        // about to send a claim email that the recipient explicitly asked
        // not to receive). Reject before invalidating, so the sender's
        // tokens stay intact.
        const unsub = await c.query(
          `SELECT 1 FROM email_unsubscribes WHERE email=$1`,
          [recipient],
        );
        if (unsub.rowCount) {
          return { error: 'RECIPIENT_UNSUBSCRIBED' as const, message: 'recipient has unsubscribed and cannot receive RPOW transfers', status: 400 };
        }

        // Recipient does not exist: invalidate sender tokens, issue change, create pending claim.
        for (const t of picked) {
          await c.query(`UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1`, [t.id]);
        }
        if (change > 0n) {
          const senderHash = createHash('sha256').update(sender).digest('hex');
          const changeId = randomUUID();
          const issuedAt = new Date();
          const changeSig = signTokenPayload(
            { id: changeId, owner_email_hash: senderHash, value: change, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5, $6)`,
            [changeId, sender, change.toString(), issuedAt, picked[0].id, changeSig],
          );
        }

        const claimToken = randomBytes(32).toString('base64url');
        const claimTokenHash = createHash('sha256').update(claimToken).digest();
        const pendingId = randomUUID();
        const expiresAt = new Date(Date.now() + PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);

        await c.query(
          `INSERT INTO pending_transfers
           (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [pendingId, sender, recipient, target.toString(), idem, claimTokenHash, expiresAt],
        );

        const displayAmount = formatRpow(target);
        const claimUrl = `${app.config.magicLinkBaseUrl}/claim?token=${claimToken}`;
        const subject = `${sender} sent you ${displayAmount} RPOW`;
        const text = `${sender} sent you ${displayAmount} RPOW (Reusable Proofs of Work) on rpow2.com.\n\nClick to claim:\n${claimUrl}\n\nLink expires in ${PENDING_TTL_DAYS} days.\n\n--\nrpow2.com — a tribute to Hal Finney's original RPOW`;
        const html = claimEmail(sender, displayAmount, claimUrl, PENDING_TTL_DAYS);

        const unsubUrl = `${app.config.magicLinkBaseUrl}/unsubscribe?token=${makeUnsubToken(recipient, app.config.sessionSecret)}`;
        await app.mailer.send({
          to: recipient,
          subject,
          text,
          html,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        return {
          ok: true as const,
          transferred_base_units: target.toString(),
          recipient_email: recipient,
          transfer_id: pendingId,
          pending: true,
        };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        const tx = await app.pool.query<{ id: string; recipient_email: string; amount: string }>(
          'SELECT id, recipient_email, amount::text AS amount FROM transfers WHERE idempotency_key=$1',
          [idem],
        );
        if (tx.rows[0]) {
          return reply.send({
            ok: true,
            transferred_base_units: tx.rows[0].amount,
            recipient_email: tx.rows[0].recipient_email,
            transfer_id: tx.rows[0].id,
          });
        }
        const pt = await app.pool.query<{ id: string; recipient_email: string; amount: string }>(
          'SELECT id, recipient_email, amount::text AS amount FROM pending_transfers WHERE idempotency_key=$1',
          [idem],
        );
        if (pt.rows[0]) {
          return reply.send({
            ok: true,
            pending: true,
            transferred_base_units: pt.rows[0].amount,
            recipient_email: pt.rows[0].recipient_email,
            transfer_id: pt.rows[0].id,
          });
        }
      }
      throw e;
    }

    if ('error' in out) return reply.code(out.status).send({ error: out.error, message: out.message });
    return out;
  });
}
