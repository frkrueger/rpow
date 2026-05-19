import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

// Test fixtures must be long enough to satisfy the production zod schema.
const FAKE_INBOUND_SIG = '5'.repeat(88);
const IDEM_K = 'idem-key-happy-1';

describe('POST /srpow/unwrap happy path', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits 95% RPOW and updates counters atomically', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);

    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'confirmed', signature: 'SWAP_SIG', sol_received_lamports: 1234n });
    ctx.bridgeClient.queueBurnResult({ status: 'confirmed', signature: 'BURN_SIG' });

    const before = await ctx.pool.query<{ value: string }>(
      `SELECT coalesce(sum(value),0)::text AS value FROM app_counters WHERE name='wrapped_supply_base_units'`,
    );
    const cookie = `${SESSION_COOKIE}=` + signSession({ email: 'user@x', issued_at: Math.floor(Date.now()/1000) },
      ctx.config.sessionSecret, SESSION_TTL_SECONDS);

    const X = '100000000000'; // 100 RPOW
    const res = await ctx.app.inject({
      method: 'POST', url: '/srpow/unwrap',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { signature: FAKE_INBOUND_SIG, amount_base_units: X, idempotency_key: IDEM_K },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('CONFIRMED');
    expect(body.credit_base_units).toBe((BigInt(X) * 95n / 100n).toString());

    expect(ctx.bridgeClient.swapCalls[0].amountBaseUnits).toBe(BigInt(X) * 5n / 100n);
    expect(ctx.bridgeClient.burnCalls[0].amountBaseUnits).toBe(BigInt(X) * 95n / 100n);

    const { rows: ev } = await ctx.pool.query(`SELECT * FROM srpow_wrap_events`);
    expect(ev[0]).toMatchObject({
      status: 'CONFIRMED', direction: 'UNWRAP',
      solana_signature: FAKE_INBOUND_SIG, swap_signature: 'SWAP_SIG', burn_signature: 'BURN_SIG',
    });

    const { rows: tokens } = await ctx.pool.query(
      `SELECT value::text AS value, state, wrap_event_id, is_change FROM tokens WHERE owner_email='user@x'`,
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      value: (BigInt(X) * 95n / 100n).toString(),
      state: 'VALID',
      is_change: false,
    });

    const after = await ctx.pool.query<{ value: string }>(
      `SELECT coalesce(sum(value),0)::text AS value FROM app_counters WHERE name='wrapped_supply_base_units'`,
    );
    expect(BigInt(before.rows[0].value) - BigInt(after.rows[0].value)).toBe(BigInt(X) * 95n / 100n);
  });
});
