import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

async function authedRequest(ctx: any, body: any) {
  const cookie = `${SESSION_COOKIE}=` + signSession({
    email: 'user@x', issued_at: Math.floor(Date.now()/1000),
  }, ctx.config.sessionSecret, SESSION_TTL_SECONDS);
  return ctx.app.inject({
    method: 'POST', url: '/srpow/unwrap',
    headers: { cookie, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('POST /srpow/unwrap validation', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns 401 without session', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/srpow/unwrap', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when allowlist denies', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: 'other@x' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '100000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when amount below minimum', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '1', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_AMOUNT');
  });

  it('returns 400 when user has no bound wallet', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('user@x')`);  // no solana_wallet
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '10000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_WALLET_BOUND');
  });

  it('returns 202 PENDING when bridge says inbound sig still pending', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'pending' });
    const res = await authedRequest(ctx, {
      signature: 'SIG1', amount_base_units: '10000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING');
    const { rows } = await ctx.pool.query(`SELECT status, direction FROM srpow_wrap_events`);
    expect(rows[0]).toMatchObject({ status: 'PENDING', direction: 'UNWRAP' });
  });

  it('returns 409 INBOUND_SIG_REUSED when same sig posted with different idempotency_key', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'pending' });
    await authedRequest(ctx, { signature: 'SIGX', amount_base_units: '10000000000', idempotency_key: 'k1' });
    const res = await authedRequest(ctx, { signature: 'SIGX', amount_base_units: '10000000000', idempotency_key: 'k2' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INBOUND_SIG_REUSED');
  });
});
