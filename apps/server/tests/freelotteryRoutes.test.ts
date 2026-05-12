import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('freelottery routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  // /entry/start and /entry/verify are real handlers as of slice 2 — see freelotteryEntry.test.ts.
  // /today and /winners are real handlers as of slice 4 — see freelotteryTodayWinners.test.ts.

  it('GET /api/freelottery/today returns 404 FEATURE_DISABLED when no start date', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('FEATURE_DISABLED');
  });

  describe('GET /api/freelottery/status', () => {
    it('returns disabled shape when no start date configured', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/status' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        enabled: false,
        startUtcDate: null,
        totalDays: 100,
        prizeBaseUnits: '1000000000000',
        drawHourUtc: 19,
        dayIndex: null,
        currentDayUtc: null,
        nextDrawAt: null,
        ended: true,
      });
    });

    it('returns enabled shape when start date is configured and active', async () => {
      // Pick a start date guaranteed to put us inside the 100-day window:
      // today's date works since the campaign runs 100 days from there.
      const today = new Date().toISOString().slice(0, 10);
      const ctx = await makeTestApp({ freelotteryStartUtcDate: today });
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/status' });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.enabled).toBe(true);
      expect(body.startUtcDate).toBe(today);
      expect(body.totalDays).toBe(100);
      // bigint → string serialization path under test.
      expect(body.prizeBaseUnits).toBe('1000000000000');
      expect(body.drawHourUtc).toBe(19);
      expect(body.ended).toBe(false);
      // dayIndex is 1 or 2 depending on whether the test runs before or after 19:00 UTC today.
      expect([1, 2]).toContain(body.dayIndex);
      expect(body.currentDayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.nextDrawAt).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\.000Z$/);
    });
  });
});
