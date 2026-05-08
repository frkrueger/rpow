import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { randomUUID } from 'node:crypto';

let cleanup: () => Promise<void> = async () => {};
afterEach(() => cleanup());

const ONE_RPOW = 1_000_000_000n; // 10^9 base units = 1 RPOW

async function seedUser(
  t: Awaited<ReturnType<typeof makeTestApp>>,
  email: string,
  wallet: string,
  validTokens: number,
  valueBaseUnits: bigint = ONE_RPOW,
) {
  await t.pool.query(`INSERT INTO users(email, solana_wallet) VALUES($1,$2)`, [email, wallet]);
  for (let i = 0; i < validTokens; i++) {
    await t.pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1,$2,$3,'VALID','\\x00')`,
      [randomUUID(), email, valueBaseUnits.toString()],
    );
  }
}

describe('POST /srpow/wrap — Phase 1', () => {
  it('returns 403 when email not in allowlist', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'someone-else@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 5);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k1234567' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('FORBIDDEN');
  });

  it('returns 400 NO_WALLET_BOUND when user has no solana_wallet', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await t.pool.query(`INSERT INTO users(email) VALUES('alice@x.io')`);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k1234567' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('NO_WALLET_BOUND');
  });

  it('returns 400 INSUFFICIENT_BALANCE when not enough VALID tokens', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 2);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: (5n * ONE_RPOW).toString(), idempotency_key: 'k1234567' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('returns 400 EXACT_SUM_REQUIRED when no token combo equals target', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    // Alice has two 1-RPOW tokens; she wants to wrap 0.5 RPOW.
    await seedUser(t, 'alice@x.io', 'WALLET1', 2);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: (ONE_RPOW / 2n).toString(), idempotency_key: 'k_exact_1' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('EXACT_SUM_REQUIRED');
  });

  it('replays a same-key + same-params request without double-locking', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 5);
    t.bridgeClient.queueResult({ signature: 'sig_1' });   // for first call's Phase 2
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const payload = { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k1234567' };

    const r1 = await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(r1.statusCode).toBe(200);
    const r2 = await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().event_id).toBe(r1.json().event_id);

    // exactly one locked + minted token after both calls
    const wrapped = await t.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE state='WRAPPED'`);
    expect(wrapped.rows[0].n).toBe(1);
  });

  it('rejects same-key + different-params with 409', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 5);
    t.bridgeClient.queueResult({ signature: 'sig_1' });
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k1234567' },
    });
    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: (2n * ONE_RPOW).toString(), idempotency_key: 'k1234567' },
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('POST /srpow/wrap — Phase 2 failures', () => {
  it('auto-refunds on mint failure', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 3);
    t.bridgeClient.queueResult({ error: 'rpc_unavailable' });
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: (2n * ONE_RPOW).toString(), idempotency_key: 'k_refund_1' },
    });

    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('REFUNDED');
    expect(r.json().failure_reason).toBe('rpc_unavailable');

    const states = await t.pool.query(`SELECT state, count(*)::int AS n FROM tokens WHERE owner_email='alice@x.io' GROUP BY state`);
    const m = Object.fromEntries(states.rows.map(r => [r.state, r.n]));
    expect(m.VALID).toBe(3);                                    // all back to VALID
    expect(m.LOCKED_FOR_BRIDGE ?? 0).toBe(0);
    expect(m.WRAPPED ?? 0).toBe(0);

    const ev = await t.pool.query(`SELECT status, failure_reason FROM srpow_wrap_events`);
    expect(ev.rows[0].status).toBe('REFUNDED');
    expect(ev.rows[0].failure_reason).toBe('rpc_unavailable');
  });
});

describe('POST /srpow/wrap — pre-submit signature persistence', () => {
  it('persists solana_signature before confirming (crash-recovery durability)', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 1, ONE_RPOW);
    t.bridgeClient.queueResult({ signature: 'sig_pre_confirm' });
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_persist_sig' },
    });
    expect(r.statusCode).toBe(200);

    const ev = await t.pool.query<{ solana_signature: string | null; status: string }>(
      `SELECT solana_signature, status FROM srpow_wrap_events WHERE idempotency_key='k_persist_sig'`,
    );
    expect(ev.rows[0].solana_signature).toBe('sig_pre_confirm');
    expect(ev.rows[0].status).toBe('CONFIRMED');
  });

  it('preserves solana_signature on the refund path (failure with sig set by callback)', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 1, ONE_RPOW);
    // Failure path: FakeBridgeClient now also calls onSignaturePrepared before
    // returning the failure, so the row should have the sig persisted even
    // though the wrap is REFUNDED.
    t.bridgeClient.queueResult({ signature: 'sig_failed_but_recorded', error: 'rpc_blip' });
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_refund_keeps_sig' },
    });
    expect(r.statusCode).toBe(503);

    const ev = await t.pool.query<{ solana_signature: string | null; status: string }>(
      `SELECT solana_signature, status FROM srpow_wrap_events WHERE idempotency_key='k_refund_keeps_sig'`,
    );
    expect(ev.rows[0].status).toBe('REFUNDED');
    expect(ev.rows[0].solana_signature).toBe('sig_failed_but_recorded');
  });
});

describe('POST /srpow/wrap — replay of failed wrap', () => {
  it('idempotency replay of a refunded wrap returns 503 BRIDGE_FAILED', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 1, ONE_RPOW);
    t.bridgeClient.queueResult({ error: 'oops' });
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const payload = { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_replay_refund' };

    const r1 = await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(r1.statusCode).toBe(503);

    // Replay with same params — server should return 503 again, not crash.
    const r2 = await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(r2.statusCode).toBe(503);
    expect(r2.json().status).toBe('REFUNDED');
  });
});

describe('GET /srpow/events', () => {
  it('lists current user events newest first', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 5);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    t.bridgeClient.queueResult({ signature: 'sig_a' });
    t.bridgeClient.queueResult({ error: 'oops' });

    await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_aaaaaa' } });
    await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_bbbbbb' } });

    const r = await t.app.inject({ method: 'GET', url: '/srpow/events', cookies: { [SESSION_COOKIE]: session } });
    expect(r.statusCode).toBe(200);
    const list = r.json() as Array<{status: string; amount_base_units: string}>;
    expect(list.length).toBe(2);
    // newest first
    expect(list[0].status).toBe('REFUNDED');
    expect(list[1].status).toBe('CONFIRMED');
    expect(list[0].amount_base_units).toBe(ONE_RPOW.toString());
    expect(list[1].amount_base_units).toBe(ONE_RPOW.toString());
  });

  it('does not leak other users events', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io,bob@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLETA', 1);
    await seedUser(t, 'bob@x.io', 'WALLETB', 1);
    t.bridgeClient.queueResult({ signature: 'sig_a' });
    const aliceSession = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    await t.app.inject({ method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: aliceSession },
      payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: 'k_aaaaaa' } });

    const bobSession = signSession({ email: 'bob@x.io' }, 'x'.repeat(32), 60);
    const r = await t.app.inject({ method: 'GET', url: '/srpow/events', cookies: { [SESSION_COOKIE]: bobSession } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });
});
