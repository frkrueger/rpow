import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

const ListBody = z.object({
  token_id: z.string().uuid(),
  price_rpow: z.number().int().positive(),
});

const BuyBody = z.object({
  listing_id: z.string().uuid(),
  idempotency_key: z.string().min(8).max(80),
});

const CancelBody = z.object({
  listing_id: z.string().uuid(),
});

// Expire listings whose token is no longer VALID (e.g. token was transferred away).
// Called on GET /market and POST /market/buy so stale rows self-clean lazily.
async function expireStaleListings(pool: FastifyInstance['pool']) {
  await pool.query(
    `UPDATE listings
     SET status = 'cancelled', closed_at = now()
     WHERE status = 'active'
       AND token_id NOT IN (
         SELECT id FROM tokens WHERE state = 'VALID'
       )`,
  );
}

export async function marketRoutes(app: FastifyInstance) {
  // GET /market — public: browse active listings
  app.get('/market', async (_req, reply) => {
    await expireStaleListings(app.pool);
    const { rows } = await app.pool.query(
      `SELECT l.id, l.token_id, l.seller_email, l.price_rpow, l.created_at,
              t.issued_at
       FROM listings l
       JOIN tokens t ON t.id = l.token_id
       WHERE l.status = 'active' AND t.state = 'VALID'
       ORDER BY l.created_at DESC
       LIMIT 100`,
    );
    return reply.send({ listings: rows });
  });

  // POST /market/list — authenticated: list a valid owned token for sale
  app.post('/market/list', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = ListBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const { token_id, price_rpow } = parsed.data;
    const seller_email = s.email;

    const existing = await app.pool.query(
      `SELECT id FROM tokens WHERE id = $1 AND owner_email = $2 AND state = 'VALID'`,
      [token_id, seller_email],
    );
    if (!existing.rows[0]) {
      return reply.code(400).send({ error: 'TOKEN_NOT_FOUND', message: 'token not found or not owned by you' });
    }

    const id = randomUUID();
    await app.pool.query(
      `INSERT INTO listings (id, token_id, seller_email, price_rpow)
       VALUES ($1, $2, $3, $4)`,
      [id, token_id, seller_email, price_rpow],
    );

    return reply.send({ ok: true, listing_id: id });
  });

  // POST /market/buy — authenticated: buy a listed token
  // Payment is in RPOW tokens (deducted from buyer's own balance).
  // Uses the same burn-and-mint pattern as send.ts.
  app.post('/market/buy', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = BuyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const { listing_id, idempotency_key } = parsed.data;
    const buyer_email = s.email;

    await expireStaleListings(app.pool);

    type BuyResult =
      | { ok: true; sold_token_id: string }
      | { error: string; message: string; status: number };

    const result: BuyResult = await withTx(app.pool, async (c) => {
      // Idempotency: if this key already completed a sale, return it
      const dup = await c.query(
        `SELECT token_id FROM listings WHERE id = $1 AND status = 'sold'`,
        [listing_id],
      );
      if (dup.rows[0]) return { ok: true as const, sold_token_id: dup.rows[0].token_id };

      // Lock listing row
      const { rows: listRows } = await c.query(
        `SELECT l.id, l.token_id, l.seller_email, l.price_rpow, l.status, t.state
         FROM listings l
         JOIN tokens t ON t.id = l.token_id
         WHERE l.id = $1
         FOR UPDATE`,
        [listing_id],
      );
      const listing = listRows[0];
      if (!listing) return { error: 'NOT_FOUND', message: 'listing not found', status: 404 };
      if (listing.status !== 'active') return { error: 'NOT_AVAILABLE', message: 'listing is no longer active', status: 400 };
      if (listing.state !== 'VALID') return { error: 'TOKEN_INVALID', message: 'token is no longer valid', status: 400 };
      if (listing.seller_email === buyer_email) return { error: 'BAD_REQUEST', message: 'cannot buy your own listing', status: 400 };

      const price: number = listing.price_rpow;

      // Lock buyer payment tokens (oldest first, same pattern as send.ts)
      const { rows: payTokens } = await c.query(
        `SELECT id FROM tokens
         WHERE owner_email = $1 AND state = 'VALID'
         ORDER BY issued_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [buyer_email, price],
      );
      if (payTokens.length < price) {
        return { error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens to buy this listing', status: 400 };
      }

      const issuedAt = new Date();

      // 1. Burn buyer payment tokens, mint equivalent for seller
      const sellerHash = createHash('sha256').update(listing.seller_email).digest('hex');
      for (const t of payTokens) {
        const newId = randomUUID();
        const sig = signTokenPayload(
          { id: newId, owner_email_hash: sellerHash, value: 1, issued_at: issuedAt.toISOString() },
          app.config.signingPrivateKeyHex,
        );
        await c.query(`UPDATE tokens SET state = 'INVALIDATED', invalidated_at = now() WHERE id = $1`, [t.id]);
        await c.query(
          `INSERT INTO tokens (id, owner_email, value, state, issued_at, parent_token_id, server_sig)
           VALUES ($1, $2, 1, 'VALID', $3, $4, $5)`,
          [newId, listing.seller_email, issuedAt, t.id, sig],
        );
      }

      // 2. Burn seller's listed token, mint fresh one for buyer
      const buyerHash = createHash('sha256').update(buyer_email).digest('hex');
      const soldTokenId = randomUUID();
      const soldSig = signTokenPayload(
        { id: soldTokenId, owner_email_hash: buyerHash, value: 1, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      await c.query(`UPDATE tokens SET state = 'INVALIDATED', invalidated_at = now() WHERE id = $1`, [listing.token_id]);
      await c.query(
        `INSERT INTO tokens (id, owner_email, value, state, issued_at, parent_token_id, server_sig)
         VALUES ($1, $2, 1, 'VALID', $3, $4, $5)`,
        [soldTokenId, buyer_email, issuedAt, listing.token_id, soldSig],
      );

      // 3. Record both transfer legs in the transfers ledger
      await c.query(
        `INSERT INTO transfers (id, sender_email, recipient_email, amount, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), buyer_email, listing.seller_email, price, `pay:${idempotency_key}`],
      );
      await c.query(
        `INSERT INTO transfers (id, sender_email, recipient_email, amount, idempotency_key)
         VALUES ($1, $2, $3, 1, $4)`,
        [randomUUID(), listing.seller_email, buyer_email, `token:${idempotency_key}`],
      );

      // 4. Mark listing sold
      await c.query(
        `UPDATE listings
         SET status = 'sold', buyer_email = $1, closed_at = now()
         WHERE id = $2`,
        [buyer_email, listing_id],
      );

      return { ok: true as const, sold_token_id: soldTokenId };
    });

    if ('error' in result) return reply.code(result.status).send({ error: result.error, message: result.message });
    return reply.send(result);
  });

  // POST /market/cancel — authenticated: cancel own active listing
  app.post('/market/cancel', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = CancelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const { listing_id } = parsed.data;
    const seller_email = s.email;

    await withTx(app.pool, async (c) => {
      await c.query(
        `UPDATE listings
         SET status = 'cancelled', closed_at = now()
         WHERE id = $1 AND seller_email = $2 AND status = 'active'`,
        [listing_id, seller_email],
      );
    });

    return reply.send({ ok: true });
  });
}
