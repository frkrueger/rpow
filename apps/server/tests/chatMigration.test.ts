import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 031_chat.sql', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('seeds 21 rooms across 6 categories with AI host metadata', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const { rows: countRows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM chat_rooms WHERE disabled = false'
    );
    // 21 English (031) + 6 Mandarin (032) + 6 more Mandarin (033) = 33 total.
    expect(countRows[0]?.n).toBe('33');

    const { rows: byCat } = await ctx.pool.query<{ category: string; n: string }>(
      `SELECT category, count(*)::text AS n FROM chat_rooms
       GROUP BY category ORDER BY category ASC`
    );
    expect(byCat).toEqual([
      { category: 'CHINESE',     n: '12' },
      { category: 'CRYPTO',      n: '4' },
      { category: 'CULTURE',     n: '5' },
      { category: 'GENERATIONS', n: '4' },
      { category: 'LOUNGE',      n: '2' },
      { category: 'ORIGINALS',   n: '2' },
      { category: 'TECH',        n: '4' },
    ]);

    const { rows: langs } = await ctx.pool.query<{ language: string; n: string }>(
      `SELECT language, count(*)::text AS n FROM chat_rooms GROUP BY language ORDER BY language ASC`
    );
    expect(langs).toEqual([
      { language: 'en', n: '21' },
      { language: 'zh', n: '12' },
    ]);

    const { rows: hal } = await ctx.pool.query<{ host_name: string; host_persona: string }>(
      `SELECT host_name, host_persona FROM chat_rooms WHERE slug = 'rpow'`
    );
    expect(hal[0]?.host_name).toBe('Hal Finney');
    expect(hal[0]?.host_persona).toMatch(/Hal Finney/);
  });

  it('creates all 8 chat_* tables', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'chat_%'
       ORDER BY table_name ASC`
    );
    expect(rows.map(r => r.table_name)).toEqual([
      'chat_bans',
      'chat_dm_messages',
      'chat_dm_threads',
      'chat_room_messages',
      'chat_room_mutes',
      'chat_rooms',
      'chat_tips',
      'chat_user_blocks',
    ]);
  });

  it('enforces UNIQUE(user_a_email, user_b_email) on chat_dm_threads', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@example.com'), ('b@example.com')`);
    await ctx.pool.query(
      `INSERT INTO chat_dm_threads (user_a_email, user_b_email) VALUES ('a@example.com', 'b@example.com')`
    );
    await expect(
      ctx.pool.query(
        `INSERT INTO chat_dm_threads (user_a_email, user_b_email) VALUES ('a@example.com', 'b@example.com')`
      )
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
