import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';
import { isAllowed, readTermsAcceptedAt } from './allowlist.js';

async function gate(app: FastifyInstance, req: any, reply: any): Promise<string | null> {
  const s = readSession(req, app.config.sessionSecret);
  if (!s) { reply.code(401).send({ error: 'UNAUTHORIZED' }); return null; }
  if (!isAllowed(app.config.ammAllowedEmails, s.email)) {
    reply.code(403).send({ error: 'NOT_ALLOWED' }); return null;
  }
  if (!(await readTermsAcceptedAt(app, s.email))) {
    reply.code(403).send({ error: 'TERMS_NOT_ACCEPTED' }); return null;
  }
  return s.email;
}

export async function walletRoutes(app: FastifyInstance) {
  app.get('/amm/wallet/status', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const r = await app.pool.query<{ solana_pubkey: string | null }>(
      `SELECT solana_pubkey FROM users WHERE email = $1`,
      [email],
    );
    reply.code(200).send({ linked_pubkey: r.rows[0]?.solana_pubkey ?? null });
  });

  app.post('/amm/wallet/unlink', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const prior = await app.pool.query<{ solana_pubkey: string | null }>(
      `SELECT solana_pubkey FROM users WHERE email = $1`,
      [email],
    );
    const priorPk = prior.rows[0]?.solana_pubkey ?? null;
    await app.pool.query(`UPDATE users SET solana_pubkey = NULL WHERE email = $1`, [email]);
    reply.code(200).send({ unlinked_pubkey: priorPk });
  });

  app.post('/amm/wallet/link-challenge', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const nonce = (await import('node:crypto'))
      .randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { sealEnvelope, buildLinkMessage } = await import('../../amm/wallet-link.js');
    const nonce_envelope = sealEnvelope(app.config.ammLinkHmacSecret, { email, nonce, expiresAt });
    const message = buildLinkMessage({ email, nonce, expiresAt });
    reply.code(200).send({ message, nonce_envelope });
  });

  app.post('/amm/wallet/link-confirm', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const body = req.body as { pubkey?: string; signature_b58?: string; nonce_envelope?: string };
    if (!body?.pubkey || !body?.signature_b58 || !body?.nonce_envelope) {
      return reply.code(400).send({ error: 'BAD_REQUEST' });
    }

    const { openEnvelope, buildLinkMessage, verifySolanaSignature } = await import('../../amm/wallet-link.js');

    // 1. Envelope.
    let payload;
    try { payload = openEnvelope(app.config.ammLinkHmacSecret, body.nonce_envelope); }
    catch { return reply.code(400).send({ error: 'CHALLENGE_EXPIRED' }); }
    if (payload.email !== email) return reply.code(400).send({ error: 'CHALLENGE_EXPIRED' });
    if (new Date(payload.expiresAt).getTime() < Date.now()) {
      return reply.code(400).send({ error: 'CHALLENGE_EXPIRED' });
    }

    // 2. Signature.
    const message = buildLinkMessage(payload);
    if (!verifySolanaSignature({ message, signatureB58: body.signature_b58, pubkeyB58: body.pubkey })) {
      return reply.code(400).send({ error: 'BAD_SIGNATURE' });
    }

    // 3. Atomic link + retro-attribute.
    const { withTx } = await import('../../db.js');
    try {
      const result = await withTx(app.pool, async (c) => {
        const existing = await c.query<{ solana_pubkey: string | null }>(
          `SELECT solana_pubkey FROM users WHERE email = $1 FOR UPDATE`,
          [email],
        );
        if (existing.rows[0]?.solana_pubkey) throw new Error('ALREADY_LINKED');

        try {
          await c.query(`UPDATE users SET solana_pubkey = $1 WHERE email = $2`, [body.pubkey, email]);
        } catch (e: any) {
          if (String(e.code) === '23505') throw new Error('PUBKEY_IN_USE');
          throw e;
        }

        // Retro-attribution.
        const unattributed = await c.query<{
          id: string; amount_base_units: string; solana_signature: string; sender_pubkey: string; block_time: Date | null;
        }>(
          `SELECT id, amount_base_units::text, solana_signature, sender_pubkey, block_time
             FROM usdc_unattributed_deposits
            WHERE sender_pubkey = $1 AND claimed_by_email IS NULL
            FOR UPDATE`,
          [body.pubkey],
        );
        let total = 0n;
        for (const r of unattributed.rows) {
          const amt = BigInt(r.amount_base_units);
          await c.query(`
            INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey, block_time)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (solana_signature) DO NOTHING
          `, [email, amt.toString(), r.solana_signature, r.sender_pubkey, r.block_time]);
          await c.query(`
            UPDATE usdc_unattributed_deposits
               SET claimed_by_email = $1, claimed_at = now()
             WHERE id = $2
          `, [email, r.id]);
          total += amt;
        }
        if (total > 0n) {
          await c.query(
            `UPDATE users SET usdc_base_units = usdc_base_units + $1 WHERE email = $2`,
            [total.toString(), email],
          );
        }
        return { count: unattributed.rows.length, total_base_units: total.toString() };
      });

      reply.code(200).send({ linked_pubkey: body.pubkey, retro_attributed: result });
    } catch (e: any) {
      if (e.message === 'ALREADY_LINKED') return reply.code(409).send({ error: 'ALREADY_LINKED' });
      if (e.message === 'PUBKEY_IN_USE') return reply.code(409).send({ error: 'PUBKEY_IN_USE' });
      throw e;
    }
  });
}
