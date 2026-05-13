import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('chat routes', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  describe('GET /api/chat/rooms', () => {
    it('returns 21 English + 6 Mandarin rooms grouped by category', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms' });
      expect(r.statusCode).toBe(200);
      const body = r.json() as {
        rooms: Array<{ slug: string; category: string; language: string; hostName: string }>;
      };
      // 27 total = 21 English seeded in migration 031 + 6 Mandarin in migration 032.
      expect(body.rooms).toHaveLength(27);

      // Spot-check a real room from each set so any seed-data typo is caught here.
      const rpow = body.rooms.find(r => r.slug === 'rpow');
      expect(rpow).toMatchObject({
        category: 'ORIGINALS',
        language: 'en',
        hostName: 'Hal Finney',
      });
      const rpowZh = body.rooms.find(r => r.slug === 'rpow-zh');
      expect(rpowZh).toMatchObject({
        category: 'CHINESE',
        language: 'zh',
        hostName: '哈尔',
      });

      // Ordering: rows sort by category ASC, sort_order ASC, slug ASC.
      const order = body.rooms.map(r => `${r.category}:${r.slug}`);
      // First two should be the ORIGINALS pair (general before rpow).
      expect(order.slice(0, 2)).toEqual(['ORIGINALS:general', 'ORIGINALS:rpow']);
    });

    it('omits disabled rooms', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      await ctx.pool.query(`UPDATE chat_rooms SET disabled = true WHERE slug = $1`, ['solana']);
      const r = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms' });
      expect(r.statusCode).toBe(200);
      expect(r.json().rooms.map((x: { slug: string }) => x.slug)).not.toContain('solana');
    });

    it('does NOT require credentials (public read)', async () => {
      const ctx = await makeTestApp();
      cleanup = ctx.cleanup;
      const r = await ctx.app.inject({
        method: 'GET',
        url: '/api/chat/rooms',
      });
      expect(r.statusCode).toBe(200);
    });
  });
});
