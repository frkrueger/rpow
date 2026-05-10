import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';

const ChatBody = z.object({
  body: z.string().min(1).max(280),
});

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/gladiator/chat', async (req, reply) => {
    const query = (req.query as Record<string, string | undefined>);
    const before = query['before'];

    if (before !== undefined) {
      // Validate that `before` is a parseable ISO timestamp
      const ts = Date.parse(before);
      if (isNaN(ts)) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid before parameter; must be ISO timestamp' });
      }
    }

    let res;
    if (before !== undefined) {
      res = await app.pool.query<{
        id: string;
        account_email: string | null;
        x_handle: string | null;
        kind: string;
        body: string;
        created_at: Date;
      }>(
        `SELECT id, account_email, x_handle, kind, body, created_at
         FROM gladiator_chat_messages
         WHERE created_at < $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [before],
      );
    } else {
      res = await app.pool.query<{
        id: string;
        account_email: string | null;
        x_handle: string | null;
        kind: string;
        body: string;
        created_at: Date;
      }>(
        `SELECT id, account_email, x_handle, kind, body, created_at
         FROM gladiator_chat_messages
         ORDER BY created_at DESC
         LIMIT 50`,
      );
    }

    const messages = res.rows.map((row) => ({
      id: row.id,
      account_email: row.account_email ?? null,
      x_handle: row.x_handle ?? null,
      kind: row.kind as 'USER' | 'SYSTEM',
      body: row.body,
      created_at: row.created_at.toISOString(),
    }));

    return reply.code(200).send({ messages });
  });

  app.post('/api/gladiator/chat', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;

    // Check X handle verified
    const userRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [email],
    );
    const user = userRes.rows[0];
    if (!user || !user.x_handle_verified_at || !user.x_handle) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }
    const xHandle = user.x_handle;

    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const id = randomUUID();
    const insertRes = await app.pool.query<{ created_at: Date }>(
      `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
       VALUES ($1, $2, $3, 'USER', $4)
       RETURNING created_at`,
      [id, email, xHandle, parsed.data.body],
    );

    const createdAt = insertRes.rows[0].created_at;

    return reply.code(200).send({
      id,
      created_at: createdAt.toISOString(),
    });
  });
}
