import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

async function loginAndChallenge(ctx: Awaited<ReturnType<typeof makeTestApp>>) {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'a@b.com' }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  const cookie = r.headers['set-cookie'] as string;
  const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
  return { cookie, ch };
}

describe('POST /mint', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits a token on a valid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token.value).toBe(1);
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.balance).toBe(1);
    expect(me.minted).toBe(1);
  });

  it('rejects invalid solution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SOLUTION');
  });

  it('rejects double-claim of same challenge', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { cookie, ch } = await loginAndChallenge(ctx);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const first = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie, 'content-type': 'application/json' }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('CHALLENGE_ALREADY_CLAIMED');
  });
});
