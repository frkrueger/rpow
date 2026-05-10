import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import * as xVerify from '../src/gladiator/xVerify.js';

// ---------------------------------------------------------------------------
// Login helper: insert user into DB, return a signed session cookie string
// so it can be passed via { headers: { cookie: ... } }
// ---------------------------------------------------------------------------
async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function startHandle(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, handle: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/gladiator/x-handle/start',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { handle },
  });
}

async function verifyHandle(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, tweet_url: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/gladiator/x-handle/verify',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { tweet_url },
  });
}

// ---------------------------------------------------------------------------
// POST /api/gladiator/x-handle/start
// ---------------------------------------------------------------------------
describe('POST /api/gladiator/x-handle/start', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/x-handle/start',
      headers: { 'content-type': 'application/json' },
      payload: { handle: 'testuser' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('400 on invalid handle (too long)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await startHandle(ctx, cookie, 'a'.repeat(16));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 on invalid handle (non-ASCII)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await startHandle(ctx, cookie, 'héllo');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('200 returns code + tweet_intent_url containing the code; row inserted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await startHandle(ctx, cookie, '@TestUser');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.tweet_intent_url).toContain(body.code);
    expect(body.tweet_intent_url).toContain('twitter.com/intent/tweet');
    expect(body.expires_at).toBeDefined();

    // Check DB row
    const { rows } = await ctx.pool.query(
      `SELECT pending_handle, code FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pending_handle).toBe('testuser');
    expect(rows[0].code).toBe(body.code);
  });

  it('is idempotent — calling twice updates the existing code row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    await startHandle(ctx, cookie, '@TestUser');
    const res2 = await startHandle(ctx, cookie, '@TestUser');
    expect(res2.statusCode).toBe(200);

    // Only one row should exist
    const { rows } = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);
  });

  it('409 when another verified user owns the handle (case-insensitive: Alice vs alice)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    // Insert alice as a user with a verified handle
    await ctx.pool.query(
      `INSERT INTO users (email, x_handle) VALUES ('alice@example.com', 'alice') ON CONFLICT (email) DO UPDATE SET x_handle = 'alice'`,
    );

    const cookie = await login(ctx, 'bob@example.com');
    // Bob tries to claim 'Alice' (different case)
    const res = await startHandle(ctx, cookie, 'Alice');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('HANDLE_TAKEN');
  });
});

// ---------------------------------------------------------------------------
// POST /api/gladiator/x-handle/verify
// ---------------------------------------------------------------------------
describe('POST /api/gladiator/x-handle/verify', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  const TWEET_URL = 'https://twitter.com/testuser/status/1234567890';

  it('400 CODE_NOT_FOUND if no pending code', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CODE_NOT_FOUND');
  });

  it('400 CODE_EXPIRED after the row expires_at passes', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    // Start verification
    const startRes = await startHandle(ctx, cookie, '@testuser');
    expect(startRes.statusCode).toBe(200);

    // Backdate the expires_at so it's in the past
    await ctx.pool.query(
      `UPDATE x_verification_codes SET expires_at = now() - interval '1 minute' WHERE account_email = 'a@b.com'`,
    );

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CODE_EXPIRED');

    // Row should be deleted
    const { rows } = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(0);
  });

  it('400 HANDLE_MISMATCH when oembed handle differs', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    await startHandle(ctx, cookie, '@testuser');
    const { rows } = await ctx.pool.query(
      `SELECT code FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    const code = rows[0].code;

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'differentuser', // wrong handle
      text: `My code is ${code}. gladiator.rpow2.com`,
    });

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('HANDLE_MISMATCH');
  });

  it('400 when code not in tweet body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    await startHandle(ctx, cookie, '@testuser');

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'testuser',
      text: 'I am entering the arena. Go to gladiator.rpow2.com', // no code
    });

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
    expect(res.json().message).toContain('code not found');
  });

  it('happy path: writes x_handle, sets verified_at, deletes pending row, returns JSON', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    await startHandle(ctx, cookie, '@testuser');
    const { rows } = await ctx.pool.query(
      `SELECT code FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    const code = rows[0].code;

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'testuser',
      text: `I am entering the gladiator arena on X. My code is ${code}. Go to gladiator.rpow2.com`,
    });

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.x_handle).toBe('testuser');
    expect(body.x_handle_verified_at).toBeDefined();
    expect(body.x_avatar_url).toContain('unavatar.io/twitter/testuser');

    // Pending row deleted
    const pending = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    expect(parseInt(pending.rows[0].n, 10)).toBe(0);

    // users row updated
    const user = await ctx.pool.query(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = 'a@b.com'`,
    );
    expect(user.rows[0].x_handle).toBe('testuser');
    expect(user.rows[0].x_handle_verified_at).not.toBeNull();
  });

  it('race: 409 HANDLE_TAKEN if another user grabs the handle between start and verify', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    await startHandle(ctx, cookie, '@testuser');
    const { rows } = await ctx.pool.query(
      `SELECT code FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    const code = rows[0].code;

    // Simulate another user claiming the handle in the DB directly
    await ctx.pool.query(
      `INSERT INTO users (email, x_handle) VALUES ('competitor@example.com', 'testuser')
       ON CONFLICT (email) DO UPDATE SET x_handle = 'testuser'`,
    );

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'testuser',
      text: `My code is ${code}. Go to gladiator.rpow2.com`,
    });

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('HANDLE_TAKEN');
  });

  it('400 when verifyTweet returns null (unresolvable tweet)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await startHandle(ctx, cookie, '@testuser');

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce(null);

    const res = await verifyHandle(ctx, cookie, TWEET_URL);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('could not verify tweet');
  });
});

// ---------------------------------------------------------------------------
// GET /api/gladiator/me
// ---------------------------------------------------------------------------
describe('GET /api/gladiator/me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('returns null x_handle for an unverified user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('a@b.com');
    expect(body.x_handle).toBeNull();
    expect(body.x_handle_verified_at).toBeNull();
    expect(body.x_avatar_url).toBeNull();
    expect(body.open_session).toBeNull();
  });

  it('returns the verified handle for a verified user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');

    // Verify the handle via the full flow
    await startHandle(ctx, cookie, '@testuser');
    const { rows } = await ctx.pool.query(
      `SELECT code FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    const code = rows[0].code;

    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'testuser',
      text: `My code is ${code}. gladiator arena`,
    });
    await verifyHandle(ctx, cookie, 'https://twitter.com/testuser/status/111');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.x_handle).toBe('testuser');
    expect(body.x_handle_verified_at).not.toBeNull();
  });

  it('includes a career object with zero wins/losses for a fresh user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.career).toBeDefined();
    expect(body.career.wins).toBe(0);
    expect(body.career.losses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/gladiator/admin/verify-handle
// ---------------------------------------------------------------------------
describe('POST /api/gladiator/admin/verify-handle', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('403 without bearer token', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@b.com', handle: 'testuser' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('403 with wrong token', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrongtoken' },
      payload: { email: 'a@b.com', handle: 'testuser' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('403 when gladiatorAdminToken is not configured', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // gladiatorAdminToken is undefined by default in makeTestApp

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'a@b.com', handle: 'testuser' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 with correct token — verifies handle for existing user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    // Create the user first
    await login(ctx, 'a@b.com');

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'a@b.com', handle: '@AdminVerified' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // Check DB
    const { rows } = await ctx.pool.query(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = 'a@b.com'`,
    );
    expect(rows[0].x_handle).toBe('adminverified');
    expect(rows[0].x_handle_verified_at).not.toBeNull();
  });

  it('admin verify clears any pending verification code', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    const cookie = await login(ctx, 'a@b.com');
    // Start a pending verification
    await startHandle(ctx, cookie, '@testuser');

    // Admin overrides
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'a@b.com', handle: 'adminverified' },
    });
    expect(res.statusCode).toBe(200);

    // Pending code should be gone
    const { rows } = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'a@b.com'`,
    );
    expect(parseInt(rows[0].n, 10)).toBe(0);
  });

  it('400 on invalid handle', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'a@b.com', handle: 'x'.repeat(20) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('404 for non-existent user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'nonexistent@example.com', handle: 'validhandle' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('USER_NOT_FOUND');
  });

  it('404 USER_NOT_FOUND leaves the pending x_verification_codes row intact', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAdminToken = 'tok123';

    // Create a real user with a pending verification code.
    const cookie = await login(ctx, 'real@b.com');
    await startHandle(ctx, cookie, '@pendinghandle');

    // Confirm the code row exists before the admin call.
    const before = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'real@b.com'`,
    );
    expect(parseInt(before.rows[0].n, 10)).toBe(1);

    // Admin tries to verify a handle for a completely different email that has
    // no row in the users table — this must 404.
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/gladiator/admin/verify-handle',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer tok123' },
      payload: { email: 'nonexistent@example.com', handle: 'somehandle' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('USER_NOT_FOUND');

    // The pending code row for real@b.com must be untouched.
    const after = await ctx.pool.query(
      `SELECT count(*) as n FROM x_verification_codes WHERE account_email = 'real@b.com'`,
    );
    expect(parseInt(after.rows[0].n, 10)).toBe(1);
  });
});
