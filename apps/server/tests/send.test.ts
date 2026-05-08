import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { randomUUID } from 'node:crypto';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}

// Seed a token directly with an explicit base-unit value (avoids depending on
// the schedule/mint cadence and keeps test denominations deterministic).
async function seedToken(
  ctx: Awaited<ReturnType<typeof makeTestApp>>,
  ownerEmail: string,
  valueBaseUnits: bigint,
): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
     VALUES($1, $2, $3, 'VALID', now(), $4)`,
    [id, ownerEmail, valueBaseUnits.toString(), Buffer.from('00'.repeat(64), 'hex')],
  );
  return id;
}

const ONE_RPOW = 1_000_000_000n;
const ONE_OVER_128 = 7_812_500n;

describe('POST /send', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('transfers tokens between two registered users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const bCookie = await loginAs(ctx, 'b@x.com');
    // Seed Alice with three 1-RPOW tokens.
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_RPOW);

    // Send 2 RPOW (= 2 * 10^9 base units).
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: (2n * ONE_RPOW).toString(), idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      transferred_base_units: (2n * ONE_RPOW).toString(),
      recipient_email: 'b@x.com',
    });

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(aMe.balance_base_units).toBe(ONE_RPOW.toString());
    expect(bMe.balance_base_units).toBe((2n * ONE_RPOW).toString());
  });

  it('creates a pending transfer when recipient has no account', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await seedToken(ctx, 'a@x.com', ONE_RPOW);

    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'nobody@nowhere.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(body.transferred_base_units).toBe(ONE_RPOW.toString());
    expect(body.recipient_email).toBe('nobody@nowhere.com');
    // Sender's tokens are invalidated immediately; balance drops to 0.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance_base_units).toBe('0');
  });

  it('fails on insufficient balance', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects same idempotency_key with different parameters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await loginAs(ctx, 'c@x.com');
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    const key = randomUUID();
    const first = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: key },
    });
    expect(first.statusCode).toBe(200);
    const conflict = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'c@x.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: key },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('idempotency: same key returns same result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    const key = randomUUID();
    const a = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: key },
    });
    const b = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: ONE_RPOW.toString(), idempotency_key: key },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().transfer_id).toBe(b.json().transfer_id);
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance_base_units).toBe(ONE_RPOW.toString()); // only one token transferred, not two
  });

  it('rejects with EXACT_SUM_REQUIRED when no token combination matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    // Seed Alice with two 1-RPOW tokens. Try to send 0.5 RPOW; no single
    // token nor combination equals exactly 500_000_000.
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: '500000000', idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('EXACT_SUM_REQUIRED');
    // Sender's balance must be untouched.
    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    expect(aMe.balance_base_units).toBe((2n * ONE_RPOW).toString());
  });

  it('succeeds when an exact combination exists across multiple denominations', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await loginAs(ctx, 'a@x.com');
    const bCookie = await loginAs(ctx, 'b@x.com');
    // Seed Alice with one 1-RPOW token and one 1/128-RPOW token.
    await seedToken(ctx, 'a@x.com', ONE_RPOW);
    await seedToken(ctx, 'a@x.com', ONE_OVER_128);
    // Send 1 + 1/128 = 1_007_812_500 base units.
    const target = ONE_RPOW + ONE_OVER_128;
    const res = await ctx.app.inject({
      method: 'POST', url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: target.toString(), idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transferred_base_units).toBe(target.toString());

    const aMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
    const bMe = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: bCookie } })).json();
    expect(aMe.balance_base_units).toBe('0');
    expect(bMe.balance_base_units).toBe(target.toString());
  });
});
