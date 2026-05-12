import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /amm/config', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns wallet pubkey, ata, USDC mint — public, no auth', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amm_wallet_pubkey: '4dqpFtkMJjtt94egCLVESYWxnZm9f7icLLMC3qTzzpdU',
      amm_wallet_ata: '9wVgJE1iKnBS8FiSnHc7jXv5Lz6uD819UYxwu7QAxxSp',
    });
    expect(res.headers['cache-control']).toMatch(/max-age=300/);
  });
});
