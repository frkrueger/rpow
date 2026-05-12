import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { generateCode, tweetIntentUrl, ticketCountForBalance } from '../../freelottery/codes.js';
import { getDayUtc, hasEnded } from '../../freelottery/schedule.js';
import { verifyTweet } from '../../gladiator/xVerify.js';
import { withTx } from '../../db.js';

function scheduleFor(app: FastifyInstance) {
  return {
    startUtcDate: app.config.freelotteryStartUtcDate,
    totalDays: app.config.freelotteryTotalDays,
    drawHourUtc: app.config.freelotteryDrawHourUtc,
  };
}

function drawMomentFor(dayUtc: string, hourUtc: number): Date {
  return new Date(`${dayUtc}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

const VerifyBody = z.object({ tweet_url: z.string().min(1) });

export async function entryRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/start
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/start', {
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

    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    const now = new Date();
    if (hasEnded(now, sched)) {
      return reply.code(404).send({ error: 'CAMPAIGN_ENDED', message: 'campaign has ended' });
    }
    const dayUtc = getDayUtc(now, sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_NOT_STARTED', message: 'campaign has not started yet' });
    }

    // User must have a bound X handle to enter.
    const userRes = await app.pool.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [s.email],
    );
    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'user not found' });
    }
    if (!userRes.rows[0].x_handle) {
      return reply.code(409).send({ error: 'BIND_REQUIRED', message: 'bind an X handle first' });
    }

    // Reject if already entered for today.
    const existing = await app.pool.query(
      `SELECT 1 FROM freelottery_entries WHERE account_email = $1 AND day_utc = $2`,
      [s.email, dayUtc],
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'ALREADY_ENTERED', message: 'already entered for today' });
    }

    const code = generateCode();
    const expiresAt = drawMomentFor(dayUtc, sched.drawHourUtc);

    await app.pool.query(
      `INSERT INTO freelottery_codes (account_email, day_utc, code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_email, day_utc) DO UPDATE
         SET code = EXCLUDED.code,
             expires_at = EXCLUDED.expires_at`,
      [s.email, dayUtc, code, expiresAt],
    );

    return reply.code(200).send({
      code,
      tweet_intent_url: tweetIntentUrl(code),
      expires_at: expiresAt.toISOString(),
      day_utc: dayUtc,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/verify — implemented in Task 3
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/verify', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
