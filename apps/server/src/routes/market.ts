import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readSession } from './auth.js';
import { withTx } from '../db.js';

const ListBody = z.object({
  token_id: z.string().uuid(),
  price_rpow: z.number().int().positive(),
});

const CancelBody = z.object({
  listing_id: z.string().uuid(),
});

export async function marketRoutes(app: FastifyInstance) {
  // GET /market — public: browse active listings
  app.get('/market', async (_req, reply) => {
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

  // POST /market/list — authenticated: list a token for sale
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

  // POST /market/cancel — authenticated: cancel own listing
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
