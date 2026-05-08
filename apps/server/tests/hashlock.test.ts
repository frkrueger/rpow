import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID, createHash, randomBytes } from 'node:crypto';

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

function makePreimage(): { preimage: Buffer; preimageHex: string; hashHex: string } {
  const preimage = randomBytes(32);
  const hash = createHash('sha256').update(preimage).digest();
  return { preimage, preimageHex: preimage.toString('hex'), hashHex: hash.toString('hex') };
}

describe('hashlock', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('locks tokens and recipient claims with preimage', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    const bCookie = await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 5);

    const { preimageHex, hashHex } = makePreimage();

    // Create hashlock.
    const lockRes = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 3, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: randomUUID() },
    });
    expect(lockRes.statusCode).toBe(200);
    const lock = lockRes.json();
    expect(lock.state).toBe('PENDING');
    expect(lock.amount).toBe(3);

    // Alice's balance should be reduced.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(2);

    // Public check.
    const checkRes = await ctx.app.inject({ method: 'GET', url: `/hashlock/${lock.hashlock_id}` });
    expect(checkRes.json().state).toBe('PENDING');
    expect(checkRes.json().hash_h_hex).toBe(hashHex);

    // Bob claims.
    const claimRes = await ctx.app.inject({
      method: 'POST', url: `/hashlock/${lock.hashlock_id}/claim`,
      headers: { cookie: bCookie, 'content-type': 'application/json' },
      payload: { preimage_hex: preimageHex },
    });
    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json().state).toBe('CLAIMED');

    // Bob has 3 tokens.
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(bMe.balance).toBe(3);

    // Preimage visible on public check.
    const afterCheck = await ctx.app.inject({ method: 'GET', url: `/hashlock/${lock.hashlock_id}` });
    expect(afterCheck.json().preimage_hex).toBe(preimageHex);
  });

  it('rejects claim with wrong preimage', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    const bCookie = await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 2);

    const { hashHex } = makePreimage();
    const wrongPreimage = randomBytes(32).toString('hex');

    const lockRes = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 1, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: randomUUID() },
    });
    const lock = lockRes.json();

    const claimRes = await ctx.app.inject({
      method: 'POST', url: `/hashlock/${lock.hashlock_id}/claim`,
      headers: { cookie: bCookie, 'content-type': 'application/json' },
      payload: { preimage_hex: wrongPreimage },
    });
    expect(claimRes.statusCode).toBe(400);
    expect(claimRes.json().message).toContain('preimage');
  });

  it('sender cannot claim own hashlock', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 2);

    const { preimageHex, hashHex } = makePreimage();

    const lockRes = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 1, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: randomUUID() },
    });
    const lock = lockRes.json();

    const claimRes = await ctx.app.inject({
      method: 'POST', url: `/hashlock/${lock.hashlock_id}/claim`,
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { preimage_hex: preimageHex },
    });
    expect(claimRes.statusCode).toBe(403);
  });

  it('sender refunds after expiry', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 3);

    const { hashHex } = makePreimage();

    const lockRes = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 2, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: randomUUID() },
    });
    const lock = lockRes.json();

    // Fast-forward expiry in DB.
    await ctx.pool.query(
      `UPDATE hashlocked_transfers SET expires_at = now() - interval '1 second' WHERE id=$1`,
      [lock.hashlock_id],
    );

    const refundRes = await ctx.app.inject({
      method: 'POST', url: `/hashlock/${lock.hashlock_id}/refund`,
      headers: { cookie: aCookie, 'content-type': 'application/json' },
    });
    expect(refundRes.statusCode).toBe(200);
    expect(refundRes.json().state).toBe('REFUNDED');

    // Alice has all tokens back.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(3);
  });

  it('cannot refund before expiry', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 1);

    const { hashHex } = makePreimage();

    const lockRes = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 1, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: randomUUID() },
    });
    const lock = lockRes.json();

    const refundRes = await ctx.app.inject({
      method: 'POST', url: `/hashlock/${lock.hashlock_id}/refund`,
      headers: { cookie: aCookie, 'content-type': 'application/json' },
    });
    expect(refundRes.statusCode).toBe(400);
    expect(refundRes.json().message).toContain('not yet expired');
  });

  it('idempotency returns existing hashlock', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    await loginAs(ctx, 'bob@x.com');
    await mineN(ctx, aCookie, 3);

    const { hashHex } = makePreimage();
    const idem = randomUUID();

    const res1 = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 2, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: idem },
    });
    const res2 = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 2, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: idem },
    });

    expect(res1.json().hashlock_id).toBe(res2.json().hashlock_id);

    // Alice should only have 1 token (3 mined - 2 locked once, not twice).
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance).toBe(1);
  });

  it('rejects idempotency key reused with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'alice@x.com');
    await loginAs(ctx, 'bob@x.com');
    await loginAs(ctx, 'carol@x.com');
    await mineN(ctx, aCookie, 5);

    const { hashHex } = makePreimage();
    const idem = randomUUID();

    // First call succeeds.
    const res1 = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 2, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: idem },
    });
    expect(res1.statusCode).toBe(200);

    // Same key, different recipient — must reject.
    const res2 = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'carol@x.com', amount: 2, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: idem },
    });
    expect(res2.statusCode).toBe(409);

    // Same key, different amount — must reject.
    const res3 = await ctx.app.inject({
      method: 'POST', url: '/hashlock',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'bob@x.com', amount: 1, hash_h_hex: hashHex, timeout_seconds: 3600, idempotency_key: idem },
    });
    expect(res3.statusCode).toBe(409);
  });
});
