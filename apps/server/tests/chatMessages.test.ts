import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { _resetForTests as resetRateLimit } from '../src/chat/rateLimit.js';

describe('chat messages', () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => resetRateLimit());
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  // -------- POST /api/chat/messages ----------------------------------------

  it('POST: anonymous → 401 NOT_SIGNED_IN', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { room: 'general', body: 'hello' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('NOT_SIGNED_IN');
  });

  it('POST: signed-in but no X handle → 412 BIND_REQUIRED', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('nox@test');
    // forgeSessionCookie creates the user row but doesn't bind an X handle.
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie },
      payload: { room: 'general', body: 'hello' },
    });
    expect(r.statusCode).toBe(412);
    expect(r.json().error).toBe('BIND_REQUIRED');
  });

  it('POST: signed + verified writes to DB and fans out via SSE', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const email = 'frk@test';
    const cookie = await ctx.forgeSessionCookie(email);
    await ctx.pool.query(
      `UPDATE users SET x_handle = $1, x_avatar_url = $2 WHERE email = $3`,
      ['frk314', 'https://example.test/avatar/frk314.png', email],
    );

    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie },
      payload: { room: 'general', body: 'first post' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({
      room: 'general',
      x_handle: 'frk314',
      body: 'first post',
    });
    expect(body.id).toMatch(/^\d+$/);

    const { rows } = await ctx.pool.query(
      `SELECT body, x_handle FROM chat_room_messages WHERE id = $1`,
      [body.id],
    );
    expect(rows[0]).toEqual({ body: 'first post', x_handle: 'frk314' });
  });

  it('POST: rejects empty body and overflow body', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('frk@test');
    await ctx.pool.query(`UPDATE users SET x_handle = 'frk' WHERE email = 'frk@test'`);
    const empty = await ctx.app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie },
      payload: { room: 'general', body: '' },
    });
    expect(empty.statusCode).toBe(400);
    const overflow = await ctx.app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie },
      payload: { room: 'general', body: 'x'.repeat(2001) },
    });
    expect(overflow.statusCode).toBe(400);
  });

  it('POST: unknown room → 404 ROOM_NOT_FOUND', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('frk@test');
    await ctx.pool.query(`UPDATE users SET x_handle = 'frk' WHERE email = 'frk@test'`);
    const r = await ctx.app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie },
      payload: { room: 'nope', body: 'hi' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('ROOM_NOT_FOUND');
  });

  it('POST: banned user → 403 BANNED', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('bad@test');
    await ctx.pool.query(`UPDATE users SET x_handle = 'baddie' WHERE email = 'bad@test'`);
    await ctx.pool.query(
      `INSERT INTO chat_bans (user_email, banned_by) VALUES ('bad@test', 'admin@test')`,
    );
    const r = await ctx.app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie },
      payload: { room: 'general', body: 'hi' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('BANNED');
  });

  // -------- DELETE /api/chat/messages/:id ----------------------------------

  it('DELETE: author can self-delete; non-author gets 403', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('a@test');
    await ctx.pool.query(`UPDATE users SET x_handle = 'a_handle' WHERE email = 'a@test'`);
    const post = await ctx.app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie },
      payload: { room: 'general', body: 'delete me' },
    });
    const id = post.json().id;

    // Different signed-in user can't delete it.
    const otherCookie = await ctx.forgeSessionCookie('b@test');
    const denied = await ctx.app.inject({
      method: 'DELETE', url: `/api/chat/messages/${id}`, headers: { cookie: otherCookie },
    });
    expect(denied.statusCode).toBe(403);

    // Author can.
    const ok = await ctx.app.inject({
      method: 'DELETE', url: `/api/chat/messages/${id}`, headers: { cookie },
    });
    expect(ok.statusCode).toBe(204);

    const { rows } = await ctx.pool.query(
      `SELECT deleted_at FROM chat_room_messages WHERE id = $1`,
      [id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  // -------- GET /api/chat/rooms/:slug/messages -----------------------------

  it('GET scrollback: returns messages in oldest-first order; excludes deleted', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await ctx.forgeSessionCookie('frk@test');
    await ctx.pool.query(`UPDATE users SET x_handle = 'frk' WHERE email = 'frk@test'`);
    for (const text of ['one', 'two', 'three']) {
      await ctx.app.inject({
        method: 'POST', url: '/api/chat/messages', headers: { cookie },
        payload: { room: 'general', body: text },
      });
      resetRateLimit();
    }

    const r = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms/general/messages?limit=10' });
    expect(r.statusCode).toBe(200);
    const msgs = r.json().messages as Array<{ body: string }>;
    expect(msgs.map(m => m.body)).toEqual(['one', 'two', 'three']);

    // Soft-delete the middle one.
    const middleId = (await ctx.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM chat_room_messages WHERE body = 'two'`,
    )).rows[0]?.id;
    await ctx.app.inject({
      method: 'DELETE', url: `/api/chat/messages/${middleId}`, headers: { cookie },
    });
    const after = await ctx.app.inject({ method: 'GET', url: '/api/chat/rooms/general/messages?limit=10' });
    expect(after.json().messages.map((m: { body: string }) => m.body)).toEqual(['one', 'three']);
  });
});
