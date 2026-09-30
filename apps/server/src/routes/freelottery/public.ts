import type { FastifyInstance } from 'fastify';
import { getDayUtc, hasEnded } from '../../freelottery/schedule.js';

const TODAY_CACHE_MS = 5_000;
const WINNERS_CACHE_MS = 60_000;

interface TodayEntry {
  x_handle: string;
  x_avatar_url: string | null;
  ticket_count: 1 | 2;
  verified_at: string;
}

interface TodayBody {
  day_utc: string;
  draws_at: string;
  prize_base_units: string;
  entries: TodayEntry[];
  total_entries: number;
  total_tickets: number;
}

interface WinnerRow {
  day_utc: string;
  status: 'ok' | 'empty';
  x_handle: string | null;
  x_avatar_url: string | null;
  prize_base_units: string;
  total_tickets: number;
  solana_slot: string | null;
  solana_blockhash: string | null;
  mint_credited_at: string | null;
  tweet_url: string | null;
}

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

export async function publicRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // GET /api/freelottery/today — fully public, no auth
  // ---------------------------------------------------------------------
  let todayCache: { ts: number; body: TodayBody } | null = null;

  app.get('/api/freelottery/today', async (_req, reply) => {
    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    if (hasEnded(new Date(), sched)) {
      return reply.code(404).send({ error: 'CAMPAIGN_ENDED', message: 'campaign has ended' });
    }
    const dayUtc = getDayUtc(new Date(), sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_NOT_STARTED', message: 'campaign has not started yet' });
    }

    if (todayCache && Date.now() - todayCache.ts < TODAY_CACHE_MS && todayCache.body.day_utc === dayUtc) {
      return todayCache.body;
    }

    const { rows } = await app.pool.query<{
      x_handle: string;
      x_avatar_url: string | null;
      ticket_count: number;
      verified_at: Date;
    }>(
      `SELECT e.x_handle, u.x_avatar_url, e.ticket_count, e.verified_at
       FROM freelottery_entries e
       JOIN users u ON u.email = e.account_email
       WHERE e.day_utc = $1
       ORDER BY e.verified_at ASC, e.account_email ASC`,
      [dayUtc],
    );

    const entries: TodayEntry[] = rows.map(r => ({
      x_handle: r.x_handle,
      x_avatar_url: r.x_avatar_url,
      ticket_count: r.ticket_count as 1 | 2,
      verified_at: r.verified_at.toISOString(),
    }));
    const totalTickets = entries.reduce((sum, e) => sum + e.ticket_count, 0);

    const body: TodayBody = {
      day_utc: dayUtc,
      draws_at: drawMomentFor(dayUtc, sched.drawHourUtc).toISOString(),
      prize_base_units: app.config.freelotteryPrizeBaseUnits.toString(),
      entries,
      total_entries: entries.length,
      total_tickets: totalTickets,
    };
    todayCache = { ts: Date.now(), body };
    return body;
  });

  // ---------------------------------------------------------------------
  // GET /api/freelottery/winners — fully public, no auth
  // ---------------------------------------------------------------------
  let winnersCache: { ts: number; body: { winners: WinnerRow[] } } | null = null;

  app.get('/api/freelottery/winners', async (_req, reply) => {
    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    if (winnersCache && Date.now() - winnersCache.ts < WINNERS_CACHE_MS) {
      return winnersCache.body;
    }

    const { rows } = await app.pool.query<{
      day_utc: string;
      status: 'ok' | 'empty' | 'pending_blockhash';
      winner_x_handle: string | null;
      x_avatar_url: string | null;
      prize_base_units: string;
      total_tickets: number;
      solana_slot: string | null;
      solana_blockhash: string | null;
      mint_credited_at: Date | null;
      tweet_url: string | null;
    }>(
      `SELECT
         d.day_utc::text AS day_utc,
         d.status,
         d.winner_x_handle,
         u.x_avatar_url,
         d.prize_base_units::text AS prize_base_units,
         d.total_tickets,
         d.solana_slot::text AS solana_slot,
         d.solana_blockhash,
         d.mint_credited_at,
         e.tweet_url
       FROM freelottery_draws d
       LEFT JOIN users u ON u.email = d.winner_email
       LEFT JOIN freelottery_entries e
         ON e.account_email = d.winner_email AND e.day_utc = d.day_utc
       WHERE d.status IN ('ok', 'empty')
       ORDER BY d.day_utc DESC`,
    );

    const winners: WinnerRow[] = rows.map(r => ({
      day_utc: r.day_utc,
      status: r.status as 'ok' | 'empty',
      x_handle: r.winner_x_handle,
      x_avatar_url: r.x_avatar_url,
      prize_base_units: r.prize_base_units,
      total_tickets: r.total_tickets,
      solana_slot: r.solana_slot,
      solana_blockhash: r.solana_blockhash,
      mint_credited_at: r.mint_credited_at ? r.mint_credited_at.toISOString() : null,
      tweet_url: r.tweet_url,
    }));
    const body = { winners };
    winnersCache = { ts: Date.now(), body };
    return body;
  });
}
