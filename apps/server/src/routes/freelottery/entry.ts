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
  // POST /api/freelottery/entry/verify
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/verify', {
    config: {
      rateLimit: {
        max: 20,
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

    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    const dayUtc = getDayUtc(new Date(), sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_NOT_STARTED', message: 'campaign has not started yet' });
    }

    // Idempotency: if an entry already exists for today, short-circuit.
    // Same tweet_url → return the existing ticket_count (handles lost-response retry).
    // Different tweet_url → 409 ALREADY_ENTERED.
    const existingEntry = await app.pool.query<{
      ticket_count: number;
      balance_base_units_at_entry: string;
      tweet_url: string;
    }>(
      `SELECT ticket_count, balance_base_units_at_entry, tweet_url
       FROM freelottery_entries
       WHERE account_email = $1 AND day_utc = $2`,
      [s.email, dayUtc],
    );
    if (existingEntry.rows.length > 0) {
      const row = existingEntry.rows[0];
      if (row.tweet_url === parsed.data.tweet_url) {
        return reply.code(200).send({
          ok: true,
          ticket_count: row.ticket_count,
          day_utc: dayUtc,
          balance_base_units_at_entry: row.balance_base_units_at_entry,
        });
      }
      return reply.code(409).send({ error: 'ALREADY_ENTERED', message: 'already entered for today' });
    }

    // Read the pending code for today.
    const codeRes = await app.pool.query<{ code: string; expires_at: Date }>(
      `SELECT code, expires_at FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
      [s.email, dayUtc],
    );
    if (codeRes.rows.length === 0) {
      return reply.code(400).send({ error: 'CODE_NOT_FOUND', message: 'no pending code; call /start first' });
    }
    const { code, expires_at } = codeRes.rows[0];
    if (new Date() > expires_at) {
      await app.pool.query(
        `DELETE FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
        [s.email, dayUtc],
      );
      return reply.code(400).send({ error: 'CODE_EXPIRED', message: 'code expired; call /start again' });
    }

    // Read bound x_handle. (If null, /start would have already returned 409
    // BIND_REQUIRED — but defensive re-check here in case the user unbound.)
    const userRes = await app.pool.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [s.email],
    );
    const xHandle = userRes.rows[0]?.x_handle ?? null;
    if (!xHandle) {
      return reply.code(409).send({ error: 'BIND_REQUIRED', message: 'bind an X handle first' });
    }

    // oEmbed-verify the tweet.
    const oembed = await verifyTweet(parsed.data.tweet_url);
    if (!oembed) {
      return reply.code(503).send({
        error: 'TWEET_UNRESOLVABLE',
        message: 'could not verify tweet (Twitter may be unavailable) — try again, or check the URL',
      });
    }
    if (oembed.authorHandle.toLowerCase() !== xHandle.toLowerCase()) {
      return reply.code(403).send({ error: 'HANDLE_MISMATCH', message: 'tweet author does not match bound handle' });
    }
    if (!oembed.text.includes(code)) {
      return reply.code(400).send({ error: 'CODE_MISMATCH', message: 'code not found in tweet text' });
    }

    // Read the user's current balance to decide ticket tier.
    const balRes = await app.pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(value) FILTER (WHERE state = 'VALID'), 0)::text AS balance
       FROM tokens WHERE owner_email = $1`,
      [s.email],
    );
    const balance = BigInt(balRes.rows[0]?.balance ?? '0');
    const ticketCount = ticketCountForBalance(balance);

    // Transaction: insert the entry, delete the code. Idempotent against
    // race: re-check no existing entry inside the tx.
    type VerifyResult =
      | { ok: true; ticket_count: 1 | 2; day_utc: string; balance_base_units_at_entry: string }
      | { error: string; message: string; status: number };

    let result: VerifyResult;
    try {
      result = await withTx<VerifyResult>(app.pool, async (c) => {
        const existing = await c.query(
          `SELECT 1 FROM freelottery_entries WHERE account_email = $1 AND day_utc = $2`,
          [s.email, dayUtc],
        );
        if (existing.rows.length > 0) {
          return { error: 'ALREADY_ENTERED', message: 'already entered for today', status: 409 };
        }
        await c.query(
          `INSERT INTO freelottery_entries
             (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.email, dayUtc, xHandle, parsed.data.tweet_url, ticketCount, balance.toString()],
        );
        await c.query(
          `DELETE FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
          [s.email, dayUtc],
        );
        return {
          ok: true,
          ticket_count: ticketCount,
          day_utc: dayUtc,
          balance_base_units_at_entry: balance.toString(),
        };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'ALREADY_ENTERED', message: 'already entered for today' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send(result);
  });
}
