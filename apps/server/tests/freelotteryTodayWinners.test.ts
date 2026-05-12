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
