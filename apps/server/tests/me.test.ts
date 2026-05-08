import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return res.headers['set-cookie'] as string;
}

describe('GET /me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns email + zero balances on first login', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: 'a@b.com',
      balance_base_units: '0',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      wrap_allowed: false,
      solana_wallet: null,
      srpow_supply_owned_base_units: '0',
    });
  });
});

describe('GET /me — SRPOW fields', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns wrap_allowed and solana_wallet correctly', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await t.pool.query(`INSERT INTO users(email, solana_wallet) VALUES('alice@x.io','WALLET_X')`);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: session } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      wrap_allowed: true, solana_wallet: 'WALLET_X', srpow_supply_owned_base_units: '0',
    });
  });

  it('returns wrap_allowed=false for non-allowlisted users', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'someone@x.io' });
    cleanup = t.cleanup;
    await t.pool.query(`INSERT INTO users(email) VALUES('alice@x.io')`);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const r = await t.app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: session } });
    expect(r.json()).toMatchObject({ wrap_allowed: false, solana_wallet: null });
  });
});
