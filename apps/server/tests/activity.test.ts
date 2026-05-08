import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  return (await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` })).headers['set-cookie'] as string;
}
async function mineN(ctx: any, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
  }
}

describe('GET /activity', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('shows mint, send, receive entries', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 2);
    // Each mint credits MINT_BASE_REWARD_BASE_UNITS = 7,812,500 base units; send
    // one full token's worth so the exact-sum lock can pick a single token.
    await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: a, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount_base_units: '7812500', idempotency_key: randomUUID() } });

    const aAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    const bAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: b } })).json();
    expect(aAct.find((e: any) => e.type === 'mint')).toBeTruthy();
    expect(aAct.find((e: any) => e.type === 'send' && e.counterparty_email === 'b@x.com')).toBeTruthy();
    expect(bAct.find((e: any) => e.type === 'receive' && e.counterparty_email === 'a@x.com')).toBeTruthy();
  });
});
