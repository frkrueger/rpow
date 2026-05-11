import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';

const FAVORITE_LIMIT = 100;

const PostBody = z.object({
  x_handle: z.string().min(1).max(64),
});

export async function favoritesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------
  // GET /api/favorites — caller's favorites (no emails in response)
  // ---------------------------------------------------------------
  app.get('/api/favorites', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const res = await app.pool.query<{
      x_handle: string | null;
      x_avatar_url: string | null;
      created_at: Date;
    }>(
      `SELECT u.x_handle, u.x_avatar_url, uf.created_at
       FROM user_favorites uf
       JOIN users u ON u.email = uf.favorite_email
       WHERE uf.account_email = $1
       ORDER BY uf.created_at DESC`,
      [s.email],
    );

    const favorites = res.rows
      .filter(r => r.x_handle !== null)
      .map(r => ({
        x_handle: r.x_handle!,
        x_avatar_url: r.x_avatar_url ?? null,
        created_at: r.created_at.toISOString(),
      }));

    return reply.code(200).send({ favorites });
  });

  // ---------------------------------------------------------------
  // POST /api/favorites { x_handle }
  // ---------------------------------------------------------------
  app.post('/api/favorites', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const handle = parsed.data.x_handle;

    const userRes = await app.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE lower(x_handle) = lower($1) AND x_handle_verified_at IS NOT NULL`,
      [handle],
    );
    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'no verified user with that handle' });
    }
    const favoriteeEmail = userRes.rows[0].email;

    if (favoriteeEmail === s.email) {
      return reply.code(400).send({ error: 'SELF_FAVORITE', message: 'you cannot favorite yourself' });
    }

    // Cap check — count and only block if this would be a NEW favorite.
    const countRes = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_favorites WHERE account_email = $1`,
      [s.email],
    );
    if (countRes.rows[0].n >= FAVORITE_LIMIT) {
      const existsRes = await app.pool.query(
        `SELECT 1 FROM user_favorites WHERE account_email = $1 AND favorite_email = $2`,
        [s.email, favoriteeEmail],
      );
      if (existsRes.rowCount === 0) {
        return reply.code(409).send({ error: 'FAVORITE_LIMIT_REACHED', message: `favorites limit is ${FAVORITE_LIMIT}` });
      }
    }

    const insertRes = await app.pool.query<{ created_at: Date }>(
      `INSERT INTO user_favorites(account_email, favorite_email)
       VALUES ($1, $2)
       ON CONFLICT (account_email, favorite_email) DO UPDATE SET created_at = user_favorites.created_at
       RETURNING created_at`,
      [s.email, favoriteeEmail],
    );

    return reply.code(200).send({ created_at: insertRes.rows[0].created_at.toISOString() });
  });

  // ---------------------------------------------------------------
  // DELETE /api/favorites/:x_handle
  // ---------------------------------------------------------------
  app.delete('/api/favorites/:x_handle', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const { x_handle: handle } = req.params as { x_handle: string };

    const userRes = await app.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE lower(x_handle) = lower($1)`,
      [handle],
    );
    if (userRes.rows.length === 0) {
      return reply.code(200).send({ ok: true });
    }
    const favoriteeEmail = userRes.rows[0].email;

    await app.pool.query(
      `DELETE FROM user_favorites WHERE account_email = $1 AND favorite_email = $2`,
      [s.email, favoriteeEmail],
    );

    return reply.code(200).send({ ok: true });
  });
}
