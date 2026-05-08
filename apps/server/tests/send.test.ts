import { describe, it, expect, afterEach } from 'vitest';
import { latestTokenFromEmail, loginAs, makeTestApp, mineN } from './helpers.js';
import { randomUUID } from 'node:crypto';

describe('POST /send', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('transfers tokens between two registered users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const bCookie = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 3);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 2, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, transferred: 2, recipient_email: 'b@x.com' });

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(aMe.balance).toBe(1);
    expect(bMe.balance).toBe(2);
  });

  it('creates a pending transfer when recipient has no account', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 1);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'nobody@nowhere.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(body.transferred).toBe(1);
    expect(body.recipient_email).toBe('nobody@nowhere.com');
    // Sender's tokens are invalidated immediately; balance drops to 0.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(0);
  });

  it('fails on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects same idempotency_key with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await loginAs(ctx, 'c@x.com');
    await mineN(ctx, aCookie, 2);
    const key = randomUUID();
    const first = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    expect(first.statusCode).toBe(200);
    const conflict = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'c@x.com', amount: 1, idempotency_key: key } });
    expect(conflict.statusCode).toBe(409);
  });

  it('idempotency: same key returns same result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 2);
    const key = randomUUID();
    const a = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    const b = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().transfer_id).toBe(b.json().transfer_id);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(1); // only one token transferred, not two
  });

  it('returns conflict for concurrent same-sender idempotency reuse with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await loginAs(ctx, 'c@x.com');
    await mineN(ctx, aCookie, 2);
    await ctx.pool.query(`
      CREATE OR REPLACE FUNCTION slow_transfer_insert_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER slow_transfer_insert_for_test
      BEFORE INSERT ON transfers
      FOR EACH ROW EXECUTE FUNCTION slow_transfer_insert_for_test();
    `);
    const key = randomUUID();

    const [first, second] = await Promise.all([
      ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } }),
      ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'c@x.com', amount: 1, idempotency_key: key } }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json()).toMatchObject({
      error: 'BAD_REQUEST',
      message: 'idempotency_key reused with different parameters',
    });
  });

  it('scopes completed-transfer idempotency keys by sender', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const cCookie = await loginAs(ctx, 'c@x.com');
    await loginAs(ctx, 'b@x.com');
    await loginAs(ctx, 'd@x.com');
    await mineN(ctx, aCookie, 1);
    await mineN(ctx, cCookie, 1);
    const key = randomUUID();

    const first = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount: 1, idempotency_key: key } });
    const second = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: cCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'd@x.com', amount: 1, idempotency_key: key } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().transfer_id).not.toBe(second.json().transfer_id);
  });

  it('scopes pending-transfer idempotency keys by sender', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const cCookie = await loginAs(ctx, 'c@x.com');
    await mineN(ctx, aCookie, 1);
    await mineN(ctx, cCookie, 1);
    const key = randomUUID();

    const first = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'pending-a@x.com', amount: 1, idempotency_key: key } });
    const second = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: cCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'pending-c@x.com', amount: 1, idempotency_key: key } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ pending: true, recipient_email: 'pending-a@x.com' });
    expect(second.json()).toMatchObject({ pending: true, recipient_email: 'pending-c@x.com' });
    expect(first.json().transfer_id).not.toBe(second.json().transfer_id);
  });

  it('lists pending transfers with pending and expired status', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 2);

    const pending = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'pending@x.com', amount: 1, idempotency_key: randomUUID() } });
    const expired = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'expired@x.com', amount: 1, idempotency_key: randomUUID() } });
    await ctx.pool.query('UPDATE pending_transfers SET expires_at = now() - interval \'1 minute\' WHERE id=$1', [expired.json().transfer_id]);

    const list = await ctx.app.inject({ method: 'GET', url: '/send/pending', headers: { cookie: aCookie } });

    expect(list.statusCode).toBe(200);
    expect(list.json().pending_transfers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.json().transfer_id, recipient_email: 'pending@x.com', amount: 1, status: 'pending' }),
      expect.objectContaining({ id: expired.json().transfer_id, recipient_email: 'expired@x.com', amount: 1, status: 'expired' }),
    ]));

    const webList = await ctx.app.inject({ method: 'GET', url: '/pending-transfers', headers: { cookie: aCookie } });
    expect(webList.statusCode).toBe(200);
    expect(webList.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.json().transfer_id, recipient_email: 'pending@x.com', amount: 1, status: 'pending' }),
      expect.objectContaining({ id: expired.json().transfer_id, recipient_email: 'expired@x.com', amount: 1, status: 'expired' }),
    ]));
  });

  it('resends a pending claim email with a new usable claim token', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 1);
    const send = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'pending@x.com', amount: 1, idempotency_key: randomUUID() } });
    const oldToken = latestTokenFromEmail(ctx);

    const resend = await ctx.app.inject({ method: 'POST', url: `/send/pending/${send.json().transfer_id}/resend`, headers: { cookie: aCookie } });
    const newToken = latestTokenFromEmail(ctx);

    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({ ok: true, id: send.json().transfer_id, recipient_email: 'pending@x.com', status: 'pending' });
    expect(newToken).not.toBe(oldToken);
    expect((await ctx.app.inject({ method: 'GET', url: `/claim?token=${oldToken}` })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/claim?token=${newToken}` })).statusCode).toBe(302);
  });

  it('supports web pending-transfer resend and cancel aliases', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 2);
    const first = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'first@x.com', amount: 1, idempotency_key: randomUUID() } });
    const second = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'second@x.com', amount: 1, idempotency_key: randomUUID() } });

    const resend = await ctx.app.inject({ method: 'POST', url: `/pending-transfers/${first.json().transfer_id}/resend`, headers: { cookie: aCookie } });
    const cancel = await ctx.app.inject({ method: 'POST', url: `/pending-transfers/${second.json().transfer_id}/cancel`, headers: { cookie: aCookie } });

    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({ ok: true, id: first.json().transfer_id, status: 'pending' });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ ok: true, id: second.json().transfer_id, status: 'canceled', reclaimed: 1 });
  });

  it('cancels and reclaims an unclaimed pending transfer', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await mineN(ctx, aCookie, 2);
    const send = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: aCookie, 'content-type': 'application/json' }, payload: { recipient_email: 'pending@x.com', amount: 2, idempotency_key: randomUUID() } });

    const cancel = await ctx.app.inject({ method: 'POST', url: `/send/pending/${send.json().transfer_id}/cancel`, headers: { cookie: aCookie } });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ ok: true, id: send.json().transfer_id, amount: 2, status: 'canceled', reclaimed: 2 });
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(2);
    const list = await ctx.app.inject({ method: 'GET', url: '/send/pending', headers: { cookie: aCookie } });
    expect(list.json().pending_transfers).toContainEqual(expect.objectContaining({ id: send.json().transfer_id, status: 'canceled' }));
  });
});
