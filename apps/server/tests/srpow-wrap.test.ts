import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { randomUUID } from 'node:crypto';

let cleanup: () => Promise<void> = async () => {};
afterEach(() => cleanup());

async function seedUser(t: Awaited<ReturnType<typeof makeTestApp>>, email: string, wallet: string, validTokens: number) {
  await t.pool.query(`INSERT INTO users(email, solana_wallet) VALUES($1,$2)`, [email, wallet]);
  for (let i = 0; i < validTokens; i++) {
    await t.pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1,$2,1,'VALID','\\x00')`,
      [randomUUID(), email],
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
      payload: { amount: 1, idempotency_key: 'k1234567' },
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
      payload: { amount: 1, idempotency_key: 'k1234567' },
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
      payload: { amount: 5, idempotency_key: 'k1234567' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('replays a same-key + same-params request without double-locking', async () => {
    const t = await makeTestApp({ wrapAllowlistCsv: 'alice@x.io' });
    cleanup = t.cleanup;
    await seedUser(t, 'alice@x.io', 'WALLET1', 5);
    t.bridgeClient.queueResult({ signature: 'sig_1' });   // for first call's Phase 2
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const payload = { amount: 1, idempotency_key: 'k1234567' };

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
      payload: { amount: 1, idempotency_key: 'k1234567' },
    });
    const r = await t.app.inject({
      method: 'POST', url: '/srpow/wrap', cookies: { [SESSION_COOKIE]: session },
      payload: { amount: 2, idempotency_key: 'k1234567' },
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
      payload: { amount: 2, idempotency_key: 'k_refund_1' },
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
