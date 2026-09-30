import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

const TODAY = new Date().toISOString().slice(0, 10);

/** Compute today's day_utc the same way the server's schedule will: today's
 *  calendar date if before drawHourUtc, otherwise tomorrow. */
function activeDayUtc(drawHourUtc: number): string {
  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10);
  const drawMoment = new Date(`${todayYmd}T${String(drawHourUtc).padStart(2, '0')}:00:00Z`);
  if (now.getTime() < drawMoment.getTime()) return todayYmd;
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

async function seedUserAndEntry(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  xHandle: string,
  dayUtc: string,
  tickets: 1 | 2,
  verifiedAt: string,
) {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(
    `UPDATE users SET x_handle = $1, x_avatar_url = $2 WHERE email = $3`,
    [xHandle, `https://unavatar.io/twitter/${xHandle}`, email],
  );
  await ctx.pool.query(
    `INSERT INTO freelottery_entries
       (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email, dayUtc, xHandle, 'https://twitter.com/x/status/1', tickets, 0, verifiedAt],
  );
}

describe('GET /api/freelottery/today', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('404 when feature is disabled', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('FEATURE_DISABLED');
  });

  it('returns empty entries when no one has entered today', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      day_utc: activeDayUtc(19),
      prize_base_units: '1000000000000',
      entries: [],
      total_entries: 0,
      total_tickets: 0,
    });
    expect(body.draws_at).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\.000Z$/);
  });

  it('returns today entries with handles + avatars + ticket counts, ordered by verified_at ASC', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const dayUtc = activeDayUtc(19);
    await seedUserAndEntry(ctx, 'a@b.com', 'alice', dayUtc, 1, '2026-05-12T10:00:00Z');
    await seedUserAndEntry(ctx, 'c@d.com', 'charlie', dayUtc, 2, '2026-05-12T11:00:00Z');

    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total_entries).toBe(2);
    expect(body.total_tickets).toBe(3);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      x_handle: 'alice',
      x_avatar_url: 'https://unavatar.io/twitter/alice',
      ticket_count: 1,
    });
    expect(body.entries[1]).toMatchObject({
      x_handle: 'charlie',
      x_avatar_url: 'https://unavatar.io/twitter/charlie',
      ticket_count: 2,
    });
  });

  it('excludes entries from other days', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const dayUtc = activeDayUtc(19);
    await seedUserAndEntry(ctx, 'a@b.com', 'alice', dayUtc, 1, '2026-05-12T10:00:00Z');
    // Yesterday's entry — should NOT show up.
    await seedUserAndEntry(ctx, 'old@x.com', 'oldhandle', '2026-04-01', 1, '2026-04-01T10:00:00Z');

    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.json().total_entries).toBe(1);
    expect(r.json().entries[0].x_handle).toBe('alice');
  });
});

async function seedDraw(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  opts: {
    dayUtc: string;
    status: 'ok' | 'empty';
    winnerEmail?: string;
    winnerXHandle?: string;
    totalTickets: number;
    solanaSlot?: number;
    solanaBlockhash?: string;
    tweetUrl?: string;
  },
) {
  if (opts.winnerEmail) {
    await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT DO NOTHING`, [opts.winnerEmail]);
    await ctx.pool.query(
      `UPDATE users SET x_handle = $1, x_avatar_url = $2 WHERE email = $3`,
      [opts.winnerXHandle, `https://unavatar.io/twitter/${opts.winnerXHandle}`, opts.winnerEmail],
    );
    if (opts.tweetUrl) {
      await ctx.pool.query(
        `INSERT INTO freelottery_entries
           (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry, verified_at)
         VALUES ($1, $2, $3, $4, 1, 0, now())`,
        [opts.winnerEmail, opts.dayUtc, opts.winnerXHandle, opts.tweetUrl],
      );
    }
  }
  await ctx.pool.query(
    `INSERT INTO freelottery_draws
       (day_utc, drawn_at, total_tickets, prize_base_units, status,
        winner_email, winner_x_handle, solana_slot, solana_blockhash, mint_credited_at)
     VALUES ($1, now(), $2, 1000000000000, $3, $4, $5, $6, $7, ${opts.status === 'ok' ? 'now()' : 'NULL'})`,
    [
      opts.dayUtc,
      opts.totalTickets,
      opts.status,
      opts.winnerEmail ?? null,
      opts.winnerXHandle ?? null,
      opts.solanaSlot ?? null,
      opts.solanaBlockhash ?? null,
    ],
  );
}

describe('GET /api/freelottery/winners', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('404 when feature is disabled', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('FEATURE_DISABLED');
  });

  it('returns [] when no draws have been processed', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ winners: [] });
  });

  it('returns ok draws with winner profile + slot/blockhash receipts', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, {
      dayUtc: '2026-05-10',
      status: 'ok',
      winnerEmail: 'a@b.com',
      winnerXHandle: 'alice',
      totalTickets: 3,
      solanaSlot: 123_456_789,
      solanaBlockhash: 'a'.repeat(64),
      tweetUrl: 'https://twitter.com/alice/status/1',
    });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(200);
    const winners = r.json().winners;
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      day_utc: '2026-05-10',
      status: 'ok',
      x_handle: 'alice',
      x_avatar_url: 'https://unavatar.io/twitter/alice',
      total_tickets: 3,
      prize_base_units: '1000000000000',
      solana_slot: '123456789',
      solana_blockhash: 'a'.repeat(64),
      tweet_url: 'https://twitter.com/alice/status/1',
    });
    expect(winners[0].mint_credited_at).not.toBeNull();
  });

  it('includes empty-day rows with null winner', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, {
      dayUtc: '2026-05-09',
      status: 'empty',
      totalTickets: 0,
    });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    const winners = r.json().winners;
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      day_utc: '2026-05-09',
      status: 'empty',
      x_handle: null,
      x_avatar_url: null,
      total_tickets: 0,
    });
    expect(winners[0].mint_credited_at).toBeNull();
  });

  it('returns most-recent first', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    await seedDraw(ctx, { dayUtc: '2026-05-08', status: 'empty', totalTickets: 0 });
    await seedDraw(ctx, { dayUtc: '2026-05-10', status: 'empty', totalTickets: 0 });
    await seedDraw(ctx, { dayUtc: '2026-05-09', status: 'empty', totalTickets: 0 });
    const winners = (await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' })).json().winners;
    expect(winners.map((w: any) => w.day_utc)).toEqual(['2026-05-10', '2026-05-09', '2026-05-08']);
  });
});
