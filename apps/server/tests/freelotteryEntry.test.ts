import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import * as xVerify from '../src/gladiator/xVerify.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string, opts?: { xHandle?: string }) {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  if (opts?.xHandle) {
    await ctx.pool.query(
      `UPDATE users SET x_handle = $1, x_handle_verified_at = now(), x_avatar_url = $2 WHERE email = $3`,
      [opts.xHandle, `https://unavatar.io/twitter/${opts.xHandle}`, email],
    );
  }
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function start(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/freelottery/entry/start',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {},
  });
}

async function verify(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, tweet_url: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/freelottery/entry/verify',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { tweet_url },
  });
}

const TODAY = new Date().toISOString().slice(0, 10);

/** The day_utc the handler will use given drawHourUtc=19. */
function activeDayUtc(): string {
  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10);
  const todayDraw = new Date(`${todayYmd}T19:00:00Z`);
  if (now < todayDraw) return todayYmd;
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

describe('POST /api/freelottery/entry/start', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 unauthenticated', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/freelottery/entry/start',
      headers: { 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when feature is disabled (no start date)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('FEATURE_DISABLED');
  });

  it('409 BIND_REQUIRED when user has no x_handle', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('BIND_REQUIRED');
  });

  it('200 returns code, tweet_intent_url, expires_at, day_utc and upserts the code row', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.tweet_intent_url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
    expect(body.day_utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\.000Z$/);
    // Row exists in DB.
    const { rows } = await ctx.pool.query(
      `SELECT code FROM freelottery_codes WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [body.day_utc],
    );
    expect(rows[0]?.code).toBe(body.code);
  });

  it('409 ALREADY_ENTERED when user already has an entry for today', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    // Pre-seed an entry for the active day (may be tomorrow if past 19:00 UTC draw).
    const dayUtc = activeDayUtc();
    await ctx.pool.query(
      `INSERT INTO freelottery_entries
         (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
       VALUES ('a@b.com', $1, 'alice', 'https://twitter.com/alice/status/1', 1, 0)`,
      [dayUtc],
    );
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ALREADY_ENTERED');
  });

  it('overwrites a previous /start code when called twice the same day', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const first = await start(ctx, cookie);
    const second = await start(ctx, cookie);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // DB row reflects the second code (upsert behavior).
    const { rows } = await ctx.pool.query<{ code: string }>(
      `SELECT code FROM freelottery_codes WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [second.json().day_utc],
    );
    expect(rows[0].code).toBe(second.json().code);
  });
});
