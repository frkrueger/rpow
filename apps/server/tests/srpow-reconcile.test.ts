import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FakeBridgeClient } from '@rpow/solana-bridge';
import { makeTestApp } from './helpers.js';
import { reconcilePendingWraps } from '../src/srpow-reconcile.js';

let cleanup: () => Promise<void> = async () => {};
afterEach(() => cleanup());

const ONE_RPOW = 1_000_000_000n;

async function seed(t: Awaited<ReturnType<typeof makeTestApp>>, opts: {
  signature: string | null; tokenIds: string[];
}) {
  await t.pool.query(`INSERT INTO users(email, solana_wallet) VALUES('alice@x.io','W')`);
  const eventId = randomUUID();
  // amount is now BIGINT base units; one locked token == 1 RPOW == 10^9 base units.
  const amountBaseUnits = (BigInt(opts.tokenIds.length) * ONE_RPOW).toString();
  await t.pool.query(
    `INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
     VALUES($1,'alice@x.io','W',$2,'WRAP','PENDING',$3,$4)`,
    [eventId, amountBaseUnits, `idem-${eventId}`, opts.signature],
  );
  for (const tid of opts.tokenIds) {
    await t.pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, server_sig, wrap_event_id)
       VALUES($1,'alice@x.io',$2,'LOCKED_FOR_BRIDGE','\\x00',$3)`,
      [tid, ONE_RPOW.toString(), eventId],
    );
  }
  return eventId;
}

describe('reconcilePendingWraps', () => {
  it('refunds PENDING events with no signature', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    const tid = randomUUID();
    const eventId = await seed(t, { signature: null, tokenIds: [tid] });

    const fake = new FakeBridgeClient();
    await reconcilePendingWraps(t.pool, fake);

    const ev = await t.pool.query('SELECT status, failure_reason FROM srpow_wrap_events WHERE id=$1', [eventId]);
    expect(ev.rows[0].status).toBe('REFUNDED');
    expect(ev.rows[0].failure_reason).toMatch(/no signature/);

    const tk = await t.pool.query('SELECT state, wrap_event_id FROM tokens WHERE id=$1', [tid]);
    expect(tk.rows[0].state).toBe('VALID');
    expect(tk.rows[0].wrap_event_id).toBeNull();
  });

  it('confirms PENDING events whose signature is on-chain', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    const tid = randomUUID();
    const eventId = await seed(t, { signature: 'sig_xyz', tokenIds: [tid] });

    const fake = new FakeBridgeClient();
    fake.setSignatureStatus('sig_xyz', 'confirmed');
    await reconcilePendingWraps(t.pool, fake);

    const ev = await t.pool.query('SELECT status FROM srpow_wrap_events WHERE id=$1', [eventId]);
    expect(ev.rows[0].status).toBe('CONFIRMED');

    const tk = await t.pool.query('SELECT state FROM tokens WHERE id=$1', [tid]);
    expect(tk.rows[0].state).toBe('WRAPPED');
  });

  it('refunds PENDING events whose signature is not_found / failed', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    const tid = randomUUID();
    const eventId = await seed(t, { signature: 'sig_nope', tokenIds: [tid] });

    const fake = new FakeBridgeClient();
    fake.setSignatureStatus('sig_nope', 'not_found');
    await reconcilePendingWraps(t.pool, fake);

    const ev = await t.pool.query('SELECT status, failure_reason FROM srpow_wrap_events WHERE id=$1', [eventId]);
    expect(ev.rows[0].status).toBe('REFUNDED');
    const tk = await t.pool.query('SELECT state FROM tokens WHERE id=$1', [tid]);
    expect(tk.rows[0].state).toBe('VALID');
  });

  it('leaves PENDING events whose signature is still pending', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    const tid = randomUUID();
    const eventId = await seed(t, { signature: 'sig_inflight', tokenIds: [tid] });

    const fake = new FakeBridgeClient();
    fake.setSignatureStatus('sig_inflight', 'pending');
    await reconcilePendingWraps(t.pool, fake);

    const ev = await t.pool.query('SELECT status FROM srpow_wrap_events WHERE id=$1', [eventId]);
    expect(ev.rows[0].status).toBe('PENDING');
    const tk = await t.pool.query('SELECT state FROM tokens WHERE id=$1', [tid]);
    expect(tk.rows[0].state).toBe('LOCKED_FOR_BRIDGE');
  });
});
