import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';
import { randomUUID } from 'node:crypto';

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  return ctx.forgeSessionCookie(email);
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

  it('does not re-fire the most recent event when polling with its own at as cursor', async () => {
    // Postgres stores microsecond precision but Date.toISOString() emits only
    // millisecond precision. Without ms truncation in the SQL filter, the most
    // recent row reappears on every poll using its returned at as the cursor.
    // This caused phantom duplicate transfers in halstavern's bet watcher.
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a-cursor@x.com');
    const b = await loginAs(ctx, 'b-cursor@x.com');
    await mineN(ctx, a, 1);
    await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: a, 'content-type': 'application/json' }, payload: { recipient_email: 'b-cursor@x.com', amount_base_units: '1000000', idempotency_key: randomUUID() } });

    const first = (await ctx.app.inject({ method: 'GET', url: '/activity?since=2020-01-01T00:00:00Z', headers: { cookie: b } })).json();
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.next_cursor).toBeTruthy();

    const second = (await ctx.app.inject({ method: 'GET', url: `/activity?since=${encodeURIComponent(first.next_cursor)}`, headers: { cookie: b } })).json();
    expect(second.entries).toEqual([]);
  });

  it('shows mint, send, receive entries', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await loginAs(ctx, 'a@x.com');
    const b = await loginAs(ctx, 'b@x.com');
    await mineN(ctx, a, 2);
    // Each mint credits MINT_BASE_REWARD_BASE_UNITS = 1,000,000 base units; send
    // one full token's worth so the exact-sum lock can pick a single token.
    await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie: a, 'content-type': 'application/json' }, payload: { recipient_email: 'b@x.com', amount_base_units: '1000000', idempotency_key: randomUUID() } });

    const aAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: a } })).json();
    const bAct = (await ctx.app.inject({ method: 'GET', url: '/activity', headers: { cookie: b } })).json();
    expect(aAct.find((e: any) => e.type === 'mint')).toBeTruthy();
    expect(aAct.find((e: any) => e.type === 'send' && e.counterparty_email === 'b@x.com')).toBeTruthy();
    expect(bAct.find((e: any) => e.type === 'receive' && e.counterparty_email === 'a@x.com')).toBeTruthy();
  });
});
