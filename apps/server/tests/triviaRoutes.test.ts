import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

const NOT_IMPL = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

describe('trivia route skeleton', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  const endpoints: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'GET',  url: '/api/trivia/me' },
    { method: 'POST', url: '/api/trivia/sessions' },
    { method: 'POST', url: '/api/trivia/sessions/00000000-0000-0000-0000-000000000000/close' },
    { method: 'GET',  url: '/api/trivia/lobby' },
    { method: 'POST', url: '/api/trivia/matches/start' },
    { method: 'GET',  url: '/api/trivia/matches/active?session_id=00000000-0000-0000-0000-000000000000' },
    { method: 'POST', url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000/answer' },
    { method: 'GET',  url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000' },
    { method: 'GET',  url: '/api/trivia/matches/recent' },
    { method: 'GET',  url: '/api/trivia/matches/history' },
    { method: 'GET',  url: '/api/trivia/chat' },
    { method: 'POST', url: '/api/trivia/chat' },
    { method: 'GET',  url: '/api/trivia/stats' },
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
