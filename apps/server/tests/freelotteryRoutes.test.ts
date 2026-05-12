import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('freelottery routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('POST /api/freelottery/entry/start returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/freelottery/entry/start' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('POST /api/freelottery/entry/verify returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/freelottery/entry/verify' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('GET /api/freelottery/today returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/today' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
  });

  it('GET /api/freelottery/winners returns 501 (stub)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({ method: 'GET', url: '/api/freelottery/winners' });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'not_implemented' });
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
  });
});
