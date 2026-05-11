import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { hashApiKey, readAuth } from '../src/routes/auth.js';

describe('hashApiKey', () => {
  it('returns a 32-byte buffer (sha256)', () => {
    const h = hashApiKey('rpow_sk_abc');
    expect(h).toBeInstanceOf(Buffer);
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = hashApiKey('rpow_sk_xyz');
    const b = hashApiKey('rpow_sk_xyz');
    expect(a.equals(b)).toBe(true);
  });

  it('differs across distinct inputs', () => {
    const a = hashApiKey('rpow_sk_a');
    const b = hashApiKey('rpow_sk_b');
    expect(a.equals(b)).toBe(false);
  });
});

async function loginAndGetCookie(ctx: any, email: string): Promise<string> {
  return ctx.forgeSessionCookie(email);
}

async function seedUserAndKey(pool: any, email: string): Promise<{ plaintext: string; hash: Buffer }> {
  await pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const plaintext = 'rpow_sk_' + randomBytes(32).toString('base64url');
  const hash = hashApiKey(plaintext);
  await pool.query(
    `INSERT INTO api_keys(email, token_hash, token_prefix) VALUES($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_prefix = EXCLUDED.token_prefix, created_at = now(), last_used_at = NULL`,
    [email, hash, plaintext.slice(0, 12)],
  );
  return { plaintext, hash };
}

describe('readAuth', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('resolves a valid Bearer rpow_sk_* token to its email with viaApiKey=true', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'op@example.com');
    const fakeReq: any = {
      headers: { authorization: `Bearer ${plaintext}` },
      cookies: {},
    };
    const result = await readAuth(fakeReq as any, ctx.app);
    expect(result).toEqual({ email: 'op@example.com', viaApiKey: true });
    expect(fakeReq.viaApiKey).toBe(true);
    expect(typeof fakeReq.apiKeyHash).toBe('string');
    expect(fakeReq.apiKeyHash).toHaveLength(64); // hex sha256
  });

  it('falls through to session when Bearer is present but unrecognized', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAndGetCookie(ctx, 'op@example.com');
    const sessionCookieValue = cookie.match(/rpow_session=([^;]+)/)![1];
    const fakeReq: any = {
      headers: { authorization: 'Bearer rpow_sk_doesnotexist' },
      cookies: { rpow_session: sessionCookieValue },
    };
    const result = await readAuth(fakeReq as any, ctx.app);
    expect(result).toEqual({ email: 'op@example.com', viaApiKey: false });
    expect(fakeReq.viaApiKey).toBe(false);
  });

  it('uses session when no Bearer is present', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAndGetCookie(ctx, 'session@example.com');
    const sessionCookieValue = cookie.match(/rpow_session=([^;]+)/)![1];
    const fakeReq: any = {
      headers: {},
      cookies: { rpow_session: sessionCookieValue },
    };
    const result = await readAuth(fakeReq as any, ctx.app);
    expect(result?.email).toBe('session@example.com');
    expect(result?.viaApiKey).toBe(false);
  });

  it('returns null when neither Bearer nor session is present', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const fakeReq: any = { headers: {}, cookies: {} };
    const result = await readAuth(fakeReq as any, ctx.app);
    expect(result).toBeNull();
  });

  it('updates last_used_at on successful key auth', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedUserAndKey(ctx.pool, 'lastused@example.com');
    const before = await ctx.pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_keys WHERE email=$1`, ['lastused@example.com'],
    );
    expect(before.rows[0].last_used_at).toBeNull();

    const { plaintext } = await seedUserAndKey(ctx.pool, 'lastused@example.com');
    const fakeReq: any = { headers: { authorization: `Bearer ${plaintext}` }, cookies: {} };
    await readAuth(fakeReq as any, ctx.app);

    // last_used_at update is fire-and-forget; give it a beat to land
    await new Promise(r => setTimeout(r, 100));
    const after = await ctx.pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_keys WHERE email=$1`, ['lastused@example.com'],
    );
    expect(after.rows[0].last_used_at).not.toBeNull();
  });
});

