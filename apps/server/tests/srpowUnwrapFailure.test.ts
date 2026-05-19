import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

const SIG_A = 'a'.repeat(88);
const SIG_B = 'b'.repeat(88);
const SIG_C = 'c'.repeat(88);
const IDEM_1 = 'idem-fail-0001';
const IDEM_2 = 'idem-fail-0002';
const IDEM_3 = 'idem-fail-0003';

async function unwrap(ctx: any, payload: any) {
  const cookie = `${SESSION_COOKIE}=` + signSession({ email: 'user@x', issued_at: Math.floor(Date.now()/1000) },
    ctx.config.sessionSecret, SESSION_TTL_SECONDS);
  return ctx.app.inject({
    method: 'POST', url: '/srpow/unwrap',
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
}

describe('POST /srpow/unwrap failure paths', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('refunds when Jupiter swap returns slippage_exceeded', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'slippage_exceeded', quoted_slippage_bps: 1500 });
    // Refund: transferSrpowFromBridge → uses mintTo's queue under the hood.
    ctx.bridgeClient.queueResult({ signature: 'REFUND_SIG' });

    const res = await unwrap(ctx, {
      signature: SIG_A, amount_base_units: '100000000000', idempotency_key: IDEM_1,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'BRIDGE_FAILED', status: 'REFUNDED' });

    expect(ctx.bridgeClient.transferFromBridgeCalls[0]).toEqual({
      recipientWallet: 'USER_PK', amountBaseUnits: 100000000000n,
    });
    const { rows: ev } = await ctx.pool.query(`SELECT status, failure_reason FROM srpow_wrap_events`);
    expect(ev[0].status).toBe('REFUNDED');
    expect(ev[0].failure_reason).toMatch(/slippage/i);

    const { rows: tokens } = await ctx.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email='user@x'`);
    expect(tokens[0].n).toBe(0);
  });

  it('returns 400 + marks FAILED when inbound sig was failed on-chain', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'failed', reason: 'InstructionError' });

    const res = await unwrap(ctx, {
      signature: SIG_B, amount_base_units: '100000000000', idempotency_key: IDEM_1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TRANSFER_NOT_LANDED');
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('FAILED');
  });

  it('returns 403 WRONG_SENDER on mismatch=wrong_from', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'mismatch', reason: 'wrong_from' });
    const res = await unwrap(ctx, {
      signature: SIG_C, amount_base_units: '100000000000', idempotency_key: IDEM_1,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('WRONG_SENDER');
  });

  it('refunded events do not consume daily quota', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);

    // First call: refunded.
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'slippage_exceeded', quoted_slippage_bps: 9999 });
    ctx.bridgeClient.queueResult({ signature: 'REFUND_SIG_1' });
    await unwrap(ctx, { signature: SIG_A, amount_base_units: '100000000000', idempotency_key: IDEM_1 });

    // Second call same day: should succeed (not quota-limited).
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'confirmed', signature: 'SWAP_2', sol_received_lamports: 100n });
    ctx.bridgeClient.queueBurnResult({ status: 'confirmed', signature: 'BURN_2' });
    const res = await unwrap(ctx, { signature: SIG_B, amount_base_units: '100000000000', idempotency_key: IDEM_2 });
    expect(res.statusCode).toBe(200);
  });
});
