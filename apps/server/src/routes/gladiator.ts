import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { normalizeHandle, verifyTweet } from '../gladiator/xVerify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a zero-padded 6-digit numeric code, e.g. "034281". */
function generateCode(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

/** Build the canonical verification tweet text. */
function verificationTweetText(code: string): string {
  return `I am entering the gladiator arena on X. My code is ${code}. Go to gladiator.rpow2.com to go head to head with me in 100% fair gladiator games. May the best man win.`;
}

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const StartBody = z.object({
  handle: z.string().min(1),
});

const VerifyBody = z.object({
  tweet_url: z.string().min(1),
});

const AdminVerifyBody = z.object({
  email: z.string().email(),
  handle: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function gladiatorRoutes(app: FastifyInstance) {
  // --------------------------------------------------------------------------
  // POST /api/gladiator/x-handle/start
  // --------------------------------------------------------------------------
  app.post('/api/gladiator/x-handle/start', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes',
        // TODO: key by session email for better per-user limiting; for now use
        // x-forwarded-for (or req.ip fallback) as the proxy for identity
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const handle = normalizeHandle(parsed.data.handle);
    if (!handle) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid X handle' });
    }

    // Check if another user already owns this handle (case-insensitive)
    const existing = await app.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE LOWER(x_handle) = $1 AND email != $2`,
      [handle, s.email],
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'HANDLE_TAKEN', message: 'handle already claimed by another user' });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Upsert pending verification row
    await app.pool.query(
      `INSERT INTO x_verification_codes (account_email, pending_handle, code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_email) DO UPDATE
         SET pending_handle = EXCLUDED.pending_handle,
             code = EXCLUDED.code,
             expires_at = EXCLUDED.expires_at,
             created_at = now()`,
      [s.email, handle, code, expiresAt],
    );

    const tweetText = verificationTweetText(code);
    const tweetIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

    return reply.code(200).send({
      code,
      tweet_intent_url: tweetIntentUrl,
      expires_at: expiresAt.toISOString(),
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/gladiator/x-handle/verify
  // --------------------------------------------------------------------------
  app.post('/api/gladiator/x-handle/verify', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '10 minutes',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const { tweet_url } = parsed.data;

    // Look up pending verification code
    const codeRow = await app.pool.query<{
      pending_handle: string;
      code: string;
      expires_at: Date;
    }>(
      `SELECT pending_handle, code, expires_at FROM x_verification_codes WHERE account_email = $1`,
      [s.email],
    );

    if (codeRow.rows.length === 0) {
      return reply.code(400).send({ error: 'CODE_NOT_FOUND', message: 'no pending verification code; call /start first' });
    }

    const { pending_handle, code, expires_at } = codeRow.rows[0];

    if (new Date() > expires_at) {
      // Delete the expired row
      await app.pool.query(`DELETE FROM x_verification_codes WHERE account_email = $1`, [s.email]);
      return reply.code(400).send({ error: 'CODE_EXPIRED', message: 'verification code has expired; call /start again' });
    }

    // Call oEmbed to verify the tweet
    const oembed = await verifyTweet(tweet_url);
    if (!oembed) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'could not verify tweet' });
    }

    // Check that the tweet author is the expected handle
    if (oembed.authorHandle !== pending_handle.toLowerCase()) {
      return reply.code(400).send({ error: 'HANDLE_MISMATCH', message: 'tweet author does not match pending handle' });
    }

    // Check that the tweet body contains the code
    if (!oembed.text.includes(code)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'code not found in tweet' });
    }

    // In a transaction: re-check uniqueness, update user, delete pending code
    type VerifyResult =
      | { ok: true; x_handle: string; x_handle_verified_at: string; x_avatar_url: string }
      | { error: string; message: string; status: number };

    let result: VerifyResult;
    try {
      result = await withTx<VerifyResult>(app.pool, async (c) => {
        // Re-check uniqueness (race condition guard)
        const conflict = await c.query<{ email: string }>(
          `SELECT email FROM users WHERE LOWER(x_handle) = $1 AND email != $2`,
          [pending_handle.toLowerCase(), s.email],
        );
        if (conflict.rows.length > 0) {
          return { error: 'HANDLE_TAKEN', message: 'handle was just claimed by another user', status: 409 };
        }

        const avatarUrl = `https://unavatar.io/twitter/${pending_handle}`;
        const now = new Date();

        // Update the user row
        const updateRes = await c.query<{ x_handle: string; x_handle_verified_at: Date; x_avatar_url: string }>(
          `UPDATE users
           SET x_handle = $1, x_handle_verified_at = $2, x_avatar_url = $3
           WHERE email = $4
           RETURNING x_handle, x_handle_verified_at, x_avatar_url`,
          [pending_handle, now, avatarUrl, s.email],
        );

        if (updateRes.rows.length === 0) {
          return { error: 'USER_NOT_FOUND', message: 'user not found', status: 404 };
        }

        // Delete the pending code
        await c.query(`DELETE FROM x_verification_codes WHERE account_email = $1`, [s.email]);

        const row = updateRes.rows[0];
        return {
          ok: true,
          x_handle: row.x_handle,
          x_handle_verified_at: row.x_handle_verified_at.toISOString(),
          x_avatar_url: row.x_avatar_url,
        };
      });
    } catch (e: any) {
      // Unique constraint violation (DB-level uniqueness guard)
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'HANDLE_TAKEN', message: 'handle already claimed' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      x_handle: result.x_handle,
      x_handle_verified_at: result.x_handle_verified_at,
      x_avatar_url: result.x_avatar_url,
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/gladiator/me
  // --------------------------------------------------------------------------
  app.get('/api/gladiator/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    // Read user profile
    const userRes = await app.pool.query<{
      email: string;
      x_handle: string | null;
      x_handle_verified_at: Date | null;
      x_avatar_url: string | null;
    }>(
      `SELECT email, x_handle, x_handle_verified_at, x_avatar_url FROM users WHERE email = $1`,
      [s.email],
    );

    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'user not found' });
    }

    const user = userRes.rows[0];

    // Read open gladiator session if any
    const sessionRes = await app.pool.query(
      `SELECT * FROM gladiator_sessions WHERE account_email = $1 AND status = 'OPEN'`,
      [s.email],
    );
    const openSession = sessionRes.rows.length > 0 ? sessionRes.rows[0] : null;

    // Compute career W/L from gladiator_flips aggregates
    const careerRes = await app.pool.query<{ wins: string; losses: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE winner_email = $1)::text AS wins,
         COUNT(*) FILTER (WHERE (offerer_email = $1 OR challenger_email = $1) AND winner_email != $1)::text AS losses
       FROM gladiator_flips
       WHERE offerer_email = $1 OR challenger_email = $1`,
      [s.email],
    );

    const career = {
      wins: parseInt(careerRes.rows[0]?.wins ?? '0', 10),
      losses: parseInt(careerRes.rows[0]?.losses ?? '0', 10),
    };

    return reply.code(200).send({
      email: user.email,
      x_handle: user.x_handle ?? null,
      x_handle_verified_at: user.x_handle_verified_at ? user.x_handle_verified_at.toISOString() : null,
      x_avatar_url: user.x_avatar_url ?? null,
      open_session: openSession,
      career,
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/gladiator/admin/verify-handle
  // --------------------------------------------------------------------------
  app.post('/api/gladiator/admin/verify-handle', async (req, reply) => {
    // Check bearer token
    const adminToken = app.config.gladiatorAdminToken;
    if (!adminToken) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'admin route not configured' });
    }

    const authHeader = req.headers.authorization ?? '';
    const expectedBearer = `Bearer ${adminToken}`;
    if (authHeader !== expectedBearer) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'invalid or missing authorization token' });
    }

    const parsed = AdminVerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const handle = normalizeHandle(parsed.data.handle);
    if (!handle) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid X handle' });
    }

    const { email } = parsed.data;

    type AdminResult =
      | { ok: true }
      | { error: string; message: string; status: number };

    let result: AdminResult;
    try {
      result = await withTx<AdminResult>(app.pool, async (c) => {
        // Check uniqueness
        const conflict = await c.query<{ email: string }>(
          `SELECT email FROM users WHERE LOWER(x_handle) = $1 AND email != $2`,
          [handle, email],
        );
        if (conflict.rows.length > 0) {
          return { error: 'HANDLE_TAKEN', message: 'handle already claimed by another user', status: 409 };
        }

        const avatarUrl = `https://unavatar.io/twitter/${handle}`;

        // Update user
        const updateRes = await c.query(
          `UPDATE users
           SET x_handle = $1, x_handle_verified_at = now(), x_avatar_url = $2
           WHERE email = $3`,
          [handle, avatarUrl, email],
        );

        if ((updateRes.rowCount ?? 0) === 0) {
          return { error: 'USER_NOT_FOUND', message: 'user not found', status: 404 };
        }

        // Delete any pending code
        await c.query(`DELETE FROM x_verification_codes WHERE account_email = $1`, [email]);

        return { ok: true };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'HANDLE_TAKEN', message: 'handle already claimed' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({ ok: true });
  });

  // --------------------------------------------------------------------------
  // Remaining stubs (Slices 3–9)
  // --------------------------------------------------------------------------

  const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

  app.post('/api/gladiator/sessions', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/sessions/:id/close', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/lobby', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/flip', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
