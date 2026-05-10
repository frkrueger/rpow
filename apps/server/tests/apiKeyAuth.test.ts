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