describe('GET /me with API key', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('200 when authed with a valid API key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'me-key@example.com');
    const res = await ctx.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('me-key@example.com');
  });

  it('401 with no auth at all', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('401 with a Bearer that does not match any key (and no session)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: 'Bearer rpow_sk_garbage' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /activity', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  async function seedTransfer(pool: any, sender: string, recipient: string, amount: string, at: Date) {
    await pool.query(`INSERT INTO users(email) VALUES($1), ($2) ON CONFLICT (email) DO NOTHING`, [sender, recipient]);
    await pool.query(
      `INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key, created_at)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), sender, recipient, amount, randomUUID(), at],
    );
  }

  it('200 + bare array when called with API key and no ?since= (existing shape preserved)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'op@example.com');
    await seedTransfer(ctx.pool, 'sender@example.com', 'op@example.com', '100', new Date('2026-05-10T12:00:00Z'));
    const res = await ctx.app.inject({
      method: 'GET', url: '/activity',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('returns wrapped object with entries ASC and next_cursor when ?since= is present', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'op@example.com');
    await seedTransfer(ctx.pool, 's@example.com', 'op@example.com', '10', new Date('2026-05-10T12:00:00Z'));
    await seedTransfer(ctx.pool, 's@example.com', 'op@example.com', '20', new Date('2026-05-10T13:00:00Z'));
    await seedTransfer(ctx.pool, 's@example.com', 'op@example.com', '30', new Date('2026-05-10T14:00:00Z'));

    const res = await ctx.app.inject({
      method: 'GET', url: '/activity?since=2026-05-10T12:30:00Z',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('entries');
    expect(body).toHaveProperty('next_cursor');
    // Two of the three transfers are after 12:30
    expect(body.entries).toHaveLength(2);
    // ASC order: 13:00 then 14:00
    expect(body.entries[0].amount_base_units).toBe('20');
    expect(body.entries[1].amount_base_units).toBe('30');
    // next_cursor should be the at of the last entry
    expect(body.next_cursor).toBe(body.entries[1].at);
  });

  it('next_cursor is null when ?since= returns no entries', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'op@example.com');
    const res = await ctx.app.inject({
      method: 'GET', url: '/activity?since=2030-01-01T00:00:00Z',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], next_cursor: null });
  });

  it('400 on malformed ?since= (not a parseable iso8601)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'op@example.com');
    const res = await ctx.app.inject({
      method: 'GET', url: '/activity?since=not-a-date',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /send with API key', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  async function seedToken(pool: any, email: string, value: bigint) {
    await pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, server_sig)
       VALUES($1, $2, $3, 'VALID', '\\x00')`,
      [randomUUID(), email, value.toString()],
    );
  }

  it('200 when sender authenticates with an API key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'sender@example.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING`, ['recipient@example.com']);
    await seedToken(ctx.pool, 'sender@example.com', 1_000_000_000n);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      payload: {
        recipient_email: 'recipient@example.com',
        amount_base_units: '1000000',
        idempotency_key: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('401 on /send with no auth', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { 'content-type': 'application/json' },
      payload: { recipient_email: 'a@b.com', amount_base_units: '1', idempotency_key: 'abcdefgh' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('rate limit on /send via API key', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  async function seedToken(pool: any, email: string, value: bigint) {
    await pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, server_sig)
       VALUES($1, $2, $3, 'VALID', '\\x00')`,
      [randomUUID(), email, value.toString()],
    );
  }

  it('429s after 10 burst sends in one second from the same key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'burst@example.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING`, ['recv@example.com']);
    // Seed plenty of balance: 20 tokens of 100 base units each
    for (let i = 0; i < 20; i++) await seedToken(ctx.pool, 'burst@example.com', 100n);

    const sends = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ctx.app.inject({
          method: 'POST', url: '/send',
          headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
          payload: { recipient_email: 'recv@example.com', amount_base_units: '1', idempotency_key: `burst-${i}` },
        }),
      ),
    );
    const successes = sends.filter(r => r.statusCode === 200).length;
    const limited = sends.filter(r => r.statusCode === 429).length;
    expect(successes).toBeLessThanOrEqual(10);
    expect(limited).toBeGreaterThanOrEqual(2);
    const limitedRes = sends.find(r => r.statusCode === 429)!;
    const body = limitedRes.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.message).toMatch(/burst limit/);
    expect(typeof body.retry_after).toBe('number');
  });

  it('does NOT rate-limit session-based /send', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAndGetCookie(ctx, 'sess@example.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING`, ['recv@example.com']);
    for (let i = 0; i < 20; i++) await seedToken(ctx.pool, 'sess@example.com', 100n);

    const sends = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ctx.app.inject({
          method: 'POST', url: '/send',
          headers: { cookie, 'content-type': 'application/json' },
          payload: { recipient_email: 'recv@example.com', amount_base_units: '1', idempotency_key: `sess-${i}` },
        }),
      ),
    );
    const limited = sends.filter(r => r.statusCode === 429).length;
    expect(limited).toBe(0);
  });

  it('429s on /send when sender already has 1000+ transfers in the last hour', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'cap@example.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1), ($2) ON CONFLICT (email) DO NOTHING`, ['cap@example.com', 'recv@example.com']);
    await seedToken(ctx.pool, 'cap@example.com', 100_000n);

    // Pre-seed 1000 transfers in the last hour (bulk insert)
    const values: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (let i = 0; i < 1000; i++) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, now())`);
      params.push(randomUUID(), 'cap@example.com', 'recv@example.com', '1', `seed-${i}`);
    }
    await ctx.pool.query(
      `INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key, created_at) VALUES ${values.join(',')}`,
      params,
    );

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      payload: { recipient_email: 'recv@example.com', amount_base_units: '1', idempotency_key: 'over-cap' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('RATE_LIMITED');
  });
});

describe('API keys do NOT work outside the allowlist', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 on /api/longshot/spin even with a valid API key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'spin@example.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/longshot/spin',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      payload: { stake_base_units: '100', odds_choice: '1:1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on /api/longshot/access with API key only', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { plaintext } = await seedUserAndKey(ctx.pool, 'spin@example.com');
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/longshot/access',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
