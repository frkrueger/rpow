import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

const NOT_IMPL = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

describe('trivia route skeleton', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  // Remaining 501 stubs after slice 2. The match-flow endpoints land in slice 3;
  // everything else (sessions/lobby/chat/stats/me/match-reads) is now real.
  const endpoints: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'POST', url: '/api/trivia/matches/start' },
    { method: 'GET',  url: '/api/trivia/matches/active?session_id=00000000-0000-0000-0000-000000000000' },
    { method: 'POST', url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000/answer' },
    { method: 'GET',  url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000' },
  ];

  for (const { method, url } of endpoints) {
    it(`${method} ${url} returns 501 with NOT_IMPLEMENTED`, async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const res = await ctx.app.inject({
        method,
        url,
        headers: { 'content-type': 'application/json' },
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual(NOT_IMPL);
    });
  }
});
