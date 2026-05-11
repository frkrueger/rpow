import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}

async function insertChatMessage(
  pool: any,
  kind: 'USER' | 'SYSTEM',
  body: string,
  email?: string,
  xHandle?: string,
): Promise<string> {
  const id = randomUUID();
  if (kind === 'USER') {
    await pool.query(
      `INSERT INTO trivia_chat_messages (id, account_email, x_handle, kind, body)
       VALUES ($1, $2, $3, 'USER', $4)`,
      [id, email!, xHandle ?? null, body],
    );
  } else {
    await pool.query(
      `INSERT INTO trivia_chat_messages (id, account_email, x_handle, kind, body)
       VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
      [id, body],
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// GET /api/trivia/chat
// ---------------------------------------------------------------------------

describe('GET /api/trivia/chat', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('200 empty when no messages', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/chat' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toEqual([]);
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/chat' });
    expect(res.statusCode).toBe(200);
  });

  it('returns messages newest first', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    await insertChatMessage(ctx.pool, 'USER', 'hello', 'alice@b.com', 'alice');
    await insertChatMessage(ctx.pool, 'USER', 'world', 'alice@b.com', 'alice');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/chat' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    // Newest first
    expect(body.messages[0].body).toBe('world');
    expect(body.messages[1].body).toBe('hello');
  });

  it('returns up to 100 USER messages', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    for (let i = 0; i < 105; i++) {
      await insertChatMessage(ctx.pool, 'USER', `msg ${i}`, 'alice@b.com', 'alice');
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/chat' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(100);
  });

  it('excludes SYSTEM rows', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    await insertChatMessage(ctx.pool, 'SYSTEM', 'system announcement');
    await insertChatMessage(ctx.pool, 'USER', 'user message', 'alice@b.com', 'alice');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/chat' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].kind).toBe('USER');
    expect(body.messages[0].body).toBe('user message');
  });

  it('before param paginates correctly', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    // Insert a message and get its created_at
    const id1 = await insertChatMessage(ctx.pool, 'USER', 'older message', 'alice@b.com', 'alice');
    const olderRes = await ctx.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM trivia_chat_messages WHERE id = $1`, [id1],
    );
    const olderTs = olderRes.rows[0].created_at;

    // Insert a newer message with a timestamp 1 second after the older one
    const newerTs = new Date(olderTs.getTime() + 1000);
    await ctx.pool.query(
      `INSERT INTO trivia_chat_messages (id, account_email, x_handle, kind, body, created_at)
       VALUES ($1, $2, $3, 'USER', 'newer message', $4::timestamptz)`,
      [randomUUID(), 'alice@b.com', 'alice', newerTs.toISOString()],
    );

    // Use before = 500ms after the older to get only older
    const cutoffTs = new Date(olderTs.getTime() + 500).toISOString();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/chat?before=${encodeURIComponent(cutoffTs)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should have 1 message (only the older one is before cutoffTs)
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    for (const msg of body.messages) {
      expect(new Date(msg.created_at).getTime()).toBeLessThan(new Date(cutoffTs).getTime());
    }
  });

  it('400 BAD_REQUEST for non-ISO before param', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/trivia/chat?before=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// POST /api/trivia/chat
// ---------------------------------------------------------------------------

describe('POST /api/trivia/chat', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { 'content-type': 'application/json' },
      payload: { body: 'hello' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('403 X_HANDLE_REQUIRED for unverified user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@b.com');
    // Not verified

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { body: 'hello' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 BAD_REQUEST for missing body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 BAD_REQUEST for body length 0 (empty string)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { body: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 BAD_REQUEST for body length > 280', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { body: 'x'.repeat(281) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('200 happy path: row inserted with kind=USER, account_email and x_handle snapshot', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trivia/chat',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { body: 'Hello trivia!' },
    });
    expect(res.statusCode).toBe(200);
    const responseBody = res.json();
    expect(responseBody.id).toBeTruthy();
    expect(responseBody.created_at).toBeTruthy();

    // Verify DB row
    const { rows } = await ctx.pool.query<{
      id: string;
      account_email: string;
      x_handle: string;
      kind: string;
      body: string;
    }>(
      `SELECT id, account_email, x_handle, kind, body
       FROM trivia_chat_messages WHERE id = $1`,
      [responseBody.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account_email).toBe('alice@b.com');
    expect(rows[0].x_handle).toBe('alice');
    expect(rows[0].kind).toBe('USER');
    expect(rows[0].body).toBe('Hello trivia!');
  });
});
